function toIso(value = new Date()) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function truncateText(value, maxChars = 2000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function compactSerializable(value, options = {}, seen = new WeakSet(), depth = 0) {
  const {
    maxDepth = 4,
    maxItems = 40,
    maxKeys = 40,
    maxString = 2000
  } = options;

  if (value == null) return value;
  if (typeof value === 'string') return truncateText(value, maxString);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return truncateText(value.toString(), maxString);
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return String(value);

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      name: truncateText(value.name || 'Error', 120),
      message: truncateText(value.message, maxString),
      stack: truncateText(value.stack, maxString)
    };
  }

  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[array(${value.length}) depth-limit]`;
    return '[object depth-limit]';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const out = [];
      const cap = Math.max(1, Math.min(maxItems, value.length));
      for (let i = 0; i < cap; i += 1) {
        out.push(compactSerializable(value[i], options, seen, depth + 1));
      }
      if (value.length > cap) out.push(`[truncated ${value.length - cap} items]`);
      return out;
    }

    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return { kind: 'ArrayBuffer', byteLength: value.byteLength };
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return { kind: value.constructor?.name || 'TypedArray', byteLength: value.byteLength };
    }

    const entries = Object.entries(value);
    const out = {};
    const cap = Math.max(1, Math.min(maxKeys, entries.length));
    for (let i = 0; i < cap; i += 1) {
      const [k, v] = entries[i];
      out[k] = compactSerializable(v, options, seen, depth + 1);
    }
    if (entries.length > cap) out.__truncatedKeys = entries.length - cap;
    return out;
  }

  return truncateText(String(value), maxString);
}

function serializeValue(value, maxChars = 2000) {
  try {
    return compactSerializable(value, {
      maxDepth: 4,
      maxItems: 30,
      maxKeys: 40,
      maxString: Math.max(120, Math.min(Number(maxChars) || 2000, 8000))
    });
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function isTextLikeContentType(contentType = '') {
  const value = String(contentType || '').toLowerCase();
  return !value
    || value.startsWith('text/')
    || value.includes('json')
    || value.includes('javascript')
    || value.includes('xml')
    || value.includes('html')
    || value.includes('x-www-form-urlencoded');
}

function serializeHeaders(headersLike, maxValueChars = 400, maxEntries = 24) {
  const out = {};
  if (!headersLike) return out;

  try {
    const entries = typeof headersLike.entries === 'function'
      ? Array.from(headersLike.entries())
      : Array.isArray(headersLike)
        ? headersLike
        : Object.entries(headersLike);

    for (const [key, value] of entries.slice(0, maxEntries)) {
      out[String(key)] = truncateText(String(value), maxValueChars);
    }
  } catch {
    return {};
  }

  return out;
}

function parseRawHeaderString(rawHeaders, maxValueChars = 400, maxEntries = 24) {
  const out = {};
  const lines = String(rawHeaders || '').split(/\r?\n/).filter(Boolean).slice(0, maxEntries);
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const name = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!name) continue;
    out[name] = truncateText(value, maxValueChars);
  }
  return out;
}

function serializeBodyPreview(value, maxChars = 1200) {
  if (value == null || value === '') return null;

  try {
    if (typeof value === 'string') {
      return { kind: 'text', preview: truncateText(value, maxChars) };
    }
    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
      return { kind: 'urlsearchparams', preview: truncateText(value.toString(), maxChars) };
    }
    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      const entries = [];
      for (const [key, entryValue] of value.entries()) {
        if (typeof File !== 'undefined' && entryValue instanceof File) {
          entries.push({ key, fileName: entryValue.name, size: entryValue.size, type: entryValue.type || null });
        } else {
          entries.push({ key, value: truncateText(String(entryValue), Math.max(120, Math.floor(maxChars / 3))) });
        }
        if (entries.length >= 12) break;
      }
      return { kind: 'formdata', preview: entries };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return { kind: 'blob', size: value.size, type: value.type || null };
    }
    if (ArrayBuffer.isView(value)) {
      return { kind: value.constructor?.name || 'typedarray', size: value.byteLength };
    }
    if (value instanceof ArrayBuffer) {
      return { kind: 'arraybuffer', size: value.byteLength };
    }
    if (typeof value === 'object') {
      return { kind: 'json', preview: serializeValue(value, maxChars) };
    }
    return { kind: typeof value, preview: truncateText(String(value), maxChars) };
  } catch {
    return { kind: 'unserializable', preview: truncateText(String(value), maxChars) };
  }
}

async function readFetchResponsePreview(response, maxChars = 1200) {
  try {
    const contentType = response?.headers?.get?.('content-type') || '';
    if (!isTextLikeContentType(contentType)) return null;
    const text = await response.clone().text();
    return text ? { kind: 'text', preview: truncateText(text, maxChars) } : null;
  } catch {
    return null;
  }
}

function getSpecPath() {
  return Cypress?.spec?.relative || Cypress?.spec?.name || null;
}


function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
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


function getHiResTimestamp(win = null) {
  try {
    const target = win || Cypress?.state?.('window') || globalThis?.window || null;
    const perf = target?.performance || null;
    if (perf && typeof perf.now === 'function') {
      const timeOrigin = Number.isFinite(Number(perf.timeOrigin)) ? Number(perf.timeOrigin) : Date.now();
      const nowMs = Number(perf.now());
      return {
        ts: toIso(timeOrigin + nowMs),
        tsEpochMs: Math.round(timeOrigin + nowMs),
        tsPerfMs: Number(nowMs.toFixed(3))
      };
    }
  } catch {}
  const now = Date.now();
  return { ts: toIso(now), tsEpochMs: now, tsPerfMs: null };
}

function getViewportInfo() {
  try {
    const win = Cypress?.state?.('window');
    const viewportWidth = Number(Cypress?.config?.('viewportWidth') || win?.innerWidth || 0) || null;
    const viewportHeight = Number(Cypress?.config?.('viewportHeight') || win?.innerHeight || 0) || null;
    const scrollX = Number(win?.scrollX || win?.pageXOffset || 0) || 0;
    const scrollY = Number(win?.scrollY || win?.pageYOffset || 0) || 0;
    return { viewportWidth, viewportHeight, scrollX, scrollY };
  } catch {
    return { viewportWidth: null, viewportHeight: null, scrollX: 0, scrollY: 0 };
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

function toEpochMs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function serializeTextPreview(value, maxChars = 240) {
  return truncateText(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), maxChars);
}

function cssSegment(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function buildSelectorPath(element, maxDepth = 6) {
  if (!element || element.nodeType !== 1) return null;
  const segments = [];
  let node = element;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < maxDepth) {
    let segment = String(node.tagName || 'node').toLowerCase();
    if (node.id) {
      segment += `#${cssSegment(node.id)}`;
      segments.unshift(segment);
      break;
    }
    const classNames = String(node.className || '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (classNames.length) {
      segment += classNames.map((item) => `.${cssSegment(item)}`).join('');
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children || []).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    segments.unshift(segment);
    node = parent;
    depth += 1;
  }
  return segments.join(' > ') || null;
}

