const transcriptList = document.getElementById('transcript-list');
const statusEl = document.getElementById('status');
const screenshotImg = document.getElementById('screenshot');
const boundsOverlay = document.getElementById('bounds-overlay');
const treeOutput = document.getElementById('tree-output');
const screenStamp = document.getElementById('screen-stamp');
const recordBtn = document.getElementById('record-btn');
const recordingStats = document.getElementById('recording-stats');
const metadataModal = document.getElementById('metadata-modal');
const metaParticipant = document.getElementById('meta-participant');
const metaApp = document.getElementById('meta-app');
const metaSession = document.getElementById('meta-session');
const metaTask = document.getElementById('meta-task');
const metaCancel = document.getElementById('meta-cancel');
const metaSubmit = document.getElementById('meta-submit');
const appHistoryList = document.getElementById('app-history-list');
const modalSummary = document.getElementById('modal-summary');

// `latestBounds` = freshest bounds payload from SSE (updates immediately).
// `currentBounds` = bounds paired with the currently displayed screenshot
//                   (only swapped in when a new screenshot finishes decoding,
//                   so the red rect can't drift onto an outdated screen).
let latestBounds = null;
let currentBounds = null;
let screenshotNaturalSize = { w: 0, h: 0 };
let focusCaptureTimer = null;
// Tiny debounce just to coalesce a burst of bounds events into one fetch.
// Each fetch is JPEG-encoded server-side so completes in a few hundred ms;
// queue-depth=1 below prevents pile-up while still giving frequent updates.
const FOCUS_CAPTURE_DEBOUNCE_MS = 50;
let refreshInFlight = false;
let refreshPending = false;
let lastCommittedRefreshAt = 0;
let recording = false;
let recordingStatsTimer = null;
let sessionEditedByUser = false;

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

// --- Event aggregator (mirrors server/recording.js grouping) ---
//
// Combines speech/bounds/action/gesture/click/text_change SSE events into one
// transcript card per logical event, matching what lands in the jsonl.

const ACTION_TO_EVENT_TYPE = {
  ACTION_SWIPE_LEFT: 'swipe left',
  ACTION_SWIPE_RIGHT: 'swipe right',
  ACTION_SWIPE_UP: 'swipe up',
  ACTION_SWIPE_DOWN: 'swipe down',
  ACTION_CLICK: 'tap',
  ACTION_LONG_CLICK: 'long_tap',
  ACTION_BACK: 'back',
};

let pendingEvent = null;
let pendingFlushTimer = null;
let lastAction = null;            // { type, at } — kept across wrap so the
                                  // wrap card and the focus that follows
                                  // share the same event_type.
// Adaptive debounce: mirrors server/recording.js so the live transcript
// finalizes its card on roughly the same timing as the recorded event.
const PENDING_FLUSH_INITIAL_MS = 600;
const PENDING_FLUSH_AFTER_SPEECH_MS = 800;
const PENDING_FLUSH_AFTER_HINT_MS = 200;
const PENDING_FLUSH_AFTER_WRAP_MS = 200;
const NO_FEEDBACK_SENTINEL = '<no_feedback>';
const WRAP_SENTINEL = '<wrap>';

function startPendingFocus({ timestamp, announcementOnly }) {
  pendingEvent = {
    timestamp,
    announcements: [],
    hints: [],
    eventType: announcementOnly
      ? 'announcement'
      : resolveEventType(lastAction),
    rect: null,
    resourceId: null,
    className: null,
    announcementOnly: !!announcementOnly,
  };
  if (lastAction) lastAction = null;
}

function resolveEventType(action) {
  if (!action) return null;
  const t = action.type;
  return ACTION_TO_EVENT_TYPE[t] || t.replace(/^ACTION_/, '').toLowerCase();
}

function schedulePendingFlush(delayMs = PENDING_FLUSH_INITIAL_MS) {
  if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null;
    flushPendingEvent();
  }, delayMs);
}

