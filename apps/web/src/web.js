function initJsonForms() {
  for (const form of document.querySelectorAll('form[data-json-form]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const confirmText = form.dataset.confirm;
      if (confirmText && !window.confirm(confirmText)) return;

      const submitter = event.submitter;
      if (submitter) submitter.disabled = true;

      const formData = new FormData(form);
      const payload = {};
      for (const [key, value] of formData.entries()) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
          payload[key] = Array.isArray(payload[key]) ? [...payload[key], value] : [payload[key], value];
        } else {
          payload[key] = value;
        }
      }

      try {
        const res = await fetch(form.action, {
          method: form.method || 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error || `Request failed with ${res.status}`);
        window.location.assign(body.redirectTo || window.location.href);
      } catch (error) {
        window.alert(String(error.message || error));
        if (submitter) submitter.disabled = false;
      }
    });
  }
}

function initReplayPage() {
  const dataNode = document.getElementById('replay-data');
  if (!dataNode) return;

  const mediaNode = document.getElementById('replay-media-data');
  const metaNode = document.getElementById('replay-meta-data');

  function decodePayload(encoded, fallbackValue) {
    if (!encoded) return fallbackValue;
    try {
      const binary = atob(String(encoded).trim());
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const parsed = JSON.parse(decoded || 'null');
      return parsed == null ? fallbackValue : parsed;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[testharbor] replay payload decode failed', error && error.message ? error.message : error);
      return fallbackValue;
    }
  }

  const events = decodePayload(dataNode.textContent || '', []);
  const mediaPayload = decodePayload(mediaNode?.textContent || '', { videos: [] }) || { videos: [] };
  const replayMetaPayload = decodePayload(metaNode?.textContent || '', { replayIngest: {}, pageInfo: {}, eventCount: 0 }) || { replayIngest: {}, pageInfo: {}, eventCount: 0 };

  const slider = document.getElementById('replay-step');
  const list = document.getElementById('replay-step-list');
  const frame = document.getElementById('replay-frame');
  const videoNode = document.getElementById('replay-video');
  const frameStage = document.getElementById('replay-frame-stage');
  const replayShell = document.getElementById('replay-shell');
  const modalToggleButton = document.getElementById('replay-toggle-modal');
  const visualSourceSelect = document.getElementById('replay-visual-source');
  const visualMetaNode = document.getElementById('replay-visual-meta');
  const markerSelect = document.getElementById('replay-marker-select');
  const markerPrevButton = document.getElementById('replay-marker-prev');
  const markerNextButton = document.getElementById('replay-marker-next');
  const warningNode = document.getElementById('replay-step-warning');
  const diagnosticsNode = document.getElementById('replay-diagnostics');
  const meta = document.getElementById('replay-step-meta');
  const title = document.getElementById('replay-event-title');
  const eventDetailNode = document.getElementById('replay-event-detail');
  const elementStatusNode = document.getElementById('replay-element-status');
  const elementSummaryNode = document.getElementById('replay-element-summary');
  const elementMetaNode = document.getElementById('replay-element-meta');
  const consoleNode = document.getElementById('replay-console');
  const networkNode = document.getElementById('replay-network');
  const runnerNode = document.getElementById('replay-runner-log');
  const specSelect = document.getElementById('replay-spec-select');
  const speedSelect = document.getElementById('replay-speed');
  const playPauseButton = document.getElementById('replay-play-pause');
  const prevButton = document.getElementById('replay-step-prev');
  const nextButton = document.getElementById('replay-step-next');

  if (!slider || !list || !frame || !videoNode || !frameStage || !meta || !title || !consoleNode || !networkNode || !runnerNode || !specSelect || !speedSelect || !playPauseButton || !prevButton || !nextButton || !warningNode || !eventDetailNode || !elementStatusNode || !elementSummaryNode || !elementMetaNode) return;

  function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  }

  function firstNonEmpty() {
    for (let i = 0; i < arguments.length; i += 1) {
      const value = arguments[i];
      if (value == null) continue;
      const asString = typeof value === 'string' ? value.trim() : String(value).trim();
      if (asString) return asString;
    }
    return '';
  }

  function escapeHtmlInline(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeIso(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? firstNonEmpty(value, 'n/a') : date.toISOString();
  }

  function decodeHtmlEntities(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value || '');
    return textarea.value;
  }

  function normalizeSerializedText(value) {
    let text = firstNonEmpty(value);
    if (!text) return '';
    text = String(text).trim();

    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;

      if (text.startsWith('"') && text.endsWith('"')) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === 'string') {
            text = String(parsed).trim();
            changed = true;
            continue;
          }
        } catch {
          // ignore
        }
      }

      const unescaped = text
        .split('\\n').join('\n')
        .split('\\r').join('\r')
        .split('\\t').join('\t')
        .split('\\"').join('"')
        .split("\\'").join("'");

      if (unescaped !== text) {
        text = unescaped;
        changed = true;
      }

      if (text.includes('%')) {
        try {
          const decoded = decodeURIComponent(text);
          if (decoded && decoded !== text) {
            text = decoded.trim();
            changed = true;
          }
        } catch {
          // ignore
        }
      }

      if (!changed) break;
    }

    if (text.startsWith('&lt;') || text.includes('&quot;') || text.includes('&#39;') || text.includes('&amp;')) {
      text = decodeHtmlEntities(text);
    }

    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      const maybe = text.slice(1, -1).trim();
      if (maybe) text = maybe;
    }

    return text;
  }

  function sanitizeSnapshotHtml(value, baseUrl = '') {
    const html = normalizeSerializedText(value);
    if (!html) return '';

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      if (!doc || !doc.documentElement) return html;

      for (const node of doc.querySelectorAll('script, noscript')) node.remove();

      const head = doc.head || doc.documentElement;
      if (head && baseUrl) {
        const safeBase = String(baseUrl).trim();
        if (safeBase && /^(https?:|\/)/i.test(safeBase)) {
          let baseNode = doc.querySelector('base');
          if (!baseNode) {
            baseNode = doc.createElement('base');
            head.insertBefore(baseNode, head.firstChild || null);
          }
          baseNode.setAttribute('href', safeBase);
        }
      }

      return '<!doctype html>' + doc.documentElement.outerHTML;
    } catch {
      return html;
    }
  }

  function resolveEventUrl(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    return firstNonEmpty(
      e.url,
      payload.url,
      nested.url,
      payload.currentUrl,
      nested.currentUrl,
      payload.pageUrl,
      nested.pageUrl
    );
  }

  function extractViewport(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);

    const width = Number(firstNonEmpty(
      e.viewportWidth,
      payload.viewportWidth,
      nested.viewportWidth,
      payload.viewport?.width,
      nested.viewport?.width,
      1280
    )) || 1280;

    const height = Number(firstNonEmpty(
      e.viewportHeight,
      payload.viewportHeight,
      nested.viewportHeight,
      payload.viewport?.height,
      nested.viewport?.height,
      720
    )) || 720;

    return {
      width: Math.min(Math.max(width, 320), 4096),
      height: Math.min(Math.max(height, 240), 4096),
      url: resolveEventUrl(event)
    };
  }

  function fitFrameToStage(viewportMeta) {
    if (!frameStage) return;

    const stageRect = frameStage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;

    if (visualMode === 'video' && videoNode && videoNode.style.display !== 'none') {
      const fittedHeight = Math.max(220, Math.round(stageRect.height));
      frameStage.style.minHeight = `${fittedHeight}px`;
      videoNode.style.width = '100%';
      videoNode.style.height = `${Math.max(220, Math.round(stageRect.height - 8))}px`;
      videoNode.style.objectFit = 'contain';
      return;
    }

    let width = Number(viewportMeta?.width || 1280) || 1280;
    let height = Number(viewportMeta?.height || 720) || 720;

    try {
      const doc = frame.contentDocument;
      const docHeight = Math.max(
        Number(doc?.documentElement?.scrollHeight || 0),
        Number(doc?.body?.scrollHeight || 0)
      );
      const docWidth = Math.max(
        Number(doc?.documentElement?.scrollWidth || 0),
        Number(doc?.body?.scrollWidth || 0)
      );
      if (docHeight > 0) height = Math.max(height, Math.min(docHeight, 5000));
      if (docWidth > 0) width = Math.max(width, Math.min(docWidth, 5000));
    } catch {
      // ignore cross-doc sizing failures
    }

    const scale = Math.min(
      stageRect.width / Math.max(width, 1),
      stageRect.height / Math.max(height, 1),
      1
    );

    frame.style.width = `${Math.round(width)}px`;
    frame.style.height = `${Math.round(height)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'top left';

    const fittedHeight = Math.max(220, Math.round(height * scale) + 8);
    frameStage.style.minHeight = `${fittedHeight}px`;
  }

  function extractConsole(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    if (Array.isArray(e.console) && e.console.length) return e.console;
    if (Array.isArray(payload.console) && payload.console.length) return payload.console;
    if (Array.isArray(nested.console) && nested.console.length) return nested.console;
    return [];
  }

  function extractNetwork(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    if (Array.isArray(e.network) && e.network.length) return e.network;
    if (Array.isArray(payload.network) && payload.network.length) return payload.network;
    if (Array.isArray(nested.network) && nested.network.length) return nested.network;
    return [];
  }

  function extractDom(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    return normalizeSerializedText(firstNonEmpty(
      e.domSnapshot,
      payload.domSnapshot,
      payload.domCapture && payload.domCapture.html,
      e.domCapture && e.domCapture.html,
      nested.domSnapshot,
      nested.domCapture && nested.domCapture.html
    ));
  }

  function extractDomMeta(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    return asObject(e.domCapture && Object.keys(e.domCapture).length ? e.domCapture : (payload.domCapture && Object.keys(payload.domCapture).length ? payload.domCapture : nested.domCapture));
  }

  function extractTarget(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const target = asObject(e.target && Object.keys(e.target).length ? e.target : (payload.target && Object.keys(payload.target).length ? payload.target : (payload.targetElement && Object.keys(payload.targetElement).length ? payload.targetElement : (nested.target && Object.keys(nested.target).length ? nested.target : nested.targetElement))));
    return target;
  }

  function cssSegment(value) {
    const text = firstNonEmpty(value);
    if (!text) return '';
    return text.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function buildElementSelectorPath(element, maxDepth) {
    const limit = Number(maxDepth || 6);
    if (!element || element.nodeType !== 1) return null;
    const segments = [];
    let node = element;
    let depth = 0;

    while (node && node.nodeType === 1 && depth < limit) {
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
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }

      segments.unshift(segment);
      node = parent;
      depth += 1;
    }

    return segments.join(' > ') || null;
  }

  function serializeInspectorElement(element) {
    if (!element || element.nodeType !== 1) return null;
    const attributes = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 12)) {
      attributes[attr.name] = String(attr.value || '').slice(0, 200);
    }

    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    return {
      tagName: String(element.tagName || '').toLowerCase() || null,
      id: element.id || null,
      selectorPath: buildElementSelectorPath(element),
      classes: String(element.className || '').split(/\s+/).map((item) => item.trim()).filter(Boolean).slice(0, 10),
      attributes,
      textPreview: normalizeSerializedText((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 240) || null,
      bounds: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : null
    };
  }

  function extractStepIdentity(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    return {
      stepId: firstNonEmpty(e.stepId, payload.stepId, nested.stepId),
      eventId: firstNonEmpty(e.eventId, payload.eventId, nested.eventId),
      phase: firstNonEmpty(e.phase, payload.phase, nested.phase),
      seq: firstNonEmpty(e.eventSeq, payload.eventSeq, nested.eventSeq)
    };
  }

  function extractRunnerLine(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const type = firstNonEmpty(e.type, payload.type, nested.type, 'replay.event');
    const low = String(type).toLowerCase();
    const include = low.startsWith('replay.command')
      || low.startsWith('replay.log')
      || low.startsWith('replay.cypress.log')
      || low.startsWith('replay.cypress.command.log')
      || low.startsWith('replay.test')
      || low.startsWith('replay.spec')
      || low.startsWith('replay.run')
      || low.startsWith('replay.js.error')
      || low.startsWith('replay.console')
      || low.startsWith('replay.network');
    if (!include) return null;
    return {
      ts: firstNonEmpty(e.ts, payload.ts, nested.ts),
      type,
      title: firstNonEmpty(e.title, e.command, payload.name, payload.command, nested.name, nested.command, 'n/a'),
      detail: firstNonEmpty(e.detail, payload.message, nested.message, payload.detail, nested.detail),
      status: firstNonEmpty(e.status, payload.status, payload.state, nested.status, nested.state),
      displayName: firstNonEmpty(payload.displayName, nested.displayName),
      aliases: payload.aliases || nested.aliases || payload.alias || nested.alias || null,
      numElements: payload.numElements ?? nested.numElements ?? null,
      eventProps: payload.eventProps || nested.eventProps || null,
      consoleProps: payload.consoleProps || nested.consoleProps || null,
      identity: extractStepIdentity(event)
    };
  }

  const allEvents = Array.isArray(events) ? events : [];
  const allVideos = Array.isArray(mediaPayload?.videos) ? mediaPayload.videos : [];
  let activeEvents = allEvents.slice();
  let playbackRaf = null;
  let playbackState = null;
  let markerEntries = [];
  let eventTimelineMs = [];
  let modalOpen = false;
  let activeSpecKey = '__all__';
  let visualMode = 'dom';
  let activeVideo = null;
  let currentViewport = { width: 1280, height: 720, url: '' };
  let manualInspectorSelection = null;
  let frameInteractionToken = 0;

  if (visualSourceSelect) {
    if (!allVideos.length) {
      visualMode = 'dom';
      visualSourceSelect.value = 'dom';
      const videoOption = visualSourceSelect.querySelector('option[value="video"]');
      if (videoOption) videoOption.textContent = 'Video (unavailable)';
      visualSourceSelect.disabled = true;
    } else {
      visualSourceSelect.value = 'dom';
    }
  }

  function stopPlayback() {
    if (playbackRaf) {
      cancelAnimationFrame(playbackRaf);
      playbackRaf = null;
    }
    playbackState = null;
    playPauseButton.textContent = 'Play';
  }

  function resolveSpecKey(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const specRunId = firstNonEmpty(e.specRunId, payload.specRunId, payload.spec_run_id, nested.specRunId, nested.spec_run_id);
    if (specRunId) return 'run:' + specRunId;
    const specPath = firstNonEmpty(e.specPath, payload.specPath, payload.spec_path, nested.specPath, nested.spec_path);
    if (specPath) return 'path:' + specPath;
    const type = firstNonEmpty(e.type, payload.type, nested.type).toLowerCase();
    const titleText = firstNonEmpty(e.title, payload.title, nested.title, payload.name, nested.name);
    if (type.startsWith('replay.spec') && titleText) return 'path:' + titleText;
    return '__global__';
  }

  function resolveSpecLabel(event, key) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const specPath = firstNonEmpty(e.specPath, payload.specPath, payload.spec_path, nested.specPath, nested.spec_path);
    if (specPath) return specPath;
    const fallbackTitle = firstNonEmpty(e.title, payload.title, nested.title, payload.name, nested.name);
    if (key && key.startsWith('run:')) return fallbackTitle || ('spec-run ' + key.slice(4, 12));
    if (key && key.startsWith('path:')) return key.slice(5);
    return fallbackTitle || 'Run-level events';
  }

  function buildSpecOptions(items) {
    const groups = {};
    for (const event of items) {
      const key = resolveSpecKey(event);
      if (!groups[key]) groups[key] = { key, label: resolveSpecLabel(event, key), events: [] };
      groups[key].events.push(event);
    }

    const out = [{ key: '__all__', label: 'All specs / attempts', events: items.slice() }];
    const keys = Object.keys(groups)
      .filter((key) => key !== '__global__')
      .sort((a, b) => {
        const aCount = groups[a].events.length;
        const bCount = groups[b].events.length;
        if (aCount !== bCount) return bCount - aCount;
        return groups[a].label.localeCompare(groups[b].label);
      });

    for (const key of keys) {
      const group = groups[key];
      out.push({ key, label: `${group.label} (${group.events.length} events)`, events: group.events.slice() });
    }

    return out;
  }

  const specOptions = buildSpecOptions(allEvents);

  function hydrateSpecSelector() {
    specSelect.innerHTML = specOptions
      .map((option) => `<option value="${escapeHtmlInline(option.key)}">${escapeHtmlInline(option.label)}</option>`)
      .join('');
  }

  function eventsForSpec(key) {
    if (!key || key === '__all__') return allEvents.slice();
    const scoped = [];
    for (const event of allEvents) {
      const eventKey = resolveSpecKey(event);
      if (eventKey === key || eventKey === '__global__') scoped.push(event);
    }
    return scoped;
  }

  function toMillis(value) {
    if (value == null) return null;
    const n = Date.parse(String(value));
    return Number.isFinite(n) ? n : null;
  }

  function buildEventTimeline(items) {
    const out = [];
    let last = 0;
    for (let i = 0; i < items.length; i += 1) {
      const event = asObject(items[i]);
      const payload = asObject(event.payload);
      const nested = asObject(payload.payload);
      const ts = toMillis(firstNonEmpty(event.ts, payload.ts, nested.ts));
      if (ts == null) {
        last += 300;
        out.push(last);
        continue;
      }
      if (!out.length) {
        last = ts;
      } else if (ts < last) {
        last += 8;
      } else {
        last = ts;
      }
      out.push(last);
    }
    return out;
  }

  function isMarkerType(type) {
    const low = String(type || '').toLowerCase();
    return low.startsWith('replay.command')
      || low.startsWith('replay.test')
      || low.startsWith('replay.spec')
      || low.startsWith('replay.run')
      || low.startsWith('replay.js.error')
      || low.includes('marker.');
  }

  function buildMarkerEntries(items) {
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const event = asObject(items[i]);
      const payload = asObject(event.payload);
      const nested = asObject(payload.payload);
      const type = firstNonEmpty(event.type, payload.type, nested.type, 'replay.event');
      if (!isMarkerType(type) && !isFailureEvent(event)) continue;
      const title = firstNonEmpty(event.title, event.command, payload.displayName, payload.name, nested.name, payload.command, type);
      const when = safeIso(firstNonEmpty(event.ts, payload.ts, nested.ts));
      out.push({
        index: i,
        label: `${i + 1}. ${title} · ${String(type).replace(/^replay\./, '')} · ${when}`,
        type,
        ts: firstNonEmpty(event.ts, payload.ts, nested.ts)
      });
    }
    if (!out.length && items.length) {
      out.push({ index: 0, label: '1. Start of timeline', type: 'replay.start', ts: null });
    }
    return out;
  }


  function renderReplayDiagnostics() {
    if (!diagnosticsNode) return;
    const ingest = asObject(replayMetaPayload.replayIngest);
    const pageInfo = asObject(replayMetaPayload.pageInfo);
    const dropped = Number(ingest.droppedEventsTotal || ingest.droppedEvents || 0);
    const truncated = Number(ingest.truncatedEvents || 0);
    const chunks = Number(ingest.chunkCount || 0);
    const eventsSeen = Number(replayMetaPayload.eventCount || activeEvents.length || 0);
    const flags = [];
    if (dropped > 0) flags.push(`dropped=${dropped}`);
    if (truncated > 0) flags.push(`truncated=${truncated}`);
    if (pageInfo.truncated) flags.push('page-truncated=true');

    diagnosticsNode.innerHTML = `<strong>Replay diagnostics:</strong> chunks=${chunks} · events=${eventsSeen} · dropped=${dropped} · truncated=${truncated}${flags.length ? ` · <code>${escapeHtmlInline(flags.join(' | '))}</code>` : ''}`;
  }

  function hydrateMarkerSelector() {
    if (!markerSelect) return;
    markerSelect.innerHTML = markerEntries
      .map((marker) => `<option value="${marker.index}">${escapeHtmlInline(marker.label)}</option>`)
      .join('');
    markerSelect.disabled = markerEntries.length === 0;
  }

  function syncMarkerSelection(stepIndex) {
    if (!markerSelect || !markerEntries.length) return;
    let chosen = markerEntries[0];
    for (const marker of markerEntries) {
      if (marker.index <= stepIndex) chosen = marker;
      else break;
    }
    markerSelect.value = String(chosen.index);
  }

  function jumpToMarker(direction) {
    if (!markerEntries.length) return;
    const current = Math.min(Math.max(Number(slider.value || 0), 0), Math.max(activeEvents.length - 1, 0));
    let target = null;
    if (direction > 0) {
      target = markerEntries.find((marker) => marker.index > current) || markerEntries[markerEntries.length - 1];
    } else {
      for (let i = markerEntries.length - 1; i >= 0; i -= 1) {
        if (markerEntries[i].index < current) { target = markerEntries[i]; break; }
      }
      if (!target) target = markerEntries[0];
    }
    stopPlayback();
    slider.value = String(target.index);
    renderCurrent();
  }

  function getSpecMetaFromKey(key) {
    if (!key || key === '__all__') return { specRunId: null, specPath: null };
    if (key.startsWith('run:')) return { specRunId: key.slice(4), specPath: null };
    if (key.startsWith('path:')) return { specRunId: null, specPath: key.slice(5) };
    return { specRunId: null, specPath: null };
  }

  function pickVideoForSpec(key) {
    if (!allVideos.length) return null;
    const { specRunId, specPath } = getSpecMetaFromKey(key);

    if (specRunId) {
      const exact = allVideos.find((video) => firstNonEmpty(video?.specRunId) === specRunId);
      if (exact) return exact;
    }

    if (specPath) {
      const byPath = allVideos.find((video) => firstNonEmpty(video?.specPath) === specPath);
      if (byPath) return byPath;
    }

    return allVideos[0] || null;
  }

  function resolveSpecStartMillis(eventsSubset, key) {
    const { specRunId, specPath } = getSpecMetaFromKey(key);
    for (const event of eventsSubset) {
      const e = asObject(event);
      const payload = asObject(e.payload);
      const nested = asObject(payload.payload);
      const type = firstNonEmpty(e.type, payload.type, nested.type).toLowerCase();
      if (!type.startsWith('replay.spec.started')) continue;

      const eventSpecRunId = firstNonEmpty(e.specRunId, payload.specRunId, payload.spec_run_id, nested.specRunId, nested.spec_run_id);
      const eventSpecPath = firstNonEmpty(e.specPath, payload.specPath, payload.spec_path, nested.specPath, nested.spec_path, e.title);

      if (specRunId && eventSpecRunId && eventSpecRunId !== specRunId) continue;
      if (!specRunId && specPath && eventSpecPath && eventSpecPath !== specPath) continue;

      const ts = toMillis(firstNonEmpty(e.ts, payload.ts, nested.ts, payload.startedAt, nested.startedAt));
      if (ts != null) return ts;
    }

    for (const event of eventsSubset) {
      const e = asObject(event);
      const payload = asObject(e.payload);
      const nested = asObject(payload.payload);
      const ts = toMillis(firstNonEmpty(e.ts, payload.ts, nested.ts));
      if (ts != null) return ts;
    }

    return null;
  }

  function syncVideoToEvent(event, key) {
    if (!activeVideo || !videoNode || visualMode !== 'video') return;

    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const eventMillis = toMillis(firstNonEmpty(e.ts, payload.ts, nested.ts));
    const specStartMillis = resolveSpecStartMillis(activeEvents, key || activeSpecKey);

    if (eventMillis == null || specStartMillis == null) return;

    const targetSeconds = Math.max(0, (eventMillis - specStartMillis) / 1000);

    const applySeek = () => {
      const duration = Number(videoNode.duration);
      const cap = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : null;
      const seekTo = cap == null ? targetSeconds : Math.min(targetSeconds, cap);
      if (Number.isFinite(seekTo)) {
        try {
          if (Math.abs((videoNode.currentTime || 0) - seekTo) > 0.25) videoNode.currentTime = seekTo;
        } catch {
          // ignore seek errors
        }
      }
    };

    if (Number.isFinite(videoNode.duration) && videoNode.duration > 0) applySeek();
    else videoNode.addEventListener('loadedmetadata', applySeek, { once: true });
  }

  function applyVisualMode(event, key) {
    const hasVideo = Boolean(activeVideo && activeVideo.url);
    const useVideo = visualMode === 'video' && hasVideo;

    if (useVideo) {
      if (frame) frame.style.display = 'none';
      if (videoNode) {
        videoNode.style.display = 'block';
        if (videoNode.dataset.src !== String(activeVideo.url)) {
          videoNode.src = String(activeVideo.url);
          videoNode.dataset.src = String(activeVideo.url);
        }
      }
      if (visualMetaNode) {
        const label = firstNonEmpty(activeVideo?.specPath, activeVideo?.specRunId, 'run-level');
        visualMetaNode.textContent = `Visual source: video (${label})`; 
      }
      syncVideoToEvent(event, key);
      return;
    }

    if (videoNode) {
      videoNode.style.display = 'none';
      if (videoNode.dataset.src) {
        try { videoNode.pause(); } catch {}
      }
    }
    if (frame) frame.style.display = 'block';
    if (visualMetaNode) visualMetaNode.textContent = 'Visual source: DOM snapshot (best effort)';
  }

  function isFailureEvent(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const type = firstNonEmpty(e.type, payload.type, nested.type).toLowerCase();
    const detail = firstNonEmpty(e.detail, payload.detail, payload.message, nested.detail, nested.message).toLowerCase();
    const status = firstNonEmpty(payload.status, nested.status).toLowerCase();
    return type.includes('error') || type.includes('failed') || status === 'failed' || detail.includes(' failed');
  }

  function classifyReplayEvent(event) {
    const e = asObject(event);
    const payload = asObject(e.payload);
    const nested = asObject(payload.payload);
    const type = firstNonEmpty(e.type, payload.type, nested.type, 'replay.event').toLowerCase();
    if (isFailureEvent(event)) return 'failure';
    if (type.startsWith('replay.cypress.command.log') || type.startsWith('replay.command')) return 'command';
    if (type.startsWith('replay.network')) return 'network';
    if (type.startsWith('replay.console')) return 'console';
    if (type.startsWith('replay.cypress.log') || type.startsWith('replay.log')) return 'log';
    return 'event';
  }

  function findDefaultStepIndex(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    for (let i = 0; i < items.length; i += 1) {
      if (isFailureEvent(items[i])) return i;
    }
    return Math.max(items.length - 1, 0);
  }

  function getEvent(index) {
    if (index < 0 || index >= activeEvents.length) return {};
    return asObject(activeEvents[index]);
  }

  function collectUpTo(index, extractor, limit) {
    const out = [];
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(activeEvents.length - 1, 0));
    for (let i = 0; i <= safeIndex && i < activeEvents.length; i += 1) {
      const value = extractor(activeEvents[i]);
      if (!value) continue;
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    const max = Number(limit || 200);
    return out.length > max ? out.slice(out.length - max) : out;
  }

  function findDomAtOrBefore(index) {
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(activeEvents.length - 1, 0));
    for (let i = safeIndex; i >= 0; i -= 1) {
      const dom = extractDom(activeEvents[i]);
      if (dom) return { dom, index: i };
    }
    return null;
  }

  function renderList() {
    list.innerHTML = activeEvents.map((event, idx) => {
      const e = asObject(event);
      const payload = asObject(e.payload);
      const nested = asObject(payload.payload);
      const typeLabel = firstNonEmpty(e.type, payload.type, nested.type, 'replay.event');
      const typeShort = String(typeLabel).replace(/^replay\./, '');
      const commandLabel = firstNonEmpty(
        payload.displayName,
        payload.name,
        e.title,
        e.command,
        payload.command,
        nested.displayName,
        nested.name,
        nested.command,
        typeShort,
        'event'
      );
      const detailLabel = firstNonEmpty(e.detail, payload.message, nested.message, payload.detail, nested.detail);
      const when = safeIso(e.ts || payload.ts || nested.ts);
      const kind = classifyReplayEvent(event);
      const domMeta = extractDomMeta(event);
      const target = extractTarget(event);
      const identity = extractStepIdentity(event);

      const stateRaw = firstNonEmpty(payload.state, nested.state, payload.status, nested.status);
      const state = String(stateRaw || '').toLowerCase();
      const stateClass = state.includes('fail') || kind === 'failure'
        ? 'failed'
        : (state.includes('pass') || state.includes('success')
          ? 'passed'
          : (state.includes('pending') ? 'pending' : 'unknown'));
      const degraded = domMeta.degraded || !extractDom(event) || !target.primary;
      const identityLabel = identity.stepId || identity.eventId || '';

      return `<button type="button" data-step="${idx}" class="button button-secondary replay-step-button replay-step-kind-${escapeHtmlInline(kind)} replay-step-state-${escapeHtmlInline(stateClass)}">
        <span class="replay-step-index">${idx + 1}</span>
        <span class="replay-step-body">
          <span class="replay-step-command-row">
            <span class="replay-step-state-dot replay-step-state-dot-${escapeHtmlInline(stateClass)}"></span>
            <strong class="replay-step-command">${escapeHtmlInline(String(commandLabel).slice(0, 180))}</strong>
          </span>
          <small class="replay-step-meta-line">${escapeHtmlInline(typeShort)}${detailLabel ? ` · ${escapeHtmlInline(String(detailLabel).slice(0, 160))}` : ''} · ${escapeHtmlInline(when)}${identityLabel ? ` · ${escapeHtmlInline(String(identityLabel).slice(0, 72))}` : ''}${degraded ? ' · degraded' : ''}</small>
        </span>
      </button>`;
    }).join('');

    for (const button of list.querySelectorAll('button[data-step]')) {
      button.addEventListener('click', function onReplayStepClick() {
        stopPlayback();
        slider.value = this.dataset.step;
        renderCurrent();
      });
    }
  }

  function clearFrameHighlight() {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const priorNodes = Array.from(doc.querySelectorAll('[data-testharbor-highlight="true"]'));
      for (const prior of priorNodes) {
        prior.removeAttribute('data-testharbor-highlight');
        prior.style.outline = '';
        prior.style.outlineOffset = '';
        prior.style.backgroundColor = '';
      }
    } catch {
      // ignore
    }
  }

  function findTargetInFrame(target) {
    if (!target || !target.primary) return { element: null, reason: 'missing_target_metadata' };
    try {
      const doc = frame.contentDocument;
      if (!doc) return { element: null, reason: 'iframe_document_unavailable' };
      const primary = asObject(target.primary);
      const selectors = Array.isArray(primary.preferredSelectors) ? primary.preferredSelectors : [];
      for (const selector of selectors) {
        if (!selector) continue;
        try {
          const found = doc.querySelector(selector);
          if (found) return { element: found, reason: null };
        } catch {
          // ignore invalid selectors
        }
      }
      if (primary.id) {
        const foundById = doc.getElementById(primary.id);
        if (foundById) return { element: foundById, reason: null };
      }
      const attrs = asObject(primary.attributes);
      for (const attrName of ['data-cy', 'data-testid', 'data-test', 'name', 'aria-label']) {
        const attrValue = attrs[attrName];
        if (!attrValue) continue;
        const found = doc.querySelector(`[${attrName}="${String(attrValue).replace(/"/g, '\\"')}"]`);
        if (found) return { element: found, reason: null };
      }
      if (primary.tagName && primary.textPreview) {
        const candidates = Array.from(doc.querySelectorAll(primary.tagName)).slice(0, 100);
        const normalizedTargetText = String(primary.textPreview).trim();
        const match = candidates.find((node) => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().includes(normalizedTargetText));
        if (match) return { element: match, reason: null };
      }
      return { element: null, reason: 'selector_not_found_in_snapshot' };
    } catch {
      return { element: null, reason: 'iframe_access_failed' };
    }
  }

  function applyFrameHighlight(target) {
    clearFrameHighlight();
    const located = findTargetInFrame(target);
    if (!located.element) return located;
    const element = located.element;
    element.setAttribute('data-testharbor-highlight', 'true');
    element.style.outline = '3px solid rgba(191, 79, 47, 0.92)';
    element.style.outlineOffset = '2px';
    element.style.backgroundColor = 'rgba(255, 214, 102, 0.28)';
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      // ignore
    }
    return located;
  }

  function highlightManualElement(element) {
    if (!element) return;
    clearFrameHighlight();
    element.setAttribute('data-testharbor-highlight', 'true');
    element.style.outline = '3px solid rgba(31, 78, 121, 0.92)';
    element.style.outlineOffset = '2px';
    element.style.backgroundColor = 'rgba(125, 211, 252, 0.22)';
  }

  function renderInspector(event, located) {
    const payload = asObject(event.payload);
    const nested = asObject(payload.payload);
    const domMeta = extractDomMeta(event);
    const target = extractTarget(event);
    const identity = extractStepIdentity(event);
    const warnings = [];
    const exactDomAtStep = Boolean(extractDom(event));

    if (!exactDomAtStep) {
      warnings.push('No exact DOM snapshot was captured for this step.');
    }
    if (domMeta.degraded) warnings.push(`DOM capture degraded: ${firstNonEmpty(domMeta.degradedReason, 'unspecified reason')}.`);
    if (!target.primary) warnings.push('No target element metadata was captured for this step.');
    if (target.primary && !located.element) warnings.push(`Target could not be located in the rendered snapshot: ${firstNonEmpty(located.reason, 'unknown_reason')}.`);

    if (warnings.length) {
      warningNode.style.display = 'block';
      warningNode.innerHTML = `<strong>Degraded fidelity</strong><p>${escapeHtmlInline(warnings.join(' '))}</p>`;
    } else {
      warningNode.style.display = 'none';
      warningNode.textContent = '';
    }

    const summaryBits = [
      firstNonEmpty(payload.displayName, payload.name, event.title, event.command, event.type, 'step'),
      firstNonEmpty(payload.status, payload.state, nested.status, nested.state),
      identity.stepId ? `step ${identity.stepId}` : '',
      identity.phase ? `phase ${identity.phase}` : ''
    ].filter(Boolean);
    elementStatusNode.textContent = manualInspectorSelection
      ? 'Manual inspect'
      : (warnings.length ? 'Degraded' : (located.element ? 'Located in iframe' : 'Captured'));
    elementSummaryNode.innerHTML = `<p><strong>${escapeHtmlInline(summaryBits.join(' · ') || 'Selected step')}</strong></p>
      <p>${escapeHtmlInline(firstNonEmpty(event.detail, payload.message, nested.message, 'No detail captured'))}</p>`
      + (manualInspectorSelection
        ? `<p><strong>Manual selection:</strong> ${escapeHtmlInline(firstNonEmpty(manualInspectorSelection.selectorPath, manualInspectorSelection.tagName, 'element'))}</p>`
        : '');

    const inspectorPayload = {
      identity,
      target,
      domCapture: domMeta,
      located: {
        found: Boolean(located.element),
        reason: located.reason || null
      },
      timing: {
        ts: firstNonEmpty(event.ts, payload.ts, nested.ts),
        wallClockStartedAt: firstNonEmpty(payload.wallClockStartedAt, nested.wallClockStartedAt),
        wallClockEndedAt: firstNonEmpty(payload.wallClockEndedAt, nested.wallClockEndedAt),
        elapsedMs: payload.elapsedMs ?? nested.elapsedMs ?? null
      },
      runner: {
        aliases: payload.aliases || nested.aliases || null,
        numElements: payload.numElements ?? nested.numElements ?? null,
        eventProps: payload.eventProps || nested.eventProps || null,
        consoleProps: payload.consoleProps || nested.consoleProps || null
      },
      manualSelection: manualInspectorSelection
    };
    elementMetaNode.textContent = JSON.stringify(inspectorPayload, null, 2);
  }

  function bindFrameInspection(event, located) {
    frameInteractionToken += 1;
    const token = frameInteractionToken;

    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.onclick = (clickEvent) => {
        if (token !== frameInteractionToken) return;
        const selected = clickEvent.target;
        if (!selected || selected.nodeType !== 1) return;
        clickEvent.preventDefault();
        manualInspectorSelection = serializeInspectorElement(selected);
        highlightManualElement(selected);
        renderInspector(event, located);
      };
    } catch {
      // ignore iframe inspection binding failures
    }
  }


  function renderCurrent() {
    const rawIdx = Number(slider.value || 0);
    const idx = Number.isFinite(rawIdx) ? Math.min(Math.max(rawIdx, 0), Math.max(activeEvents.length - 1, 0)) : 0;

    const event = getEvent(idx);
    const payload = asObject(event.payload);
    const nested = asObject(payload.payload);

    const eventType = firstNonEmpty(event.type, payload.type, nested.type, 'replay.event');
    const eventTitle = firstNonEmpty(event.title, event.command, payload.name, payload.command, nested.name, nested.command, eventType);
    const eventDetail = firstNonEmpty(event.detail, payload.message, nested.message, payload.detail, nested.detail, 'No detail captured');

    meta.textContent = (activeEvents.length ? idx + 1 : 0) + ' / ' + activeEvents.length;
    title.textContent = eventTitle + ' @ ' + safeIso(firstNonEmpty(event.ts, payload.ts, nested.ts));

    const stepIdentity = extractStepIdentity(event);
    const stepDetail = {
      index: idx + 1,
      total: activeEvents.length,
      type: eventType,
      title: eventTitle,
      detail: eventDetail,
      status: firstNonEmpty(payload.status, payload.state, nested.status, nested.state, null),
      timing: {
        ts: firstNonEmpty(event.ts, payload.ts, nested.ts, null),
        wallClockStartedAt: firstNonEmpty(payload.wallClockStartedAt, nested.wallClockStartedAt, null),
        wallClockEndedAt: firstNonEmpty(payload.wallClockEndedAt, nested.wallClockEndedAt, null),
        elapsedMs: payload.elapsedMs ?? nested.elapsedMs ?? null
      },
      identity: stepIdentity,
      target: extractTarget(event),
      domCapture: extractDomMeta(event)
    };
    eventDetailNode.textContent = JSON.stringify(stepDetail, null, 2);

    const viewport = extractViewport(event);
    currentViewport = viewport;
    manualInspectorSelection = null;

    const exactDom = extractDom(event);
    const domBaseUrl = resolveEventUrl(event) || viewport.url || '';
    const sanitizedDom = exactDom ? sanitizeSnapshotHtml(exactDom, domBaseUrl) : '';

    if (sanitizedDom) {
      frame.srcdoc = String(sanitizedDom);
    } else {
      const payloadPreview = JSON.stringify(payload && Object.keys(payload).length ? payload : event, null, 2);
      frame.srcdoc = '<html><body style="font-family:system-ui, sans-serif; padding:16px; color:#111827;">'
        + '<h3>Exact-step DOM unavailable</h3>'
        + '<p><strong>Type:</strong> ' + escapeHtmlInline(eventType) + '</p>'
        + '<p><strong>Title:</strong> ' + escapeHtmlInline(eventTitle) + '</p>'
        + '<p><strong>Detail:</strong> ' + escapeHtmlInline(eventDetail) + '</p>'
        + (domBaseUrl ? '<p><strong>Page URL:</strong> ' + escapeHtmlInline(domBaseUrl) + '</p>' : '')
        + '<p>This step has no exact DOM snapshot, so the replay viewer cannot render a precise iframe state for it.</p>'
        + '<pre style="white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;">'
        + escapeHtmlInline(String(payloadPreview).slice(0, 12000))
        + '</pre>'
        + '</body></html>';
    }

    applyVisualMode(event, activeSpecKey);

    const fitNow = () => fitFrameToStage(currentViewport);
    const renderFrameState = () => {
      const located = applyFrameHighlight(extractTarget(event));
      fitNow();
      if (!extractDom(event)) clearFrameHighlight();
      if (extractDom(event)) bindFrameInspection(event, located);
      renderInspector(event, located);
    };
    frame.onload = renderFrameState;
    if (videoNode) {
      videoNode.onloadedmetadata = fitNow;
      videoNode.onloadeddata = fitNow;
    }
    window.requestAnimationFrame(renderFrameState);

    const consoleData = collectUpTo(idx, extractConsole, 250);
    const networkData = collectUpTo(idx, extractNetwork, 250);
    const runnerData = collectUpTo(idx, extractRunnerLine, 350);

    consoleNode.textContent = consoleData.length
      ? JSON.stringify(consoleData, null, 2)
      : `No console payload up to this step (${idx + 1}).`;

    networkNode.textContent = networkData.length
      ? JSON.stringify(networkData, null, 2)
      : `No network payload up to this step (${idx + 1}).`;

    runnerNode.textContent = runnerData.length
      ? runnerData.map((line) => {
        const row = asObject(line);
        const extra = [
          firstNonEmpty(row.status),
          row.numElements != null ? `numElements=${row.numElements}` : '',
          row.identity && row.identity.stepId ? `step=${row.identity.stepId}` : '',
          row.identity && row.identity.phase ? `phase=${row.identity.phase}` : ''
        ].filter(Boolean).join(' | ');
        return `${safeIso(row.ts)} | ${firstNonEmpty(row.type, 'replay.event')} | ${firstNonEmpty(row.title, 'n/a')}${row.detail ? ` | ${row.detail}` : ''}${extra ? ` | ${extra}` : ''}`;
      }).join('\n')
      : `No runner log payload up to this step (${idx + 1}).`;

    for (const activeButton of list.querySelectorAll('button[data-step]')) {
      const isActive = Number(activeButton.dataset.step) === idx;
      if (isActive) activeButton.classList.add('replay-step-active');
      else activeButton.classList.remove('replay-step-active');
    }
    syncMarkerSelection(idx);
  }


  function findTimelineIndexForVirtualMs(targetMs) {
    if (!eventTimelineMs.length) return 0;
    let lo = 0;
    let hi = eventTimelineMs.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const value = eventTimelineMs[mid];
      if (value <= targetMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function startVirtualPlayback() {
    if (!activeEvents.length) return;
    stopPlayback();

    const speed = Math.max(Number(speedSelect.value || 1), 0.25);
    const current = Math.min(Math.max(Number(slider.value || 0), 0), Math.max(activeEvents.length - 1, 0));
    const timelineNow = Number(eventTimelineMs[current] || 0);

    playbackState = {
      speed,
      startPerf: performance.now(),
      startVirtualMs: timelineNow,
      currentIndex: current
    };

    playPauseButton.textContent = 'Pause';

    const tick = (perfNow) => {
      if (!playbackState) return;
      const elapsedPerf = Math.max(0, perfNow - playbackState.startPerf);
      const targetVirtualMs = playbackState.startVirtualMs + (elapsedPerf * playbackState.speed);
      const nextIndex = findTimelineIndexForVirtualMs(targetVirtualMs);
      if (nextIndex !== playbackState.currentIndex) {
        playbackState.currentIndex = nextIndex;
        slider.value = String(nextIndex);
        renderCurrent();
      }
      if (nextIndex >= activeEvents.length - 1) {
        stopPlayback();
        return;
      }
      playbackRaf = requestAnimationFrame(tick);
    };

    playbackRaf = requestAnimationFrame(tick);
  }

  function applySpecSelection(key, keepPosition) {
    const selectedKey = key || '__all__';
    activeSpecKey = selectedKey;
    activeEvents = eventsForSpec(selectedKey);
    if (!activeEvents.length) activeEvents = allEvents.slice();

    activeVideo = pickVideoForSpec(selectedKey);
    if (visualMode === 'video' && !activeVideo) {
      visualMode = 'dom';
      if (visualSourceSelect) visualSourceSelect.value = 'dom';
    }

    slider.max = String(Math.max(0, activeEvents.length - 1));
    if (keepPosition) {
      const currentValue = Number(slider.value || 0);
      slider.value = String(Math.min(Math.max(currentValue, 0), Math.max(activeEvents.length - 1, 0)));
    } else {
      slider.value = String(findDefaultStepIndex(activeEvents));
    }

    if (specSelect.value !== selectedKey) specSelect.value = selectedKey;
    eventTimelineMs = buildEventTimeline(activeEvents);
    markerEntries = buildMarkerEntries(activeEvents);
    hydrateMarkerSelector();
    renderReplayDiagnostics();
    stopPlayback();
    renderList();
    renderCurrent();
  }

  try {
    hydrateSpecSelector();

    const defaultSpecKey = specOptions.length > 1 ? specOptions[1].key : '__all__';

    specSelect.addEventListener('change', () => applySpecSelection(specSelect.value || '__all__', false));
    slider.addEventListener('input', () => { stopPlayback(); renderCurrent(); });

    prevButton.addEventListener('click', () => {
      stopPlayback();
      const current = Number(slider.value || 0);
      slider.value = String(Math.max(current - 1, 0));
      renderCurrent();
    });

    nextButton.addEventListener('click', () => {
      stopPlayback();
      const current = Number(slider.value || 0);
      slider.value = String(Math.min(current + 1, Math.max(activeEvents.length - 1, 0)));
      renderCurrent();
    });

    playPauseButton.addEventListener('click', () => {
      if (playbackState) {
        stopPlayback();
        return;
      }
      startVirtualPlayback();
    });

    speedSelect.addEventListener('change', () => {
      if (playbackState) startVirtualPlayback();
    });

    if (markerSelect) {
      markerSelect.addEventListener('change', () => {
        const markerIndex = Math.min(Math.max(Number(markerSelect.value || 0), 0), Math.max(activeEvents.length - 1, 0));
        stopPlayback();
        slider.value = String(markerIndex);
        renderCurrent();
      });
    }

    if (markerPrevButton) markerPrevButton.addEventListener('click', () => jumpToMarker(-1));
    if (markerNextButton) markerNextButton.addEventListener('click', () => jumpToMarker(1));

    if (visualSourceSelect) {
      visualSourceSelect.addEventListener('change', () => {
        const nextMode = String(visualSourceSelect.value || 'dom');
        if (nextMode === 'video' && !activeVideo) {
          visualMode = 'dom';
          visualSourceSelect.value = 'dom';
        } else {
          visualMode = nextMode;
        }
        renderCurrent();
      });
    }

    const setModalOpen = (next) => {
      if (!replayShell || !modalToggleButton) return;
      modalOpen = Boolean(next);
      replayShell.classList.toggle('is-modal-open', modalOpen);
      document.body.classList.toggle('replay-modal-open', modalOpen);
      modalToggleButton.textContent = modalOpen ? 'Close focus' : 'Focus mode';
      window.requestAnimationFrame(() => fitFrameToStage(currentViewport));
    };

    if (modalToggleButton && replayShell) {
      modalToggleButton.addEventListener('click', () => {
        setModalOpen(!modalOpen);
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modalOpen) setModalOpen(false);
    });

    window.addEventListener('resize', () => {
      window.requestAnimationFrame(() => fitFrameToStage(currentViewport));
    });

    applySpecSelection(defaultSpecKey, false);
  } catch (error) {
    const errMsg = error && error.message ? error.message : String(error);
    consoleNode.textContent = 'Replay render error: ' + errMsg;
    networkNode.textContent = 'Replay render error: ' + errMsg;
    runnerNode.textContent = 'Replay render error: ' + errMsg;
    title.textContent = 'Replay render error';
  }
}

function boot() {
  initJsonForms();
  initReplayPage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