function serializeElement(element, maxTextChars = 240) {
  if (!element || element.nodeType !== 1) return null;
  const attributes = {};
  const preferredAttrs = ['data-cy', 'data-testid', 'data-test', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'value'];
  for (const attrName of preferredAttrs) {
    const attrValue = element.getAttribute?.(attrName);
    if (attrValue != null && attrValue !== '') attributes[attrName] = truncateText(attrValue, 180);
  }

  const attrEntries = Array.from(element.attributes || [])
    .filter((attr) => !(attr.name in attributes))
    .slice(0, 8);
  for (const attr of attrEntries) {
    attributes[attr.name] = truncateText(attr.value, 180);
  }

  const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
  const textPreview = serializeTextPreview(
    element.innerText || element.textContent || element.value || '',
    maxTextChars
  );

  const preferredSelectors = [];
  if (element.id) preferredSelectors.push(`#${cssSegment(element.id)}`);
  for (const attrName of ['data-cy', 'data-testid', 'data-test', 'name', 'aria-label']) {
    const attrValue = element.getAttribute?.(attrName);
    if (attrValue) preferredSelectors.push(`[${attrName}="${String(attrValue).replace(/"/g, '\\"')}"]`);
  }
  const selectorPath = buildSelectorPath(element);
  if (selectorPath) preferredSelectors.push(selectorPath);

  return {
    tagName: String(element.tagName || '').toLowerCase() || null,
    id: element.id || null,
    classes: String(element.className || '').split(/\s+/).map((item) => item.trim()).filter(Boolean).slice(0, 10),
    selectorPath,
    preferredSelectors,
    attributes,
    textPreview: textPreview || null,
    valuePreview: serializeTextPreview(element.value, 120) || null,
    rect: rect ? {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    } : null
  };
}

function serializeTargetMeta(subject, maxTextChars = 240) {
  const items = [];
  for (const candidate of asArray(subject)) {
    if (!candidate) continue;
    if (candidate.jquery && candidate.length) {
      for (const element of Array.from(candidate).slice(0, 5)) {
        const serialized = serializeElement(element, maxTextChars);
        if (serialized) items.push(serialized);
      }
      continue;
    }
    if (candidate.nodeType === 1) {
      const serialized = serializeElement(candidate, maxTextChars);
      if (serialized) items.push(serialized);
    }
  }
  if (!items.length) return null;
  return {
    numElements: items.length,
    primary: items[0],
    elements: items
  };
}

function getCurrentTargetMeta(maxTextChars = 240) {
  try {
    return serializeTargetMeta(Cypress?.state?.('subject'), maxTextChars);
  } catch {
    return null;
  }
}

function getLogTargetMeta(attrs, log, maxTextChars = 240) {
  const directTarget = serializeTargetMeta(attrs?.$el || attrs?.el || log?.get?.('$el') || log?.get?.('el'), maxTextChars);
  return directTarget || getCurrentTargetMeta(maxTextChars);
}

function getCommandTargetMeta(command, maxTextChars = 240) {
  const attributes = command?.attributes || {};
  const directTarget = serializeTargetMeta(
    attributes.subject || attributes.$el || attributes.el || command?.subject,
    maxTextChars
  );
  return directTarget || getCurrentTargetMeta(maxTextChars);
}