function flushPendingEvent() {
  if (!pendingEvent) return;
  const ev = pendingEvent;
  pendingEvent = null;
  // Was an action's event_type set? Need this BEFORE we default to 'focus'.
  const hasActionType = !!ev.eventType;

  // Flatten hints after speech so the rendered bullets read speech then hint
  // even though TalkBack emitted the hint first.
  const speech = ev.announcements || [];
  const hints = ev.hints || [];
  ev.announcements = [...speech, ...hints];
  const hasSpeech = ev.announcements.length > 0;

  if (!hasSpeech && !ev.announcementOnly) {
    if (!hasActionType) return;  // Passive focus, no speech — drop entirely.
    // Action triggered, but TalkBack said nothing. Render a single card
    // typed by the action with <no_feedback> as the content — NO separate
    // empty focus card.
    renderEvent({
      timestamp: ev.timestamp,
      eventType: ev.eventType,
      announcements: [NO_FEEDBACK_SENTINEL],
      rect: ev.rect,
      resourceId: ev.resourceId,
      className: ev.className,
    });
    return;
  }

  if (!ev.eventType) ev.eventType = 'focus';
  renderEvent(ev);
}

function noteAction(actionType, ts) {
  // Stale lastAction (older than 2s) is dropped — matches server logic.
  lastAction = { type: actionType, at: ts || Date.now() };
}

function handleSpeech(speech, ts, opts = {}) {
  const trimmed = (speech || '').trim();
  if (!trimmed) return;
  if (!pendingEvent) {
    startPendingFocus({ timestamp: ts, announcementOnly: true });
  }
  if (opts.isHint) {
    if (!pendingEvent.hints) pendingEvent.hints = [];
    pendingEvent.hints.push(trimmed);
    schedulePendingFlush(PENDING_FLUSH_AFTER_HINT_MS);
  } else {
    pendingEvent.announcements.push(trimmed);
    schedulePendingFlush(PENDING_FLUSH_AFTER_SPEECH_MS);
  }
}

function handleWrap(ts) {
  // Render immediately as its own card. event_type is the triggering action
  // (gesture/click/ADB) — without consuming lastAction so the focus event
  // that follows shares the same event_type.
  const eventType = resolveEventType(lastAction) || 'swipe right';
  renderEvent({
    timestamp: ts || Date.now(),
    eventType,
    announcements: [WRAP_SENTINEL],
    rect: latestBounds && latestBounds.rect,
    resourceId: latestBounds && latestBounds.resourceId,
    className: latestBounds && latestBounds.className,
  });
  // If a pendingFocus is mid-build, nudge its debounce shorter — wrap is a
  // "we're done navigating" signal.
  if (pendingEvent) schedulePendingFlush(PENDING_FLUSH_AFTER_WRAP_MS);
}

function handleBounds(bounds) {
  const now = bounds.timestamp || Date.now();
  if (!pendingEvent) {
    startPendingFocus({ timestamp: now, announcementOnly: false });
  } else if (pendingEvent.announcementOnly) {
    pendingEvent.announcementOnly = false;
    pendingEvent.eventType = resolveEventType(lastAction);
    if (lastAction) lastAction = null;
  } else {
    // New bounds during transition — drop transient speech.
    pendingEvent.announcements = [];
  }
  pendingEvent.timestamp = now;
  pendingEvent.rect = bounds.rect;
  pendingEvent.resourceId = bounds.resourceId;
  pendingEvent.className = bounds.className;
  schedulePendingFlush(PENDING_FLUSH_INITIAL_MS);
}

function handleTextChange(data) {
  // Type events are self-contained — flush whatever is pending first, then
  // render the type event immediately.
  flushPendingEvent();
  renderEvent({
    timestamp: data.timestamp,
    eventType: 'type',
    announcements: data.text ? [data.text] : [],
    rect: null,
    resourceId: data.resourceId,
    className: data.className,
  });
}

