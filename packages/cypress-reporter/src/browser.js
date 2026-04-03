const DEFAULT_MAX_QUEUE = 1500;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MUTATION_DEBOUNCE_MS = 250;

function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeJson(value, depth = 0) {
  if (depth > 3) return '[max-depth]';
  if (value == null) return value;
  if (typeof value === 'string') return clip(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'object') {
    const output = {};
    for (const [key, raw] of Object.entries(value).slice(0, 40)) {
      output[key] = safeJson(raw, depth + 1);
    }
    return output;
  }
  return clip(value, 200);
}

function hashString(input) {
  let hash = 2166136261;
  const normalized = String(input || '');
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function cssPathForElement(element, maxDepth = 6) {
  if (!element || !element.tagName) return '';
  const segments = [];
  let current = element;
  let depth = 0;

  while (current && current.nodeType === 1 && depth < maxDepth) {
    let selector = current.tagName.toLowerCase();
    const id = current.getAttribute?.('id');
    if (id) {
      selector += `#${id}`;
      segments.unshift(selector);
      break;
    }

    const dataCy = current.getAttribute?.('data-cy');
    if (dataCy) selector += `[data-cy="${dataCy}"]`;

    const dataTestId = current.getAttribute?.('data-testid') || current.getAttribute?.('data-test-id');
    if (dataTestId) selector += `[data-testid="${dataTestId}"]`;

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((node) => node.tagName === current.tagName);
      if (siblings.length > 1) {
        const sameTagIndex = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${sameTagIndex})`;
      }
    }

    segments.unshift(selector);
    current = current.parentElement;
    depth += 1;
  }

  return segments.join(' > ');
}

function compactObject(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => compactObject(item)).filter(Boolean);

  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = compactObject(raw);
    const isEmptyObject = normalized && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0;
    if (normalized == null || normalized === '' || isEmptyObject) continue;
    output[key] = normalized;
  }
  return output;
}

function selectorBundleFromElement(element) {
  if (!element || !element.getAttribute) return null;

  const primary = {
    dataCy: element.getAttribute('data-cy') || null,
    dataTestId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || null,
    id: element.getAttribute('id') || null,
    name: element.getAttribute('name') || null,
    tag: element.tagName ? element.tagName.toLowerCase() : null
  };

  const accessibility = {
    role: element.getAttribute('role') || null,
    ariaLabel: element.getAttribute('aria-label') || null,
    text: clip(element.textContent || '', 120) || null
  };

  const structural = {
    cssPath: cssPathForElement(element),
    className: clip(element.className || '', 120) || null
  };

  const context = {
    framePath: 'top',
    shadowPath: null
  };

  return compactObject({
    primary,
    accessibility,
    structural,
    context
  });
}

function targetIdFromSelectorBundle(selectorBundle) {
  if (!selectorBundle) return '';
  const primary = selectorBundle.primary || {};
  if (primary.dataCy) return `cy:${primary.dataCy}`;
  if (primary.dataTestId) return `tid:${primary.dataTestId}`;
  if (primary.id) return `id:${primary.id}`;
  const seed = selectorBundle.structural?.cssPath || JSON.stringify(selectorBundle);
  return `dom:${hashString(seed)}`;
}

function parseCommandName(attrs, log) {
  const byAttrs = attrs?.name;
  if (byAttrs) return clip(byAttrs, 80);
  const byLog = typeof log?.get === 'function' ? log.get('name') : null;
  return clip(byLog || '', 80);
}

function parseCommandMessage(attrs, log) {
  if (typeof attrs?.message === 'string') return clip(attrs.message, 300);
  if (Array.isArray(attrs?.message)) return clip(attrs.message.join(' '), 300);
  const byLog = typeof log?.get === 'function' ? log.get('message') : null;
  if (typeof byLog === 'string') return clip(byLog, 300);
  if (Array.isArray(byLog)) return clip(byLog.join(' '), 300);
  return '';
}

function parseConsoleProps(log) {
  if (typeof log?.consoleProps !== 'function') return null;
  try {
    return safeJson(log.consoleProps());
  } catch {
    return null;
  }
}

function normalizeState(state) {
  const normalized = String(state || '').toLowerCase();
  if (normalized === 'passed' || normalized === 'pass') return 'passed';
  if (normalized === 'failed' || normalized === 'fail') return 'failed';
  if (normalized === 'pending' || normalized === 'skipped') return 'skipped';
  return normalized || 'unknown';
}

function pushQueue(queue, item, maxQueue) {
  if (!item) return;
  queue.push(item);
  if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
}

function chunkArray(values, size) {
  if (!values.length) return [];
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

export function installTestHarborReplayHooks(options = {}) {
  const CypressRef = globalThis?.Cypress;
  if (!CypressRef || typeof CypressRef.on !== 'function') return;

  const installedKey = 'TESTHARBOR_REPLAY_HOOKS_INSTALLED';
  if (CypressRef.env(installedKey)) return;
  CypressRef.env(installedKey, true);

  const maxQueue = Math.max(200, toInteger(options.maxQueue ?? CypressRef.env('TESTHARBOR_REPLAY_MAX_QUEUE'), DEFAULT_MAX_QUEUE));
  const batchSize = Math.max(25, toInteger(options.batchSize ?? CypressRef.env('TESTHARBOR_REPLAY_BATCH_SIZE'), DEFAULT_BATCH_SIZE));
  const mutationDebounceMs = Math.max(50, toInteger(options.mutationDebounceMs ?? CypressRef.env('TESTHARBOR_REPLAY_MUTATION_DEBOUNCE_MS'), DEFAULT_MUTATION_DEBOUNCE_MS));

  const replayQueue = [];
  const knownTargets = new Map();
  let commandCounter = 0;

  const queueReplay = (kind, payload) => {
    pushQueue(replayQueue, {
      kind,
      payload: safeJson(payload)
    }, maxQueue);
  };

  const ensureTargetForElement = (element, metadata = {}) => {
    const selectorBundle = selectorBundleFromElement(element);
    if (!selectorBundle) return null;

    const targetId = targetIdFromSelectorBundle(selectorBundle);
    if (!targetId) return null;

    const signature = JSON.stringify(selectorBundle);
    const existing = knownTargets.get(targetId);

    if (!existing) {
      queueReplay('target:declare', {
        targetId,
        selectors: selectorBundle,
        metadata: { source: metadata.source || 'browser-hook' }
      });
      queueReplay('target:bind', {
        targetId,
        selectors: selectorBundle,
        metadata: { reason: 'initial_bind', source: metadata.source || 'browser-hook' }
      });
      knownTargets.set(targetId, { signature });
    } else if (existing.signature !== signature) {
      queueReplay('target:rebind', {
        targetId,
        selectors: selectorBundle,
        metadata: { reason: 'selector_changed', source: metadata.source || 'browser-hook' }
      });
      knownTargets.set(targetId, { signature });
    }

    return { targetId, selectors: selectorBundle };
  };

  const enqueueLifecycle = (eventType, payload = {}, extra = {}) => {
    queueReplay('event', {
      kind: 'lifecycle',
      payload: {
        eventType,
        ...payload
      },
      ...extra
    });
  };

  const flushReplayQueue = () => {
    if (!replayQueue.length || !globalThis.cy || typeof globalThis.cy.task !== 'function') {
      return globalThis.cy && typeof globalThis.cy.wrap === 'function'
        ? globalThis.cy.wrap(null, { log: false })
        : undefined;
    }

    const batch = replayQueue.splice(0, replayQueue.length);
    const chunks = chunkArray(batch, batchSize);
    let chain = globalThis.cy.wrap(null, { log: false });
    for (const chunk of chunks) {
      chain = chain.then(() => globalThis.cy.task('testharbor:replay:batch', chunk, { log: false }));
    }
    return chain.then(() => globalThis.cy.task('testharbor:replay:flush', null, { log: false }));
  };

  CypressRef.on('url:changed', (url) => {
    queueReplay('dom', {
      eventType: 'NAVIGATION',
      url: clip(url, 500),
      source: 'url:changed'
    });
  });

  CypressRef.on('log:added', (attrs, log) => {
    const commandName = parseCommandName(attrs, log);
    if (!commandName) return;

    const commandMessage = parseCommandMessage(attrs, log);
    const commandId = attrs?.id || `cmd_${Date.now()}_${(commandCounter += 1)}`;
    const rowEl = log?.$el?.get?.(0) || attrs?.$el?.get?.(0) || null;
    const target = rowEl ? ensureTargetForElement(rowEl, { source: 'log:added', commandName }) : null;

    queueReplay('command', {
      commandId,
      targetId: target?.targetId || null,
      selectors: target?.selectors || null,
      payload: {
        eventType: 'COMMAND',
        name: commandName,
        message: commandMessage,
        consoleProps: parseConsoleProps(log),
        source: 'log:added'
      }
    });

    if (['click', 'type', 'select', 'check', 'uncheck', 'submit', 'trigger'].includes(commandName.toLowerCase())) {
      queueReplay('dom', {
        eventType: 'INTERACTION',
        commandId,
        commandName,
        targetId: target?.targetId || null,
        url: clip(globalThis.location?.href || '', 500)
      });
    }
  });

  CypressRef.on('window:before:load', (win) => {
    if (!win || win.__TESTHARBOR_REPLAY_PATCHED__) return;
    win.__TESTHARBOR_REPLAY_PATCHED__ = true;

    const consoleLevels = ['error', 'warn', 'info', 'log', 'debug'];
    for (const level of consoleLevels) {
      const original = win.console?.[level];
      if (typeof original !== 'function') continue;
      win.console[level] = function patchedConsole(...args) {
        queueReplay('console', {
          eventType: 'CONSOLE',
          level,
          message: clip(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(safeJson(arg)))).join(' '), 600),
          args: safeJson(args),
          url: clip(win.location?.href || '', 500)
        });
        return original.apply(this, args);
      };
    }

    if (typeof win.fetch === 'function') {
      const originalFetch = win.fetch.bind(win);
      win.fetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const requestUrl = clip(
          typeof input === 'string'
            ? input
            : input?.url || '',
          500
        );
        const requestMethod = clip((init.method || input?.method || 'GET').toUpperCase(), 16);
        const requestId = `fetch_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        const startedAt = Date.now();

        queueReplay('network', {
          eventType: 'REQUEST',
          protocol: 'fetch',
          requestId,
          method: requestMethod,
          url: requestUrl
        });

        try {
          const response = await originalFetch(...args);
          queueReplay('network', {
            eventType: 'RESPONSE',
            protocol: 'fetch',
            requestId,
            method: requestMethod,
            url: requestUrl,
            status: response?.status || null,
            durationMs: Date.now() - startedAt
          });
          return response;
        } catch (error) {
          queueReplay('network', {
            eventType: 'ERROR',
            protocol: 'fetch',
            requestId,
            method: requestMethod,
            url: requestUrl,
            durationMs: Date.now() - startedAt,
            error: clip(error?.message || error, 400)
          });
          throw error;
        }
      };
    }

    if (win.XMLHttpRequest?.prototype && !win.XMLHttpRequest.prototype.__TESTHARBOR_REPLAY_PATCHED__) {
      const proto = win.XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;

      proto.open = function patchedOpen(method, url, ...rest) {
        this.__thReplay = {
          method: clip((method || 'GET').toUpperCase(), 16),
          url: clip(url || '', 500),
          requestId: `xhr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          startedAt: 0
        };
        return originalOpen.call(this, method, url, ...rest);
      };

      proto.send = function patchedSend(...args) {
        const meta = this.__thReplay || {
          method: 'GET',
          url: '',
          requestId: `xhr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          startedAt: 0
        };
        meta.startedAt = Date.now();

        queueReplay('network', {
          eventType: 'REQUEST',
          protocol: 'xhr',
          requestId: meta.requestId,
          method: meta.method,
          url: meta.url
        });

        this.addEventListener('loadend', () => {
          const isError = this.status === 0;
          queueReplay('network', {
            eventType: isError ? 'ERROR' : 'RESPONSE',
            protocol: 'xhr',
            requestId: meta.requestId,
            method: meta.method,
            url: meta.url,
            status: this.status,
            durationMs: Date.now() - meta.startedAt
          });
        }, { once: true });

        return originalSend.apply(this, args);
      };

      proto.__TESTHARBOR_REPLAY_PATCHED__ = true;
    }

    if (win.MutationObserver && win.document?.documentElement) {
      let lastMutationEmitAt = 0;
      const observer = new win.MutationObserver((mutations) => {
        const now = Date.now();
        if (now - lastMutationEmitAt < mutationDebounceMs) return;
        lastMutationEmitAt = now;

        let addedNodes = 0;
        let removedNodes = 0;
        let attributeChanges = 0;

        for (const mutation of mutations) {
          addedNodes += mutation.addedNodes?.length || 0;
          removedNodes += mutation.removedNodes?.length || 0;
          if (mutation.type === 'attributes') attributeChanges += 1;
        }

        queueReplay('dom', {
          eventType: 'MUTATION',
          mutationCount: mutations.length,
          addedNodes,
          removedNodes,
          attributeChanges,
          url: clip(win.location?.href || '', 500)
        });
      });

      observer.observe(win.document.documentElement, {
        childList: true,
        attributes: true,
        subtree: true
      });

      win.addEventListener('beforeunload', () => {
        observer.disconnect();
      }, { once: true });
    }
  });

  if (typeof globalThis.beforeEach === 'function') {
    globalThis.beforeEach(function testHarborReplayBeforeEach() {
      const currentTest = this?.currentTest || null;
      enqueueLifecycle('TEST_BOUNDARY', {
        phase: 'beforeEach',
        title: clip(currentTest?.title || '', 180),
        fullTitle: clip(currentTest?.fullTitle?.() || '', 300)
      });
    });
  }

  if (typeof globalThis.afterEach === 'function') {
    globalThis.afterEach(function testHarborReplayAfterEach() {
      const currentTest = this?.currentTest || null;
      enqueueLifecycle('TEST_BOUNDARY', {
        phase: 'afterEach',
        title: clip(currentTest?.title || '', 180),
        fullTitle: clip(currentTest?.fullTitle?.() || '', 300),
        state: normalizeState(currentTest?.state),
        durationMs: Number.isFinite(currentTest?.duration) ? currentTest.duration : null
      });
      return flushReplayQueue();
    });
  }

  if (typeof globalThis.after === 'function') {
    globalThis.after(function testHarborReplayAfterAll() {
      if (!globalThis.cy || typeof globalThis.cy.task !== 'function') return undefined;
      return flushReplayQueue()?.then?.(() => globalThis.cy.task('testharbor:replay:fin', {
        status: 'completed',
        metadata: { source: 'browser-hook' }
      }, { log: false }));
    });
  }
}

export default installTestHarborReplayHooks;
