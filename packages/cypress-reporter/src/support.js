function toIso(value = new Date()) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function truncateText(value, maxChars = 2000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function serializeValue(value, maxChars = 2000) {
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateText(value.message, maxChars),
        stack: truncateText(value.stack, maxChars)
      };
    }
    if (typeof value === 'string') return truncateText(value, maxChars);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    return JSON.parse(truncateText(JSON.stringify(value), maxChars));
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function getSpecPath() {
  return Cypress?.spec?.relative || Cypress?.spec?.name || null;
}

export function installTestHarborReplayHooks(options = {}) {
  if (globalThis.__TESTHARBOR_REPLAY_HOOKS_INSTALLED__) return;
  globalThis.__TESTHARBOR_REPLAY_HOOKS_INSTALLED__ = true;

  const maxEvents = Number(options.maxEvents || Cypress.env('TESTHARBOR_REPLAY_MAX_EVENTS') || 500);
  const maxDomChars = Number(options.maxDomChars || Cypress.env('TESTHARBOR_REPLAY_MAX_DOM_CHARS') || 120000);
  const maxDetailChars = Number(options.maxDetailChars || Cypress.env('TESTHARBOR_REPLAY_MAX_DETAIL_CHARS') || 5000);

  const captureConsole = options.console !== false;
  const captureNetwork = options.network !== false;
  const captureDom = options.dom !== false;

  const queue = [];

  function enqueue(event = {}) {
    if (!event || typeof event !== 'object') return;
    if (queue.length >= maxEvents) queue.shift();

    queue.push({
      type: event.type || 'replay.event',
      ts: toIso(event.ts),
      title: event.title || null,
      detail: event.detail || null,
      command: event.command || null,
      payload: event.payload || null,
      console: Array.isArray(event.console) ? event.console : [],
      network: Array.isArray(event.network) ? event.network : [],
      domSnapshot: typeof event.domSnapshot === 'string' ? event.domSnapshot : null,
      specPath: event.specPath || getSpecPath()
    });
  }

  function flushQueuedEvents() {
    if (!queue.length) return cy.wrap(null, { log: false });
    const events = queue.splice(0, queue.length);
    const specPath = getSpecPath();
    return cy
      .task('testharbor:replay', { specPath, events }, { log: false })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[testharbor] replay flush failed', error?.message || error);
        return null;
      });
  }

  Cypress.on('command:end', (command) => {
    const attributes = command?.attributes || {};
    const name = command?.name || attributes.name || 'command';
    const message = attributes.message || null;
    enqueue({
      type: 'replay.command',
      title: name,
      detail: message ? truncateText(message, maxDetailChars) : `Command ${name}`,
      command: name,
      payload: {
        name,
        message: message ? truncateText(message, maxDetailChars) : null,
        state: attributes.state || command?.state || null,
        endedAt: toIso()
      }
    });
  });

  Cypress.on('log:added', (attrs) => {
    if (!attrs || attrs.instrument === 'command') return;
    const name = attrs.displayName || attrs.name;
    if (!name) return;
    const message = Array.isArray(attrs.message)
      ? attrs.message.map((part) => truncateText(part, maxDetailChars)).join(' ')
      : truncateText(attrs.message || '', maxDetailChars);

    enqueue({
      type: 'replay.log',
      title: String(name),
      detail: message || null,
      payload: {
        name,
        state: attrs.state || null,
        message,
        consoleProps: serializeValue(attrs.consoleProps || null, maxDetailChars)
      }
    });
  });

  Cypress.on('window:before:load', (win) => {
    if (!win || win.__testharborReplayPatched) return;
    win.__testharborReplayPatched = true;

    if (captureConsole && win.console) {
      ['log', 'info', 'warn', 'error'].forEach((level) => {
        const original = win.console[level];
        if (typeof original !== 'function') return;
        win.console[level] = function patchedConsole(...args) {
          enqueue({
            type: 'replay.console',
            title: `console.${level}`,
            detail: truncateText(args.map((arg) => serializeValue(arg, 500)).join(' '), maxDetailChars),
            console: [{ level, args: args.map((arg) => serializeValue(arg, 500)) }]
          });
          return original.apply(this, args);
        };
      });
    }

    if (captureNetwork && typeof win.fetch === 'function') {
      const originalFetch = win.fetch.bind(win);
      win.fetch = async (...args) => {
        const startedAt = Date.now();
        const requestInput = args[0];
        const requestInit = args[1] || {};
        const method = String(requestInit.method || requestInput?.method || 'GET').toUpperCase();
        const url = truncateText(typeof requestInput === 'string' ? requestInput : requestInput?.url || '', 1000);

        try {
          const response = await originalFetch(...args);
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `HTTP ${response.status}`,
            network: [{
              transport: 'fetch',
              method,
              url,
              status: response.status,
              ok: response.ok,
              durationMs: Date.now() - startedAt
            }]
          });
          return response;
        } catch (error) {
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `Network error: ${truncateText(error?.message || String(error), 500)}`,
            network: [{
              transport: 'fetch',
              method,
              url,
              error: truncateText(error?.message || String(error), 500),
              durationMs: Date.now() - startedAt
            }]
          });
          throw error;
        }
      };
    }

    if (captureNetwork && win.XMLHttpRequest?.prototype) {
      const xhrProto = win.XMLHttpRequest.prototype;
      const originalOpen = xhrProto.open;
      const originalSend = xhrProto.send;

      xhrProto.open = function patchedOpen(method, url, ...rest) {
        this.__thReplayMethod = method;
        this.__thReplayUrl = url;
        return originalOpen.call(this, method, url, ...rest);
      };

      xhrProto.send = function patchedSend(...args) {
        const startedAt = Date.now();
        const method = String(this.__thReplayMethod || 'GET').toUpperCase();
        const url = truncateText(this.__thReplayUrl || '', 1000);

        this.addEventListener('loadend', () => {
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `HTTP ${this.status || 0}`,
            network: [{
              transport: 'xhr',
              method,
              url,
              status: this.status || 0,
              durationMs: Date.now() - startedAt
            }]
          });
        });

        return originalSend.apply(this, args);
      };
    }
  });

  if (typeof afterEach === 'function') {
    afterEach(() => {
      if (!captureDom) return flushQueuedEvents();
      return cy.document({ log: false }).then((doc) => {
        const domSnapshot = truncateText(doc?.documentElement?.outerHTML || '', maxDomChars);
        enqueue({
          type: 'replay.dom.snapshot',
          title: 'DOM snapshot',
          detail: domSnapshot ? `Captured ${domSnapshot.length} chars` : 'DOM unavailable',
          domSnapshot: domSnapshot || null
        });
      }).then(() => flushQueuedEvents());
    });
  }

  if (typeof after === 'function') {
    after(() => flushQueuedEvents());
  }
}

export default installTestHarborReplayHooks;