function renderEvent(ev) {
  const li = document.createElement('li');
  li.className = 'event-card';

  const header = document.createElement('div');
  header.className = 'event-header';

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(ev.timestamp);
  header.appendChild(ts);

  const type = document.createElement('span');
  type.className = `event-type type-${(ev.eventType || 'focus').replace(/\W+/g, '-')}`;
  type.textContent = ev.eventType || 'focus';
  header.appendChild(type);

  if (ev.className) {
    const cls = document.createElement('span');
    cls.className = 'event-class';
    cls.textContent = String(ev.className).split('.').pop();
    header.appendChild(cls);
  }

  li.appendChild(header);

  if (ev.announcements && ev.announcements.length) {
    const list = document.createElement('ul');
    list.className = 'announcement-list';
    for (const a of ev.announcements) {
      const item = document.createElement('li');
      item.textContent = a;
      list.appendChild(item);
    }
    li.appendChild(list);
  }

  transcriptList.prepend(li);
  while (transcriptList.children.length > 200) {
    transcriptList.removeChild(transcriptList.lastChild);
  }
}

function updateBoundsOverlay() {
  if (!currentBounds || !currentBounds.rect || !screenshotNaturalSize.w) {
    boundsOverlay.style.display = 'none';
    return;
  }
  const { rect } = currentBounds;
  const rendered = screenshotImg.getBoundingClientRect();
  const stage = document.getElementById('screen-stage').getBoundingClientRect();
  const scaleX = rendered.width / screenshotNaturalSize.w;
  const scaleY = rendered.height / screenshotNaturalSize.h;
  boundsOverlay.style.display = 'block';
  boundsOverlay.style.left = ((rendered.left - stage.left) + rect.left * scaleX) + 'px';
  boundsOverlay.style.top = ((rendered.top - stage.top) + rect.top * scaleY) + 'px';
  boundsOverlay.style.width = ((rect.right - rect.left) * scaleX) + 'px';
  boundsOverlay.style.height = ((rect.bottom - rect.top) * scaleY) + 'px';
}

function fmtClock(date) {
  return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' +
    String(date.getMilliseconds()).padStart(3, '0');
}

async function refreshScreenshot({ isManual = false } = {}) {
  // Queue depth of 1: if a refresh is already in flight, mark "pending"
  // so we kick off one more after it completes — and then stop. Avoids
  // piling up screenshot requests when the user is interacting rapidly.
  if (refreshInFlight) {
    refreshPending = true;
    return;
  }
  refreshInFlight = true;
  const requestedAt = Date.now();
  const boundsAtCapture = latestBounds;
  const stale = () => !isManual && requestedAt < lastCommittedRefreshAt;
  const t0 = performance.now();
  try {
    const res = await fetch('/api/screenshot?t=' + requestedAt);
    const t1 = performance.now();
    console.log('[refresh] fetch ok status=', res.status, 'took(ms)=', Math.round(t1 - t0));
    if (stale()) return;
    if (!res.ok) {
      screenStamp.classList.add('stale');
      screenStamp.textContent = `screenshot ${res.status}`;
      return;
    }
    const blob = await res.blob();
    if (stale()) return;
    const url = URL.createObjectURL(blob);
    const prev = screenshotImg.dataset.objUrl;
    screenshotImg.src = url;
    screenshotImg.dataset.objUrl = url;
    if (prev) URL.revokeObjectURL(prev);
    try {
      // Wait until the new bitmap is decoded so a layout/paint with the new
      // image and the snapshotted bounds happen together.
      await screenshotImg.decode();
    } catch (_) {}
    if (stale()) return;
    lastCommittedRefreshAt = requestedAt;
    screenshotNaturalSize = {
      w: screenshotImg.naturalWidth,
      h: screenshotImg.naturalHeight,
    };
    currentBounds = boundsAtCapture;
    updateBoundsOverlay();
    const tEnd = performance.now();
    console.log('[refresh] committed total(ms)=', Math.round(tEnd - t0));
    screenStamp.classList.remove('stale');
    screenStamp.textContent = `captured ${fmtClock(new Date())}`;
  } catch (e) {
    screenStamp.classList.add('stale');
    screenStamp.textContent = `screenshot error: ${e.message}`;
  } finally {
    refreshInFlight = false;
    if (refreshPending) {
      refreshPending = false;
      // Kick the queued refresh — it'll use whatever latestBounds is
      // current at the moment it starts.
      refreshScreenshot();
    }
  }
}

