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


function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function simpleHash(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function getCurrentUrl() {
  try {
    const win = Cypress?.state?.('window');
    return win?.location?.href || null;
  } catch {
    return null;
  }
}

function getCurrentDomSnapshot(maxChars = 120000) {
  try {
    const doc = Cypress?.state?.('document');
    const html = doc?.documentElement?.outerHTML || '';
    return truncateText(html, maxChars);
  } catch {
    return '';
  }
}

function shouldCaptureDomForCommand(name = '', seq = 0, sampleEvery = 8) {
  const command = String(name || '').toLowerCase();
  const domCommands = new Set([
    'visit', 'click', 'dblclick', 'rightclick', 'type', 'clear', 'select', 'check', 'uncheck',
    'submit', 'reload', 'go', 'contains', 'get', 'find', 'within', 'trigger', 'focus', 'blur',
    'scrollto', 'scrollintoview', 'screenshot', 'wait'
  ]);
  return domCommands.has(command) || (seq % Math.max(1, sampleEvery) === 0);
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
  const domSampleEvery = toNumber(options.domSampleEvery || Cypress.env('TESTHARBOR_REPLAY_DOM_SAMPLE_EVERY') || 8, 8);
  const maxRunnerMessageChars = toNumber(options.maxRunnerMessageChars || Cypress.env('TESTHARBOR_REPLAY_MAX_RUNNER_CHARS') || 1200, 1200);
  let commandSeq = 0;
  let lastDomHash = null;

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
      .then(
        () => null,
        (error) => {
          // restore events for next flush attempt (bounded by maxEvents)
          queue.unshift(...events);
          if (queue.length > maxEvents) {
            queue.splice(0, queue.length - maxEvents);
          }
          // eslint-disable-next-line no-console
          console.warn('[testharbor] replay flush failed', error?.message || error);
          return null;
        }
      );
  }


  Cypress.on('command:end', (command) => {
    const attributes = command?.attributes || {};
    const name = command?.name || attributes.name || 'command';
    const message = attributes.message || null;
    commandSeq += 1;

    let consoleProps = null;
    try {
      if (typeof command?.consoleProps === 'function') {
        consoleProps = serializeValue(command.consoleProps(), maxRunnerMessageChars);
      } else if (attributes?.consoleProps) {
        consoleProps = serializeValue(attributes.consoleProps, maxRunnerMessageChars);
      }
    } catch {
      consoleProps = null;
    }

    let domSnapshot = null;
    if (captureDom && shouldCaptureDomForCommand(name, commandSeq, domSampleEvery)) {
      const candidate = getCurrentDomSnapshot(maxDomChars);
      if (candidate) {
        const hash = simpleHash(candidate);
        if (hash !== lastDomHash) {
          domSnapshot = candidate;
          lastDomHash = hash;
        }
      }
    }

    enqueue({
      type: 'replay.command',
      title: name,
      detail: message ? truncateText(message, maxDetailChars) : `Command ${name}`,
      command: name,
      domSnapshot,
      payload: {
        name,
        message: message ? truncateText(message, maxDetailChars) : null,
        state: attributes.state || command?.state || null,
        chainerId: attributes.chainerId || null,
        wallClockStartedAt: attributes.wallClockStartedAt || null,
        endedAt: toIso(),
        url: getCurrentUrl(),
        consoleProps
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

    if (captureConsole && typeof win.addEventListener === 'function') {
      win.addEventListener('error', (evt) => {
        const msg = evt?.message || evt?.error?.message || 'Unknown window error';
        enqueue({
          type: 'replay.js.error',
          title: 'window.error',
          detail: truncateText(msg, maxDetailChars),
          console: [{
            level: 'error',
            source: 'window.error',
            message: truncateText(msg, maxDetailChars),
            url: evt?.filename || null,
            line: evt?.lineno || null,
            column: evt?.colno || null
          }],
          payload: {
            url: getCurrentUrl(),
            filename: evt?.filename || null,
            line: evt?.lineno || null,
            column: evt?.colno || null
          }
        });
      });

      win.addEventListener('unhandledrejection', (evt) => {
        const reason = evt?.reason;
        const message = typeof reason === 'string'
          ? reason
          : (reason?.message || truncateText(JSON.stringify(reason || 'unknown'), maxDetailChars));
        enqueue({
          type: 'replay.js.unhandledrejection',
          title: 'unhandledrejection',
          detail: truncateText(message, maxDetailChars),
          console: [{ level: 'error', source: 'unhandledrejection', message: truncateText(message, maxDetailChars) }],
          payload: {
            url: getCurrentUrl(),
            reason: serializeValue(reason, maxDetailChars)
          }
        });
      });
    }
  });


  if (typeof beforeEach === 'function') {
    beforeEach(function () {
      const test = this?.currentTest;
      const titlePath = typeof test?.titlePath === 'function' ? test.titlePath() : [];
      enqueue({
        type: 'replay.test.started',
        title: test?.title || 'test',
        detail: titlePath.length ? titlePath.join(' > ') : 'Test started',
        payload: {
          testTitle: test?.title || null,
          fullTitle: typeof test?.fullTitle === 'function' ? test.fullTitle() : null,
          specPath: getSpecPath(),
          startedAt: toIso(),
          url: getCurrentUrl()
        }
      });
    });
  }

  if (typeof afterEach === 'function') {
    afterEach(function () {
      const test = this?.currentTest;
      const titlePath = typeof test?.titlePath === 'function' ? test.titlePath() : [];
      const finishEvent = {
        type: 'replay.test.finished',
        title: test?.title || 'test',
        detail: `Test ${(test?.state || 'unknown').toUpperCase()}`,
        payload: {
          testTitle: test?.title || null,
          fullTitle: typeof test?.fullTitle === 'function' ? test.fullTitle() : null,
          state: test?.state || null,
          duration: test?.duration ?? null,
          specPath: getSpecPath(),
          endedAt: toIso(),
          url: getCurrentUrl(),
          titlePath,
          err: serializeValue(test?.err || null, maxRunnerMessageChars)
        }
      };

      const captureAndFlush = () => {
        enqueue(finishEvent);
        return flushQueuedEvents();
      };

      if (!captureDom) return captureAndFlush();
      return cy.document({ log: false }).then((doc) => {
        const domSnapshot = truncateText(doc?.documentElement?.outerHTML || '', maxDomChars);
        if (domSnapshot) {
          const hash = simpleHash(domSnapshot);
          if (hash !== lastDomHash) {
            lastDomHash = hash;
            enqueue({
              type: 'replay.dom.snapshot',
              title: test?.title || 'DOM snapshot',
              detail: `Captured ${domSnapshot.length} chars`,
              domSnapshot,
              payload: {
                testTitle: test?.title || null,
                state: test?.state || null,
                url: getCurrentUrl(),
                capturedAt: toIso()
              }
            });
          }
        }
      }).then(() => captureAndFlush());
    });
  }

  if (typeof after === 'function') {
    after(() => flushQueuedEvents());
  }
}

export default installTestHarborReplayHooks;