function captureDomState(maxChars = 120000) {
  const html = getCurrentDomSnapshot(maxChars);
  const viewport = getViewportInfo();
  const hash = html ? simpleHash(html) : null;
  return {
    domSnapshot: html || null,
    domCapture: {
      available: Boolean(html),
      capturedAt: toIso(),
      url: getCurrentUrl(),
      viewportWidth: viewport.viewportWidth,
      viewportHeight: viewport.viewportHeight,
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
      domHash: hash,
      degraded: !html,
      degradedReason: html ? null : 'document_unavailable'
    }
  };
}

export function installTestHarborReplayHooks(options = {}) {
  if (globalThis.__TESTHARBOR_REPLAY_HOOKS_INSTALLED__) return;
  globalThis.__TESTHARBOR_REPLAY_HOOKS_INSTALLED__ = true;

  const maxEvents = Number(options.maxEvents || Cypress.env('TESTHARBOR_REPLAY_MAX_EVENTS') || 5000);
  const maxDomChars = Number(options.maxDomChars || Cypress.env('TESTHARBOR_REPLAY_MAX_DOM_CHARS') || 120000);
  const maxDetailChars = Number(options.maxDetailChars || Cypress.env('TESTHARBOR_REPLAY_MAX_DETAIL_CHARS') || 5000);

  const captureConsole = options.console !== false;
  const captureNetwork = options.network !== false;
  const captureDom = options.dom === true;

  const queue = [];
  const domSampleEvery = toNumber(options.domSampleEvery || Cypress.env('TESTHARBOR_REPLAY_DOM_SAMPLE_EVERY') || 1, 1);
  const maxRunnerMessageChars = toNumber(options.maxRunnerMessageChars || Cypress.env('TESTHARBOR_REPLAY_MAX_RUNNER_CHARS') || 1200, 1200);
  const maxTargetTextChars = toNumber(options.maxTargetTextChars || Cypress.env('TESTHARBOR_REPLAY_MAX_TARGET_TEXT_CHARS') || 240, 240);
  const maxNetworkBodyChars = toNumber(options.maxNetworkBodyChars || Cypress.env('TESTHARBOR_REPLAY_MAX_NETWORK_BODY_CHARS') || 1200, 1200);
  const maxNetworkHeaderValueChars = toNumber(options.maxNetworkHeaderValueChars || Cypress.env('TESTHARBOR_REPLAY_MAX_NETWORK_HEADER_VALUE_CHARS') || 400, 400);
  const maxNetworkHeaderEntries = toNumber(options.maxNetworkHeaderEntries || Cypress.env('TESTHARBOR_REPLAY_MAX_NETWORK_HEADER_ENTRIES') || 24, 24);
  const mutationBatchMs = Math.max(100, toNumber(options.mutationBatchMs || Cypress.env('TESTHARBOR_REPLAY_MUTATION_BATCH_MS') || 500, 500));
  const mutationMaxRecords = Math.max(20, toNumber(options.mutationMaxRecords || Cypress.env('TESTHARBOR_REPLAY_MUTATION_MAX_RECORDS') || 200, 200));
  const mutationMaxPayloadChars = Math.max(120, toNumber(options.mutationMaxPayloadChars || Cypress.env('TESTHARBOR_REPLAY_MUTATION_MAX_PAYLOAD_CHARS') || 2000, 2000));
  let commandSeq = 0;
  let eventSeq = 0;
  let mutationBuffer = [];
  let mutationFlushTimer = null;
  let mutationObserver = null;
  let droppedEventsTotal = 0;
  let droppedEventsSinceFlush = 0;
  let replayChunkSeq = 0;

  function nextEventMeta(stepId, phase = 'event') {
    eventSeq += 1;
    return {
      eventId: `${stepId || 'step'}:${phase}:${eventSeq}`,
      eventSeq,
      stepId: stepId || `step:${eventSeq}`,
      phase
    };
  }

  function enqueue(event = {}) {
    if (!event || typeof event !== 'object') return;
    if (queue.length >= maxEvents) {
      queue.shift();
      droppedEventsTotal += 1;
      droppedEventsSinceFlush += 1;
    }

    const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;

    queue.push({
      type: event.type || 'replay.event',
      ts: toIso(event.ts),
      title: event.title || null,
      detail: event.detail || null,
      command: event.command || null,
      status: event.status || payload?.status || null,
      eventId: event.eventId || payload?.eventId || null,
      eventSeq: event.eventSeq ?? payload?.eventSeq ?? null,
      stepId: event.stepId || payload?.stepId || null,
      phase: event.phase || payload?.phase || null,
      payload: payload,
      console: Array.isArray(event.console) ? event.console : [],
      network: Array.isArray(event.network) ? event.network : [],
      domSnapshot: typeof event.domSnapshot === 'string' ? event.domSnapshot : null,
      specPath: event.specPath || getSpecPath()
    });
  }


  function estimatePayloadBytes(value) {
    try {
      const text = JSON.stringify(value);
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
      return text.length;
    } catch {
      return 0;
    }
  }

  function countLikelyTruncatedEvents(events) {
    if (!Array.isArray(events) || !events.length) return 0;
    let count = 0;
    for (const event of events) {
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      const domCapture = payload.domCapture && typeof payload.domCapture === 'object' ? payload.domCapture : {};
      if (domCapture.degraded === true) {
        count += 1;
        continue;
      }
      if (payload.__truncatedKeys || payload.__truncatedItems || payload.__truncated) {
        count += 1;
      }
    }
    return count;
  }

  function flushQueuedEvents() {
    flushMutationBatch();
    if (!queue.length) return cy.wrap(null, { log: false });
    const events = queue.splice(0, queue.length);
    const specPath = getSpecPath();
    const droppedForChunk = droppedEventsSinceFlush;
    const chunkSeq = replayChunkSeq + 1;
    const encodedBytes = estimatePayloadBytes(events);
    const truncatedEvents = countLikelyTruncatedEvents(events);
    return cy
      .task('testharbor:replay', {
        specPath,
        events,
        meta: {
          clientChunkSeq: chunkSeq,
          compression: 'none',
          encodedBytes,
          droppedEvents: droppedForChunk,
          droppedEventsTotal,
          truncatedEvents
        }
      }, { log: false })
      .then(
        () => {
          replayChunkSeq = chunkSeq;
          droppedEventsSinceFlush = 0;
          return null;
        },
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


  function normalizeLogMessage(messageValue) {
    if (Array.isArray(messageValue)) {
      const parts = [];
      const cap = Math.min(messageValue.length, 12);
      for (let i = 0; i < cap; i += 1) {
        const chunk = serializeValue(messageValue[i], Math.max(200, Math.floor(maxDetailChars / 3)));
        if (typeof chunk === 'string') parts.push(chunk);
        else parts.push(truncateText(String(chunk == null ? '' : JSON.stringify(chunk)), Math.max(200, Math.floor(maxDetailChars / 3))));
      }
      if (messageValue.length > cap) parts.push(`…(+${messageValue.length - cap} more)`);
      return truncateText(parts.join(' | '), maxDetailChars);
    }
    if (messageValue == null) return '';
    if (typeof messageValue === 'string') return truncateText(messageValue, maxDetailChars);

    const serialized = serializeValue(messageValue, maxDetailChars);
    if (typeof serialized === 'string') return truncateText(serialized, maxDetailChars);
    try {
      return truncateText(JSON.stringify(serialized), maxDetailChars);
    } catch {
      return truncateText(String(serialized), maxDetailChars);
    }
  }

  function buildMutationRecord(kind, payload = {}, win = null) {
    const hi = getHiResTimestamp(win);
    return {
      event_type: kind,
      ts: hi.ts,
      tsEpochMs: hi.tsEpochMs,
      tsPerfMs: hi.tsPerfMs,
      payload: compactSerializable(payload, {
        maxDepth: 3,
        maxItems: 20,
        maxKeys: 20,
        maxString: mutationMaxPayloadChars
      })
    };
  }

  function queueMutationRecord(record, context = {}) {
    if (!record) return;
    mutationBuffer.push(record);
    if (mutationBuffer.length >= mutationMaxRecords) {
      flushMutationBatch(context);
      return;
    }
    if (!mutationFlushTimer) {
      mutationFlushTimer = setTimeout(() => {
        mutationFlushTimer = null;
        flushMutationBatch(context);
      }, mutationBatchMs);
    }
  }

  function flushMutationBatch(context = {}) {
    if (!mutationBuffer.length) return;
    if (mutationFlushTimer) {
      clearTimeout(mutationFlushTimer);
      mutationFlushTimer = null;
    }
    const records = mutationBuffer.splice(0, mutationBuffer.length);
    const hi = getHiResTimestamp();
    enqueue({
      type: 'replay.mutation.batch',
      ts: hi.ts,
      title: 'mutation-batch',
      detail: `mutation batch (${records.length})`,
      ...nextEventMeta(`mutation:${hi.tsEpochMs || Date.now()}`, 'batch'),
      payload: {
        event_type: 'mutation_batch',
        tsEpochMs: hi.tsEpochMs,
        tsPerfMs: hi.tsPerfMs,
        records,
        count: records.length,
        ...(context.stepId ? { stepId: context.stepId } : {}),
        ...(context.specRunId ? { specRunId: context.specRunId } : {})
      }
    });
  }

  function setupMutationObserver(win) {
    if (!win || !win.document || mutationObserver) return;

    const observerTarget = win.document.documentElement || win.document;
    const onMutation = (list) => {
      for (const mutation of list) {
        if (!mutation) continue;
        if (mutation.type === 'attributes') {
          queueMutationRecord(buildMutationRecord('dom.attribute', {
            name: mutation.attributeName || null,
            target: serializeElement(mutation.target, 120),
            value: mutation.target?.getAttribute?.(mutation.attributeName || '') || null
          }, win));
          continue;
        }
        if (mutation.type === 'characterData') {
          queueMutationRecord(buildMutationRecord('dom.text', {
            target: serializeElement(mutation.target?.parentElement || null, 120),
            text: truncateText(mutation.target?.data || '', mutationMaxPayloadChars)
          }, win));
          continue;
        }
        if (mutation.type === 'childList') {
          queueMutationRecord(buildMutationRecord('dom.child_list', {
            target: serializeElement(mutation.target, 120),
            added: Array.from(mutation.addedNodes || []).slice(0, 10).map((n) => serializeElement(n, 80)).filter(Boolean),
            removed: Array.from(mutation.removedNodes || []).slice(0, 10).map((n) => serializeElement(n, 80)).filter(Boolean)
          }, win));
        }
      }
    };

    mutationObserver = new win.MutationObserver(onMutation);
    mutationObserver.observe(observerTarget, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeOldValue: false,
      characterDataOldValue: false
    });

    queueMutationRecord(buildMutationRecord('dom.initial', {
      url: win.location?.href || null,
      title: win.document?.title || null,
      viewport: getViewportInfo()
    }, win));

    if (typeof win.addEventListener === 'function') {
      win.addEventListener('scroll', () => {
        queueMutationRecord(buildMutationRecord('scroll', {
          x: Number(win.scrollX || 0),
          y: Number(win.scrollY || 0)
        }, win));
      }, { passive: true });

      win.addEventListener('mousemove', (evt) => {
        queueMutationRecord(buildMutationRecord('mouse.move', {
          x: Number(evt?.clientX || 0),
          y: Number(evt?.clientY || 0)
        }, win));
      }, { passive: true });

      win.addEventListener('click', (evt) => {
        queueMutationRecord(buildMutationRecord('mouse.click', {
          x: Number(evt?.clientX || 0),
          y: Number(evt?.clientY || 0),
          button: Number(evt?.button || 0),
          target: serializeElement(evt?.target, 120)
        }, win));
      }, { passive: true });

      win.addEventListener('input', (evt) => {
        queueMutationRecord(buildMutationRecord('input', {
          target: serializeElement(evt?.target, 120),
          value: truncateText(evt?.target?.value || '', 120)
        }, win));
      }, { passive: true });
    }
  }


  Cypress.on('command:start', (command) => {
    const attributes = command?.attributes || {};
    const name = command?.name || attributes.name || 'command';
    const viewport = getViewportInfo();
    const stepId = `command:${attributes.id || command?.id || `${name}:${commandSeq + 1}`}`;
    const eventMeta = nextEventMeta(stepId, 'start');
    queueMutationRecord(buildMutationRecord('marker.command.start', { name, stepId, commandSeq: commandSeq + 1 }), { stepId });
    const target = getCommandTargetMeta(command, maxTargetTextChars);
    const domState = captureDomState(maxDomChars);
    const startedAt = attributes.wallClockStartedAt || toIso();

    enqueue({
      type: 'replay.command.started',
      title: name,
      detail: `Command ${name} started`,
      command: name,
      status: attributes.state || command?.state || 'pending',
      ...eventMeta,
      ...domState,
      payload: {
        ...eventMeta,
        name,
        displayName: attributes.displayName || name,
        id: attributes.id || command?.id || null,
        chainerId: attributes.chainerId || null,
        state: attributes.state || command?.state || 'pending',
        status: attributes.state || command?.state || 'pending',
        message: serializeValue(attributes.message, maxRunnerMessageChars) || null,
        args: serializeValue(attributes.args || command?.args || null, maxRunnerMessageChars),
        aliases: serializeValue(attributes.aliases || attributes.alias || null, maxRunnerMessageChars),
        numElements: attributes.numElements ?? null,
        wallClockStartedAt: startedAt,
        wallClockStartedAtMs: toEpochMs(startedAt),
        url: getCurrentUrl(),
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        target,
        domCapture: {
          ...domState.domCapture,
          exactForStep: Boolean(domState.domSnapshot)
        }
      }
    });
  });

  Cypress.on('command:end', (command) => {
    const attributes = command?.attributes || {};
    const name = command?.name || attributes.name || 'command';
    const message = attributes.message || null;
    commandSeq += 1;
    const stepId = `command:${attributes.id || command?.id || `${name}:${commandSeq}`}`;
    const eventMeta = nextEventMeta(stepId, 'end');
    queueMutationRecord(buildMutationRecord('marker.command.end', { name, stepId, commandSeq }), { stepId });
    const target = getCommandTargetMeta(command, maxTargetTextChars);

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

    const viewport = getViewportInfo();
    const shouldCaptureDom = captureDom && shouldCaptureDomForCommand(name, commandSeq, domSampleEvery);
    const domState = shouldCaptureDom
      ? captureDomState(maxDomChars)
      : {
          domSnapshot: null,
          domCapture: {
            available: false,
            capturedAt: toIso(),
            url: getCurrentUrl(),
            viewportWidth: viewport.viewportWidth,
            viewportHeight: viewport.viewportHeight,
            scrollX: viewport.scrollX,
            scrollY: viewport.scrollY,
            domHash: null,
            degraded: true,
            degradedReason: 'dom_sampling_skipped'
          }
        };
    const endedAt = toIso();
    const startedAt = attributes.wallClockStartedAt || null;
    const durationMs = startedAt ? Math.max(0, (toEpochMs(endedAt) || 0) - (toEpochMs(startedAt) || 0)) : null;

    enqueue({
      type: 'replay.command',
      title: name,
      detail: message ? truncateText(message, maxDetailChars) : `Command ${name}`,
      command: name,
      status: attributes.state || command?.state || null,
      ...eventMeta,
      ...domState,
      payload: {
        ...eventMeta,
        name,
        displayName: attributes.displayName || name,
        message: message ? truncateText(message, maxDetailChars) : null,
        state: attributes.state || command?.state || null,
        status: attributes.state || command?.state || null,
        chainerId: attributes.chainerId || null,
        id: attributes.id || command?.id || null,
        aliases: serializeValue(attributes.aliases || attributes.alias || null, maxRunnerMessageChars),
        args: serializeValue(attributes.args || command?.args || null, maxRunnerMessageChars),
        numElements: attributes.numElements ?? target?.numElements ?? null,
        wallClockStartedAt: startedAt,
        wallClockStartedAtMs: toEpochMs(startedAt),
        wallClockEndedAt: endedAt,
        wallClockEndedAtMs: toEpochMs(endedAt),
        elapsedMs: durationMs,
        endedAt,
        url: getCurrentUrl(),
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        consoleProps,
        target,
        domCapture: {
          ...domState.domCapture,
          exactForStep: Boolean(domState.domSnapshot)
        }
      }
    });
  });

  Cypress.on('log:added', (attrs, log) => {
    if (!attrs) return;
    const name = attrs.displayName || attrs.name || log?.get?.('name') || null;
    if (!name) return;
    const message = normalizeLogMessage(attrs.message ?? log?.get?.('message'));
    const instrument = String(attrs.instrument || log?.get?.('instrument') || 'log').toLowerCase();
    const state = firstNonEmpty(attrs.state, log?.get?.('state')) || null;
    const stepId = `log:${attrs.id || log?.get?.('id') || `${name}:${eventSeq + 1}`}`;
    const eventMeta = nextEventMeta(stepId, 'added');
    const target = getLogTargetMeta(attrs, log, maxTargetTextChars);
    const viewport = getViewportInfo();
    const domState = captureDom
      ? captureDomState(maxDomChars)
      : {
          domSnapshot: null,
          domCapture: {
            available: false,
            capturedAt: toIso(),
            url: getCurrentUrl(),
            viewportWidth: viewport.viewportWidth,
            viewportHeight: viewport.viewportHeight,
            scrollX: viewport.scrollX,
            scrollY: viewport.scrollY,
            domHash: null,
            degraded: true,
            degradedReason: 'dom_capture_disabled'
          }
        };

    enqueue({
      type: instrument === 'command' ? 'replay.cypress.command.log' : 'replay.cypress.log',
      title: String(name),
      detail: message || null,
      status: state,
      ...eventMeta,
      ...domState,
      payload: {
        ...eventMeta,
        id: attrs.id || log?.get?.('id') || null,
        instrument,
        name,
        displayName: attrs.displayName || log?.get?.('displayName') || name,
        state,
        status: state,
        message,
        alias: attrs.alias || log?.get?.('alias') || null,
        aliases: serializeValue(attrs.aliases || attrs.alias || log?.get?.('aliases') || log?.get?.('alias') || null, maxDetailChars),
        referencesAlias: attrs.referencesAlias || log?.get?.('referencesAlias') || null,
        numElements: attrs.numElements ?? log?.get?.('numElements') ?? target?.numElements ?? null,
        renderProps: serializeValue(attrs.renderProps || log?.get?.('renderProps') || null, maxDetailChars),
        consoleProps: serializeValue(attrs.consoleProps || log?.get?.('consoleProps') || null, maxDetailChars),
        eventProps: serializeValue(attrs.eventProps || log?.get?.('eventProps') || null, maxDetailChars),
        snapshots: serializeValue(attrs.snapshots || log?.get?.('snapshots') || null, maxDetailChars),
        wallClockStartedAt: attrs.wallClockStartedAt || log?.get?.('wallClockStartedAt') || null,
        wallClockStartedAtMs: toEpochMs(attrs.wallClockStartedAt || log?.get?.('wallClockStartedAt') || null),
        url: getCurrentUrl(),
        target,
        domCapture: {
          ...domState.domCapture,
          exactForStep: Boolean(domState.domSnapshot)
        }
      }
    });
  });

  Cypress.on('log:changed', (attrs, log) => {
    if (!attrs && !log) return;
    const name = attrs?.displayName || attrs?.name || log?.get?.('name') || null;
    if (!name) return;

    const message = normalizeLogMessage(attrs?.message ?? log?.get?.('message'));
    const instrument = String(attrs?.instrument || log?.get?.('instrument') || 'log').toLowerCase();
    const state = firstNonEmpty(attrs?.state, log?.get?.('state')) || null;
    const stepId = `log:${attrs?.id || log?.get?.('id') || `${name}:${eventSeq + 1}`}`;
    const eventMeta = nextEventMeta(stepId, 'changed');
    const target = getLogTargetMeta(attrs, log, maxTargetTextChars);
    const viewport = getViewportInfo();
    const domState = captureDom
      ? captureDomState(maxDomChars)
      : {
          domSnapshot: null,
          domCapture: {
            available: false,
            capturedAt: toIso(),
            url: getCurrentUrl(),
            viewportWidth: viewport.viewportWidth,
            viewportHeight: viewport.viewportHeight,
            scrollX: viewport.scrollX,
            scrollY: viewport.scrollY,
            domHash: null,
            degraded: true,
            degradedReason: 'dom_capture_disabled'
          }
        };

    enqueue({
      type: instrument === 'command' ? 'replay.cypress.command.log.changed' : 'replay.cypress.log.changed',
      title: String(name),
      detail: message || null,
      status: state,
      ...eventMeta,
      ...domState,
      payload: {
        ...eventMeta,
        id: attrs?.id || log?.get?.('id') || null,
        instrument,
        name,
        displayName: attrs?.displayName || log?.get?.('displayName') || name,
        state,
        status: state,
        message,
        alias: attrs?.alias || log?.get?.('alias') || null,
        aliases: serializeValue(attrs?.aliases || attrs?.alias || log?.get?.('aliases') || log?.get?.('alias') || null, maxDetailChars),
        referencesAlias: attrs?.referencesAlias || log?.get?.('referencesAlias') || null,
        numElements: attrs?.numElements ?? log?.get?.('numElements') ?? target?.numElements ?? null,
        renderProps: serializeValue(attrs?.renderProps || log?.get?.('renderProps') || null, maxDetailChars),
        consoleProps: serializeValue(attrs?.consoleProps || log?.get?.('consoleProps') || null, maxDetailChars),
        eventProps: serializeValue(attrs?.eventProps || log?.get?.('eventProps') || null, maxDetailChars),
        snapshots: serializeValue(attrs?.snapshots || log?.get?.('snapshots') || null, maxDetailChars),
        url: getCurrentUrl(),
        changedAt: toIso(),
        target,
        domCapture: {
          ...domState.domCapture,
          exactForStep: Boolean(domState.domSnapshot)
        }
      }
    });
  });

  Cypress.on('window:before:load', (win) => {
    if (!win || win.__testharborReplayPatched) return;
    win.__testharborReplayPatched = true;

    setupMutationObserver(win);

    if (captureConsole && win.console) {
      ['log', 'info', 'warn', 'error'].forEach((level) => {
        const original = win.console[level];
        if (typeof original !== 'function') return;
        win.console[level] = function patchedConsole(...args) {
          enqueue({
            type: 'replay.console',
            title: `console.${level}`,
            detail: truncateText(args.map((arg) => serializeValue(arg, 500)).join(' '), maxDetailChars),
            ...nextEventMeta(`console:${level}:${eventSeq + 1}`, 'emitted'),
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
        const requestHeaders = serializeHeaders(
          requestInit.headers || requestInput?.headers,
          maxNetworkHeaderValueChars,
          maxNetworkHeaderEntries
        );
        const requestBody = serializeBodyPreview(requestInit.body, maxNetworkBodyChars);

        try {
          const response = await originalFetch(...args);
          const endedAt = Date.now();
          const responseHeaders = serializeHeaders(
            response?.headers,
            maxNetworkHeaderValueChars,
            maxNetworkHeaderEntries
          );
          const responseBody = await readFetchResponsePreview(response, maxNetworkBodyChars);
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `HTTP ${response.status}`,
            ...nextEventMeta(`network:fetch:${method}:${url}:${eventSeq + 1}`, 'completed'),
            network: [{
              transport: 'fetch',
              method,
              url,
              status: response.status,
              statusText: response.statusText || null,
              ok: response.ok,
              redirected: response.redirected === true,
              responseUrl: response.url || null,
              requestHeaders,
              requestBody,
              responseHeaders,
              responseBody,
              timing: {
                startedAt: toIso(startedAt),
                endedAt: toIso(endedAt),
                durationMs: endedAt - startedAt
              }
            }]
          });
          return response;
        } catch (error) {
          const endedAt = Date.now();
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `Network error: ${truncateText(error?.message || String(error), 500)}`,
            ...nextEventMeta(`network:fetch:${method}:${url}:${eventSeq + 1}`, 'failed'),
            network: [{
              transport: 'fetch',
              method,
              url,
              error: truncateText(error?.message || String(error), 500),
              requestHeaders,
              requestBody,
              timing: {
                startedAt: toIso(startedAt),
                endedAt: toIso(endedAt),
                durationMs: endedAt - startedAt
              }
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
      const originalSetRequestHeader = xhrProto.setRequestHeader;

      xhrProto.open = function patchedOpen(method, url, ...rest) {
        this.__thReplayMethod = method;
        this.__thReplayUrl = url;
        this.__thReplayRequestHeaders = {};
        return originalOpen.call(this, method, url, ...rest);
      };

      xhrProto.setRequestHeader = function patchedSetRequestHeader(name, value) {
        if (!this.__thReplayRequestHeaders) this.__thReplayRequestHeaders = {};
        this.__thReplayRequestHeaders[String(name)] = truncateText(String(value), maxNetworkHeaderValueChars);
        return originalSetRequestHeader.call(this, name, value);
      };

      xhrProto.send = function patchedSend(...args) {
        const startedAt = Date.now();
        const method = String(this.__thReplayMethod || 'GET').toUpperCase();
        const url = truncateText(this.__thReplayUrl || '', 1000);
        const requestBody = serializeBodyPreview(args[0], maxNetworkBodyChars);

        this.addEventListener('loadend', () => {
          const endedAt = Date.now();
          const rawResponseHeaders = typeof this.getAllResponseHeaders === 'function' ? this.getAllResponseHeaders() : '';
          const responseHeaders = parseRawHeaderString(rawResponseHeaders, maxNetworkHeaderValueChars, maxNetworkHeaderEntries);
          const responseBody = this.responseType === 'json'
            ? serializeBodyPreview(this.response, maxNetworkBodyChars)
            : (this.responseType && this.responseType !== '' && this.responseType !== 'text'
              ? { kind: this.responseType, size: Number(this.response?.byteLength || this.response?.size || 0) || null }
              : serializeBodyPreview(this.responseText, maxNetworkBodyChars));
          enqueue({
            type: 'replay.network',
            title: `${method} ${url}`,
            detail: `HTTP ${this.status || 0}`,
            ...nextEventMeta(`network:xhr:${method}:${url}:${eventSeq + 1}`, 'completed'),
            network: [{
              transport: 'xhr',
              method,
              url,
              status: this.status || 0,
              statusText: this.statusText || null,
              ok: this.status >= 200 && this.status < 400,
              responseUrl: this.responseURL || null,
              redirected: Boolean(this.responseURL && this.responseURL !== url),
              requestHeaders: this.__thReplayRequestHeaders || {},
              requestBody,
              responseHeaders,
              responseBody,
              timing: {
                startedAt: toIso(startedAt),
                endedAt: toIso(endedAt),
                durationMs: endedAt - startedAt
              }
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
          ...nextEventMeta(`window:error:${eventSeq + 1}`, 'captured'),
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
        const reasonSerialized = serializeValue(reason, maxDetailChars);
        const reasonText = typeof reasonSerialized === 'string'
          ? reasonSerialized
          : (() => {
            try { return JSON.stringify(reasonSerialized); } catch { return String(reasonSerialized); }
          })();
        const message = typeof reason === 'string'
          ? reason
          : (reason?.message || truncateText(reasonText || 'unknown', maxDetailChars));
        enqueue({
          type: 'replay.js.unhandledrejection',
          title: 'unhandledrejection',
          detail: truncateText(message, maxDetailChars),
          ...nextEventMeta(`window:unhandledrejection:${eventSeq + 1}`, 'captured'),
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
      const viewport = getViewportInfo();
      const stepId = `test:${simpleHash(typeof test?.fullTitle === 'function' ? test.fullTitle() : test?.title || 'test')}`;
      const eventMeta = nextEventMeta(stepId, 'start');
      queueMutationRecord(buildMutationRecord('marker.test.start', { stepId, testTitle: test?.title || null }), { stepId });
      const domState = captureDom ? captureDomState(maxDomChars) : { domSnapshot: null, domCapture: { available: false, degraded: true, degradedReason: 'dom_capture_disabled' } };
      enqueue({
        type: 'replay.test.started',
        title: test?.title || 'test',
        detail: titlePath.length ? titlePath.join(' > ') : 'Test started',
        ...eventMeta,
        ...domState,
        payload: {
          ...eventMeta,
          testTitle: test?.title || null,
          fullTitle: typeof test?.fullTitle === 'function' ? test.fullTitle() : null,
          specPath: getSpecPath(),
          startedAt: toIso(),
          url: getCurrentUrl(),
          viewportWidth: viewport.viewportWidth,
          viewportHeight: viewport.viewportHeight,
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
          domCapture: {
            ...domState.domCapture,
            exactForStep: Boolean(domState.domSnapshot)
          }
        }
      });
    });
  }

  if (typeof afterEach === 'function') {
    afterEach(function () {
      const test = this?.currentTest;
      const titlePath = typeof test?.titlePath === 'function' ? test.titlePath() : [];
      const viewport = getViewportInfo();
      const stepId = `test:${simpleHash(typeof test?.fullTitle === 'function' ? test.fullTitle() : test?.title || 'test')}`;
      const eventMeta = nextEventMeta(stepId, 'end');
      queueMutationRecord(buildMutationRecord('marker.test.end', { stepId, testTitle: test?.title || null, state: test?.state || null }), { stepId });
      const finishEvent = {
        type: 'replay.test.finished',
        title: test?.title || 'test',
        detail: `Test ${(test?.state || 'unknown').toUpperCase()}`,
        status: test?.state || null,
        ...eventMeta,
        payload: {
          ...eventMeta,
          testTitle: test?.title || null,
          fullTitle: typeof test?.fullTitle === 'function' ? test.fullTitle() : null,
          state: test?.state || null,
          status: test?.state || null,
          duration: test?.duration ?? null,
          specPath: getSpecPath(),
          endedAt: toIso(),
          url: getCurrentUrl(),
          viewportWidth: viewport.viewportWidth,
          viewportHeight: viewport.viewportHeight,
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
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
          const domCapture = captureDomState(maxDomChars).domCapture;
          enqueue({
            type: 'replay.dom.snapshot',
            title: test?.title || 'DOM snapshot',
            detail: `Captured ${domSnapshot.length} chars`,
            ...nextEventMeta(`${stepId}:dom`, 'snapshot'),
            domSnapshot,
            payload: {
              testTitle: test?.title || null,
              state: test?.state || null,
              status: test?.state || null,
              url: getCurrentUrl(),
              viewportWidth: viewport.viewportWidth,
              viewportHeight: viewport.viewportHeight,
              scrollX: viewport.scrollX,
              scrollY: viewport.scrollY,
              capturedAt: toIso(),
              domCapture: {
                ...domCapture,
                exactForStep: true
              }
            }
          });
        }
      }, (error) => {
        // eslint-disable-next-line no-console
        console.warn('[testharbor] replay afterEach dom capture failed', error?.message || error);
      }).then(() => captureAndFlush());
    });
  }

  if (typeof after === 'function') {
    after(() => {
      try { if (mutationObserver) mutationObserver.disconnect(); } catch {}
      flushMutationBatch();
      return flushQueuedEvents();
    });
  }
}

export default installTestHarborReplayHooks;