async function refreshTree() {
  try {
    const res = await fetch('/api/tree?full=true');
    if (!res.ok) return;
    const data = await res.json();
    treeOutput.textContent = JSON.stringify(data, null, 2);
  } catch (_) {}
}

/**
 * Debounced screenshot + tree pull when accessibility focus moves. Each
 * incoming bounds event resets the 500ms timer; we only fetch after the
 * focus has been quiet long enough that the new screen is settled.
 */
function scheduleFocusCapture() {
  // 50 ms debounce just to coalesce a tight burst into one fetch. The actual
  // throttling lives in refreshScreenshot's queue-depth=1: any bounds events
  // that arrive while a fetch is in flight set refreshPending=true and
  // automatically trigger one more refresh after the current one lands.
  if (focusCaptureTimer) clearTimeout(focusCaptureTimer);
  screenStamp.classList.add('stale');
  screenStamp.textContent = 'capturing…';
  focusCaptureTimer = setTimeout(() => {
    focusCaptureTimer = null;
    refreshScreenshot();
    refreshTree();
  }, FOCUS_CAPTURE_DEBOUNCE_MS);
}

screenshotImg.addEventListener('load', () => {
  screenshotNaturalSize = { w: screenshotImg.naturalWidth, h: screenshotImg.naturalHeight };
  updateBoundsOverlay();
});
window.addEventListener('resize', updateBoundsOverlay);

// --- Tap / swipe pass-through from the screenshot ---
//
// Pointer events on the <img> are translated into device coordinates and
// forwarded to mobilerun's tap/swipe JSON-RPC via /api/gesture. Drags shorter
// than ~12 px are treated as taps.

const SWIPE_THRESHOLD_PX = 12;
let pointerDown = null;

function screenshotCoords(clientX, clientY) {
  if (!screenshotNaturalSize.w || !screenshotNaturalSize.h) return null;
  const rect = screenshotImg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.round(((clientX - rect.left) / rect.width) * screenshotNaturalSize.w);
  const y = Math.round(((clientY - rect.top) / rect.height) * screenshotNaturalSize.h);
  return { x, y };
}

screenshotImg.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  pointerDown = {
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    at: Date.now(),
  };
  try { screenshotImg.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});

screenshotImg.addEventListener('pointerup', async (e) => {
  if (!pointerDown || pointerDown.pointerId !== e.pointerId) return;
  const start = pointerDown;
  pointerDown = null;
  try { screenshotImg.releasePointerCapture(e.pointerId); } catch (_) {}

  const dx = e.clientX - start.clientX;
  const dy = e.clientY - start.clientY;
  const dist = Math.hypot(dx, dy);

  if (dist < SWIPE_THRESHOLD_PX) {
    const p = screenshotCoords(e.clientX, e.clientY);
    if (!p) return;
    await fetch('/api/gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tap', x: p.x, y: p.y }),
    });
  } else {
    const a = screenshotCoords(start.clientX, start.clientY);
    const b = screenshotCoords(e.clientX, e.clientY);
    if (!a || !b) return;
    const durationMs = Math.max(120, Math.min(1500, Date.now() - start.at));
    await fetch('/api/gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'swipe',
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        durationMs,
      }),
    });
  }
});

screenshotImg.addEventListener('pointercancel', () => { pointerDown = null; });
screenshotImg.addEventListener('dragstart', (e) => e.preventDefault());

document.getElementById('refresh-screenshot').addEventListener('click', async () => {
  // Run all three in parallel: the upstream fetches coalesce on the server, so
  // we don't make duplicate mobilerun requests. The manual flag makes the
  // refresh bypass the epoch-stale check (the user explicitly asked for it).
  await Promise.all([
    refreshScreenshot({ isManual: true }),
    refreshTree(),
    recording ? fetch('/api/recording/capture', { method: 'POST' }).catch(() => {}) : null,
  ]);
});

function clearTranscript() {
  transcriptList.innerHTML = '';
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = null;
  }
  pendingEvent = null;
}

document.getElementById('clear-transcript').addEventListener('click', clearTranscript);

document.querySelectorAll('button[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    fetch('/api/talkback-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: btn.dataset.action }),
    });
  });
});

document.getElementById('say-button').addEventListener('click', () => {
  const text = document.getElementById('say-input').value.trim();
  if (!text) return;
  fetch('/api/talkback-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ACTION_SAY', params: { PARAMETER_TEXT: text } }),
  });
});


function connectStream() {
  const source = new EventSource('/api/transcript/stream');
  source.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    statusEl.textContent = 'connected';
    // Start fresh on every page load — do NOT replay historical entries
    // from the server's transcript buffer. Only carry over the current
    // bounds so the overlay rectangle has somewhere to land while we wait
    // for the first live event.
    transcriptList.innerHTML = '';
    if (data.bounds) {
      latestBounds = data.bounds;
      currentBounds = data.bounds;
      updateBoundsOverlay();
    }
  });
  source.addEventListener('entry', (e) => {
    const entry = JSON.parse(e.data);
    if (entry.subtype === 'speech') handleSpeech(entry.speech, entry.timestamp);
    else if (entry.subtype === 'hint') handleSpeech(entry.speech, entry.timestamp, { isHint: true });
    else if (entry.subtype === 'wrap') handleWrap(entry.timestamp);
  });
  source.addEventListener('bounds', (e) => {
    const bounds = JSON.parse(e.data);
    const phoneTs = bounds.timestamp || 0;
    const arrivedAt = Date.now();
    const transit = phoneTs ? arrivedAt - phoneTs : null;
    console.log(
      '[bounds]',
      'phoneTs=', phoneTs ? new Date(phoneTs).toISOString() : '-',
      'arrivedAt=', new Date(arrivedAt).toISOString(),
      'transit(ms)=', transit,
    );
    latestBounds = bounds;
    handleBounds(bounds);
    scheduleFocusCapture();
  });
  source.addEventListener('action', (e) => {
    const data = JSON.parse(e.data);
    noteAction(data.action, data.timestamp);
  });
  source.addEventListener('gesture', (e) => {
    const data = JSON.parse(e.data);
    noteAction(data.gesture, data.timestamp);
  });
  source.addEventListener('click', (e) => {
    const data = JSON.parse(e.data);
    noteAction(data.long ? 'long_tap' : 'tap', data.timestamp);
  });
  source.addEventListener('text_change', (e) => {
    handleTextChange(JSON.parse(e.data));
  });
  source.addEventListener('view_scrolled', () => {
    scheduleFocusCapture();
  });
  source.onerror = () => {
    statusEl.textContent = 'reconnecting…';
  };
}

refreshScreenshot();
refreshTree();
connectStream();

// ---------- Recording ----------

function setRecordingState(active) {
  recording = active;
  if (active) {
    recordBtn.textContent = '■ Stop';
    recordBtn.classList.add('recording');
    pollRecordingStats();
  } else {
    recordBtn.textContent = '● Record';
    recordBtn.classList.remove('recording');
    recordingStats.textContent = '';
    if (recordingStatsTimer) {
      clearInterval(recordingStatsTimer);
      recordingStatsTimer = null;
    }
  }
}

async function pollRecordingStats() {
  if (recordingStatsTimer) clearInterval(recordingStatsTimer);
  const update = async () => {
    try {
      const res = await fetch('/api/recording/status');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.active) {
        setRecordingState(false);
        return;
      }
      const seconds = Math.floor((Date.now() - data.startTime) / 1000);
      recordingStats.textContent = `${seconds}s · ${data.eventCount} events · ${data.captureCount} captures`;
    } catch (_) {}
  };
  update();
  recordingStatsTimer = setInterval(update, 1000);
}

async function loadAppHistory() {
  try {
    const res = await fetch('/api/recording/apps');
    if (!res.ok) return;
    const data = await res.json();
    appHistoryList.innerHTML = '';
    (data.apps || []).forEach((app) => {
      const opt = document.createElement('option');
      opt.value = app;
      appHistoryList.appendChild(opt);
    });
  } catch (_) {}
}

function openMetadataModal({ eventCount, captureCount }) {
  modalSummary.textContent = `${eventCount} events, ${captureCount} captures pending finalize.`;
  metaParticipant.value = '';
  metaTask.value = '';
  metaApp.value = '';
  metaSession.value = '';
  sessionEditedByUser = false;
  loadAppHistory();
  metadataModal.classList.remove('modal-hidden');
  metadataModal.removeAttribute('hidden');
  metadataModal.style.display = 'flex';
  setTimeout(() => metaParticipant.focus(), 30);
}

function closeMetadataModal() {
  metadataModal.classList.add('modal-hidden');
  metadataModal.setAttribute('hidden', '');
  metadataModal.style.display = 'none';
}

// Auto-prefill session_id with app_id unless the user has typed in it.
metaApp.addEventListener('input', () => {
  if (!sessionEditedByUser) {
    metaSession.value = metaApp.value;
  }
});
metaSession.addEventListener('input', () => {
  sessionEditedByUser = true;
});

recordBtn.addEventListener('click', async () => {
  if (!recording) {
    try {
      const res = await fetch('/api/recording/start', { method: 'POST' });
      if (!res.ok) throw new Error('start failed');
      // Start with a fresh transcript so the recording timeline isn't
      // confused with whatever was on screen before.
      clearTranscript();
      setRecordingState(true);
    } catch (e) {
      alert('Failed to start recording: ' + e.message);
    }
  } else {
    try {
      const res = await fetch('/api/recording/stop', { method: 'POST' });
      if (!res.ok) throw new Error('stop failed');
      const data = await res.json();
      setRecordingState(false);
      openMetadataModal(data);
    } catch (e) {
      alert('Failed to stop recording: ' + e.message);
    }
  }
});

metaCancel.addEventListener('click', async () => {
  if (!confirm('Discard this recording? Captured data will be deleted.')) return;
  try { await fetch('/api/recording/cancel', { method: 'POST' }); } catch (_) {}
  closeMetadataModal();
});

metaSubmit.addEventListener('click', async () => {
  const participant = metaParticipant.value.trim();
  const appId = metaApp.value.trim();
  const sessionId = metaSession.value.trim() || appId;
  const task = metaTask.value.trim();
  if (!participant || !appId || !sessionId) {
    alert('Participant ID, App ID and Session ID are required.');
    return;
  }
  metaSubmit.disabled = true;
  metaSubmit.textContent = 'Packaging…';
  try {
    const res = await fetch('/api/recording/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participant,
        app_id: appId,
        session_id: sessionId,
        task,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording_${safe(participant)}_${safe(appId)}_${safe(sessionId)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    closeMetadataModal();
  } catch (e) {
    alert('Finalize failed: ' + e.message);
  } finally {
    metaSubmit.disabled = false;
    metaSubmit.textContent = 'Download zip';
  }
});

// Reconcile state with server on load (e.g., page reload mid-recording).
(async function initRecordingState() {
  try {
    const res = await fetch('/api/recording/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.active) {
      setRecordingState(true);
    } else if (data.hasPending) {
      openMetadataModal({
        eventCount: data.pendingEventCount,
        captureCount: data.pendingCaptureCount,
      });
    }
  } catch (_) {}
})();
