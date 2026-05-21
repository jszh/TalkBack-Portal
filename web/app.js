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
// `currentBounds` = bounds currently drawn by the overlay. Driven by the
//                   bounds SSE handler, NOT by the screenshot refresh — that
//                   way fast-swipe bursts can't leave the rect parked on a
//                   stale focus when the final screenshot's refresh started
//                   before the final bounds had arrived.
let latestBounds = null;
let currentBounds = null;
let screenshotNaturalSize = { w: 0, h: 0 };
let focusCaptureTimer = null;
// Best-effort live view: kick a fetch on the same JS tick that the bounds
// SSE arrives. Queue-depth=1 in refreshScreenshot (refreshInFlight +
// refreshPending) caps in-flight to 1 with at most 1 queued, so dropping
// the debounce can't cascade into a fetch storm.
const FOCUS_CAPTURE_DEBOUNCE_MS = 0;
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
  // Actions are rendered as their own cards now (see renderActionCard), so we
  // no longer merge the triggering action's name into the focus card's
  // event_type. Focus cards are always "focus" (or "announcement" for
  // free-floating speech).
  // The action_index is consumed at flush time, NOT here. Why: for
  // /api/gesture taps and phone-initiated touches, the 'click'/'gesture' SSE
  // carrying the index arrives AFTER the bounds SSE for the new focus
  // (TalkBack detects the focus change before it finishes processing the
  // click). Deferring consume to flush gives the SSE the full debounce
  // window (~600ms) to arrive and populate the queue. If it still hasn't
  // arrived by flush, the rendered focus card is pushed onto
  // untaggedFocuses for retroactive tagging when the SSE eventually lands.
  pendingEvent = {
    timestamp,
    announcements: [],
    hints: [],
    eventType: announcementOnly ? 'announcement' : 'focus',
    actionDetails: '',
    rect: null,
    resourceId: null,
    className: null,
    announcementOnly: !!announcementOnly,
    actionIndex: null,
  };
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

  // Flatten hints after speech so the rendered bullets read speech then hint
  // even though TalkBack emitted the hint first.
  const speech = ev.announcements || [];
  const hints = ev.hints || [];
  ev.announcements = [...speech, ...hints];
  const hasSpeech = ev.announcements.length > 0;

  // Action cards stand alone now, so a focus event with no speech is just
  // noise — drop it instead of rendering an empty card.
  if (!hasSpeech) return;

  // Late consume: a real focus pairs with the oldest pending action index.
  // Doing it here rather than at startPendingFocus lets the click/gesture
  // SSE arrive during the debounce window and populate the queue first.
  if (!ev.announcementOnly && ev.actionIndex == null) {
    ev.actionIndex = consumeNextActionIndex();
  }
  const li = renderEvent(ev);

  // Still no index? Register for retroactive tagging — a click/gesture SSE
  // arriving past the debounce window will tag the oldest untagged focus.
  if (li && !ev.announcementOnly && ev.actionIndex == null) {
    const indexSpan = li.querySelector('.broadcast-index');
    if (indexSpan) {
      untaggedFocuses.push({ indexSpan, at: Date.now() });
      const cutoff = Date.now() - UNTAGGED_FOCUS_TTL_MS;
      while (untaggedFocuses.length && untaggedFocuses[0].at < cutoff) {
        untaggedFocuses.shift();
      }
    }
  }
}

// Focus cards that flushed without an action_index (queue was empty at flush
// time because the click/gesture SSE was still in flight). When the SSE
// finally arrives, tagRetroactiveFocus pops the oldest entry and fills in
// its #N label.
const untaggedFocuses = [];
const UNTAGGED_FOCUS_TTL_MS = 5000;

function tagRetroactiveFocus(actionIndex) {
  if (actionIndex == null) return false;
  const cutoff = Date.now() - UNTAGGED_FOCUS_TTL_MS;
  while (untaggedFocuses.length && untaggedFocuses[0].at < cutoff) {
    untaggedFocuses.shift();
  }
  const head = untaggedFocuses.shift();
  if (!head) return false;
  head.indexSpan.textContent = `#${actionIndex}`;
  head.indexSpan.hidden = false;
  return true;
}

function noteAction(actionType, ts, details) {
  // Stale lastAction (older than 2s) is dropped — matches server logic.
  // When the caller doesn't supply details (typical for SSE echoes from the
  // server), preserve recent details we already set locally — otherwise the
  // SSE round-trip clobbers the params we captured at dispatch time.
  let keep = null;
  if (details === undefined && lastAction && lastAction.details) {
    const age = Date.now() - lastAction.at;
    if (age >= 0 && age < 2000) keep = lastAction.details;
  }
  lastAction = {
    type: actionType,
    at: ts || Date.now(),
    details: details !== undefined ? details : keep,
  };
}

// FIFO queue of action indices learned from SSE — both 'action' (ADB
// broadcast) and 'gesture'/'click' SSEs that arrive without from_broadcast
// (phone-initiated). Each entry is {index, verb, at}. Consumed in order by
// startPendingFocus and peeked by handleWrap.
const pendingActionIndices = [];
const ACTION_INDEX_TTL_MS = 5000;

function trimActionIndexQueue(now) {
  const cutoff = now - ACTION_INDEX_TTL_MS;
  while (pendingActionIndices.length && pendingActionIndices[0].at < cutoff) {
    pendingActionIndices.shift();
  }
}

function enqueueActionIndex(actionType, actionIndex) {
  if (actionIndex == null) return;
  const now = Date.now();
  trimActionIndexQueue(now);
  pendingActionIndices.push({ index: actionIndex, verb: friendlyVerb(actionType), at: now });
}

function consumeNextActionIndex() {
  trimActionIndexQueue(Date.now());
  const head = pendingActionIndices.shift();
  return head ? head.index : null;
}

// Called from dispatch sites in the browser (auto-crawl, toolbar buttons,
// screenshot pointerup) — renders an immediate action card and marks a recent
// local-dispatch timestamp so the SSE echo of the same action (which arrives
// a moment later with no details) doesn't render a duplicate card.
let lastLocalUserActionAt = 0;
const SSE_ACTION_DEDUPE_MS = 1500;

function noteUserAction(row) {
  if (!row || !row.action) return;
  const talkbackName = AUTOCRAWL_VERB_TO_TALKBACK[row.action] || row.action;
  const details = { ...row };
  flushPendingEvent();
  noteAction(talkbackName, Date.now(), details);
  renderActionCard(talkbackName, details, Date.now());
  lastLocalUserActionAt = Date.now();
}

const TALKBACK_TO_FRIENDLY_VERB = {
  ACTION_SWIPE_LEFT: 'swipe left',
  ACTION_SWIPE_RIGHT: 'swipe right',
  ACTION_SWIPE_UP: 'swipe up',
  ACTION_SWIPE_DOWN: 'swipe down',
  ACTION_CLICK: 'tap',
  ACTION_LONG_CLICK: 'long_tap',
  ACTION_BACK: 'back',
  ACTION_HOME: 'home',
  ACTION_SAY: 'say',
};

function friendlyVerb(actionType) {
  if (!actionType) return 'action';
  return TALKBACK_TO_FRIENDLY_VERB[actionType]
    || actionType.replace(/^ACTION_/, '').toLowerCase();
}

// Action cards rendered locally (by noteUserAction) get their `#N` label
// populated when the matching SSE arrives carrying action_index. We track
// recent action cards here keyed by their friendly verb so
// tagActionCardWithIndex can find them.
const pendingActionCards = [];
const PENDING_ACTION_CARD_TTL_MS = 5000;

function renderActionCard(actionType, details, ts, actionIndex) {
  const eventType = friendlyVerb(actionType);
  const li = renderEvent({
    timestamp: ts || Date.now(),
    eventType,
    actionDetails: details ? formatActionDetails(details) : '',
    announcements: [],
    rect: null,
    resourceId: null,
    className: null,
    actionIndex: actionIndex != null ? actionIndex : null,
  });
  // Already tagged? Done.
  if (actionIndex != null || !li) return;
  // Find the #N span renderEvent created so we can fill it in later.
  const indexSpan = li.querySelector('.broadcast-index');
  if (!indexSpan) return;
  pendingActionCards.push({ verb: eventType, indexSpan, at: Date.now() });
  // Trim — keep the deque bounded.
  const cutoff = Date.now() - PENDING_ACTION_CARD_TTL_MS;
  while (pendingActionCards.length && pendingActionCards[0].at < cutoff) {
    pendingActionCards.shift();
  }
}

function tagActionCardWithIndex(actionType, actionIndex) {
  if (actionIndex == null) return;
  const verb = friendlyVerb(actionType);
  // Scan FORWARD (oldest pending card first) so two browser-dispatched
  // actions in quick succession get paired with their indices in the order
  // they were dispatched, not in reverse.
  for (let i = 0; i < pendingActionCards.length; i++) {
    const p = pendingActionCards[i];
    if (p.verb === verb) {
      p.indexSpan.textContent = `#${actionIndex}`;
      p.indexSpan.hidden = false;
      pendingActionCards.splice(i, 1);
      return;
    }
  }
}

function shouldRenderEchoedAction() {
  // SSE echoes from server-detected actions are rendered only when no local
  // browser dispatch just happened — otherwise we'd duplicate the card we
  // already drew from noteUserAction.
  return Date.now() - lastLocalUserActionAt > SSE_ACTION_DEDUPE_MS;
}

const AUTOCRAWL_VERB_TO_TALKBACK = {
  tap: 'tap',
  swipe: 'swipe',
  swipe_left: 'ACTION_SWIPE_LEFT',
  swipe_right: 'ACTION_SWIPE_RIGHT',
  swipe_up: 'ACTION_SWIPE_UP',
  swipe_down: 'ACTION_SWIPE_DOWN',
  click: 'ACTION_CLICK',
  long_click: 'ACTION_LONG_CLICK',
  back: 'ACTION_BACK',
  home: 'ACTION_HOME',
  say: 'ACTION_SAY',
};

function formatActionLabel(row) {
  if (!row || !row.action) return '';
  const a = row.action;
  if (a === 'tap') return `tap (${row.x}, ${row.y})`;
  if (a === 'swipe') {
    const dur = Number.isFinite(row.durationMs) ? ` ${row.durationMs}ms` : '';
    return `swipe (${row.x1},${row.y1}→${row.x2},${row.y2})${dur}`;
  }
  if (a === 'wait') {
    return Number.isFinite(row.seconds) ? `wait ${row.seconds}s` : 'wait (until resume)';
  }
  if (a === 'say' && row.text) return `say "${row.text}"`;
  return a.replace(/_/g, ' ');
}

function formatActionDetails(row) {
  // Just the params part of formatActionLabel — used next to the event-type
  // tag in transcript cards. We rely on the tag itself for the verb.
  if (!row || !row.action) return '';
  const a = row.action;
  if (a === 'tap') return `(${row.x}, ${row.y})`;
  if (a === 'swipe') {
    const dur = Number.isFinite(row.durationMs) ? ` ${row.durationMs}ms` : '';
    return `(${row.x1},${row.y1}→${row.x2},${row.y2})${dur}`;
  }
  if (a === 'say' && row.text) return `"${row.text}"`;
  return '';
}

function handleSpeech(speech, ts, opts = {}) {
  const trimmed = (speech || '').trim();
  if (!trimmed) return;
  if (!opts.isHint) onTapSettleSpeechHeard();
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
  // Render immediately as its own card. Triggering-action context comes from
  // the action card that precedes it — don't merge the verb into wrap.
  // Consume the queue head — wrap is the terminal event for this action
  // (TalkBack tried to navigate but couldn't, so no follow-up focus is
  // coming). If we only peeked, the stale entry would still be at the
  // queue head and a later unrelated focus event would pick it up.
  renderEvent({
    timestamp: ts || Date.now(),
    eventType: 'wrap',
    actionDetails: '',
    announcements: [WRAP_SENTINEL],
    rect: latestBounds && latestBounds.rect,
    resourceId: latestBounds && latestBounds.resourceId,
    className: latestBounds && latestBounds.className,
    actionIndex: consumeNextActionIndex(),
  });
  // If a focus card is mid-build, shorten its debounce — wrap means
  // "TalkBack is done navigating".
  if (pendingEvent) schedulePendingFlush(PENDING_FLUSH_AFTER_WRAP_MS);
}

function handleBounds(bounds) {
  const now = bounds.timestamp || Date.now();
  // Fast-swipe case: a new bounds means a new focus. If the existing pending
  // focus already heard any speech or hint, flush it as its own card before
  // starting fresh — otherwise the intermediate item disappears and its hint
  // gets concatenated onto the next card.
  if (pendingEvent && !pendingEvent.announcementOnly) {
    const hasContent =
      (pendingEvent.announcements && pendingEvent.announcements.length) ||
      (pendingEvent.hints && pendingEvent.hints.length);
    if (hasContent) flushPendingEvent();
  }
  if (!pendingEvent) {
    startPendingFocus({ timestamp: now, announcementOnly: false });
  } else if (pendingEvent.announcementOnly) {
    pendingEvent.announcementOnly = false;
    pendingEvent.eventType = 'focus';
    // Index pairing is deferred to flushPendingEvent now — no consume here.
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

  // #N correlation label. Always create the span — kept hidden until an
  // index is known — so action cards rendered before their 'action' SSE
  // arrives can be filled in later via tagActionCardWithIndex.
  const idxSpan = document.createElement('span');
  idxSpan.className = 'broadcast-index';
  if (ev.actionIndex != null) {
    idxSpan.textContent = `#${ev.actionIndex}`;
  } else {
    idxSpan.hidden = true;
  }
  header.appendChild(idxSpan);

  if (ev.actionDetails) {
    const det = document.createElement('span');
    det.className = 'action-details';
    det.textContent = ev.actionDetails;
    header.appendChild(det);
  }

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
  return li;
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
      // Wait until the new bitmap is decoded before redrawing — the
      // overlay's scale depends on the image's natural dimensions.
      await screenshotImg.decode();
    } catch (_) {}
    if (stale()) return;
    lastCommittedRefreshAt = requestedAt;
    screenshotNaturalSize = {
      w: screenshotImg.naturalWidth,
      h: screenshotImg.naturalHeight,
    };
    // Re-render the overlay against the (possibly newly-dimensioned) image.
    // currentBounds itself is owned by the bounds SSE handler now — we do
    // NOT overwrite it here. Otherwise a stale snapshot taken at refresh
    // start could clobber a newer bounds that arrived during the fetch.
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
    noteUserAction({ action: 'tap', x: p.x, y: p.y });
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
    noteUserAction({ action: 'swipe', x1: a.x, y1: a.y, x2: b.x, y2: b.y, durationMs });
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

const TALKBACK_TO_AUTOCRAWL_VERB = {
  ACTION_SWIPE_LEFT: 'swipe_left',
  ACTION_SWIPE_RIGHT: 'swipe_right',
  ACTION_SWIPE_UP: 'swipe_up',
  ACTION_SWIPE_DOWN: 'swipe_down',
  ACTION_CLICK: 'click',
  ACTION_LONG_CLICK: 'long_click',
  ACTION_BACK: 'back',
  ACTION_HOME: 'home',
};

document.querySelectorAll('button[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tbAction = btn.dataset.action;
    const verb = TALKBACK_TO_AUTOCRAWL_VERB[tbAction] || tbAction.replace(/^ACTION_/, '').toLowerCase();
    noteUserAction({ action: verb });
    fetch('/api/talkback-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: tbAction }),
    });
  });
});

document.getElementById('say-button').addEventListener('click', () => {
  const text = document.getElementById('say-input').value.trim();
  if (!text) return;
  noteUserAction({ action: 'say', text });
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
    lastBoundsAt = arrivedAt;
    // Move the overlay the instant TalkBack reports a new focus. Briefly
    // the rect may be drawn on the previous screenshot — that resolves the
    // next time refreshScreenshot commits a new image — but the rect is
    // never "stuck" on a stale focus the way it could be when the commit
    // was the only writer.
    currentBounds = bounds;
    updateBoundsOverlay();
    handleBounds(bounds);
    scheduleFocusCapture();
  });
  source.addEventListener('action', (e) => {
    const data = JSON.parse(e.data);
    noteAction(data.action, data.timestamp);
    // 'action' SSE is ALWAYS an ADB broadcast and arrives BEFORE bounds
    // (server emits it as soon as the broadcast lands, before TalkBack
    // even processes the action), so retroactive tagging shouldn't have
    // any work to do — but try first to be safe, then queue for the
    // upcoming focus to pick up.
    if (!tagRetroactiveFocus(data.actionIndex)) {
      enqueueActionIndex(data.action, data.actionIndex);
    }
    if (shouldRenderEchoedAction()) {
      flushPendingEvent();
      renderActionCard(data.action, null, data.timestamp, data.actionIndex);
    } else if (data.actionIndex != null) {
      tagActionCardWithIndex(data.action, data.actionIndex);
    }
  });
  source.addEventListener('gesture', (e) => {
    const data = JSON.parse(e.data);
    noteAction(data.gesture, data.timestamp);
    // Broadcast echo? The action card / index were already accounted for
    // when the 'action' SSE came through. Drop.
    if (data.fromBroadcast) return;
    // Phone-initiated (or /api/gesture). The 'gesture' SSE typically
    // arrives AFTER bounds — try retroactive tagging of the focus that
    // already rendered without an index; only fall back to enqueue if
    // there's no pending untagged focus.
    if (!tagRetroactiveFocus(data.actionIndex)) {
      enqueueActionIndex(data.gesture, data.actionIndex);
    }
    if (shouldRenderEchoedAction()) {
      flushPendingEvent();
      renderActionCard(data.gesture, null, data.timestamp, data.actionIndex);
    } else if (data.actionIndex != null) {
      tagActionCardWithIndex(data.gesture, data.actionIndex);
    }
  });
  source.addEventListener('click', (e) => {
    const data = JSON.parse(e.data);
    const verb = data.long ? 'long_tap' : 'tap';
    noteAction(verb, data.timestamp);
    if (data.fromBroadcast) return;
    // Same late-arrival pattern as gesture: /api/gesture tap and
    // phone-initiated touches both produce 'click' SSEs that race the
    // bounds SSE for the resulting focus, and frequently lose.
    if (!tagRetroactiveFocus(data.actionIndex)) {
      enqueueActionIndex(verb, data.actionIndex);
    }
    if (shouldRenderEchoedAction()) {
      flushPendingEvent();
      renderActionCard(verb, null, data.timestamp, data.actionIndex);
    } else if (data.actionIndex != null) {
      tagActionCardWithIndex(verb, data.actionIndex);
    }
  });
  source.addEventListener('recording_capture', () => {
    // Used by the auto-crawl loop to defer the next action until 500 ms past
    // the most recent server-side recording capture.
    lastServerCaptureAt = Date.now();
  });
  source.addEventListener('announcement', (e) => {
    const data = JSON.parse(e.data);
    // System announcement tagged by the APK (TYPE_ANNOUNCEMENT or
    // TYPE_NOTIFICATION_STATE_CHANGED). Always rendered standalone — flush
    // any in-progress focus first so the announcement doesn't sneak into a
    // focus card via the announcement-only promotion path, and don't touch
    // the action_index queue (announcements aren't paired with actions).
    flushPendingEvent();
    renderEvent({
      timestamp: data.timestamp || Date.now(),
      eventType: 'announcement',
      actionDetails: '',
      announcements: data.text ? [data.text] : [],
      rect: null,
      resourceId: null,
      className: null,
      actionIndex: null,
    });
    // Announcements often coincide with visible screen changes (toast,
    // notification banner, content update). Refresh the live view so the
    // user sees what was on screen when the announcement fired.
    scheduleFocusCapture();
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
    if (typeof stopAutoCrawl === 'function') stopAutoCrawl();
  }
  renderAutoCrawlInfo();
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
      if (autoCrawlActions && autoCrawlActions.length) {
        runAutoCrawl();
      }
    } catch (e) {
      alert('Failed to start recording: ' + e.message);
    }
  } else {
    stopAutoCrawl();
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

// ---------- Auto-crawl ----------
//
// Replays a user-supplied JSONL of actions when a recording starts. Each row
// has a single `action` verb; the backend split between TalkBack broadcasts
// (/api/talkback-action) and coordinate gestures (/api/gesture) is hidden
// here and resolved by dispatchAutoCrawlRow. Between actions we wait
// PENDING_FLUSH_INITIAL_MS + 1000 — same settle window the live transcript
// uses, plus a 1-second buffer.
//
// Unified row schema (lower_snake_case verbs, no ACTION_ prefix):
//   {"action": "tap", "x": 100, "y": 200}
//   {"action": "swipe", "x1": 100, "y1": 200, "x2": 300, "y2": 400, "durationMs": 300}
//   {"action": "swipe_left" | "swipe_right" | "swipe_up" | "swipe_down"}
//   {"action": "click" | "long_click" | "back" | "home"}
//   {"action": "say", "text": "hello"}
//   {"action": "wait"}            — pause indefinitely until user clicks Resume
//   {"action": "wait", "seconds": 5} — sleep N seconds, then continue
//   {"action": "<any_other>", "params": {...}}   // raw passthrough to TalkBack

const AUTO_CRAWL_ACTION_DELAY_MS = PENDING_FLUSH_INITIAL_MS + 1000;
// Taps / clicks often navigate or load content. Wait up to 5 s total, but
// finish 1.6 s after the first TalkBack announcement if that's sooner.
const AUTO_CRAWL_TAP_SETTLE_MAX_MS = 7500;
const AUTO_CRAWL_TAP_SETTLE_POST_SPEECH_MS = 1600;
// Also wait at least this long after the most recent server-side recording
// screenshot lands, so the next action doesn't fire before the screenshot
// for the current focus has finished writing.
const AUTO_CRAWL_POST_CAPTURE_MS = 500;
const AUTO_CRAWL_CAPTURE_WAIT_CAP_MS = 5000;
let lastServerCaptureAt = 0;
// Updated by the SSE bounds handler. Used to detect "the action triggered a
// focus change → a capture is in flight" so awaitPostCaptureSettle can keep
// waiting instead of bailing out when the capture is slower than the base
// rule.
let lastBoundsAt = 0;
const autoCrawlFileInput = document.getElementById('auto-crawl-file');
const autoCrawlLoadBtn = document.getElementById('auto-crawl-load');
const autoCrawlInfo = document.getElementById('auto-crawl-info');
const autoCrawlLabel = document.getElementById('auto-crawl-label');
const autoCrawlRemoveBtn = document.getElementById('auto-crawl-remove');
const autoCrawlPauseBtn = document.getElementById('auto-crawl-pause');
const autoCrawlStatusEl = document.getElementById('autocrawl-status');
const autoCrawlListEl = document.getElementById('autocrawl-list');

let autoCrawlActions = null;
let autoCrawlFileName = null;
let autoCrawlRunning = false;
let autoCrawlAbort = false;
let autoCrawlIndex = 0;
let autoCrawlSleepTimer = null;
let autoCrawlSleepResolve = null;
let autoCrawlPaused = false;
let autoCrawlPauseResolve = null;
let autoCrawlPausePromise = null;
let autoCrawlSelectedIndex = -1;
let tapSettleResolver = null;
let tapSettleStartAt = 0;
let tapSettleHeardSpeech = false;
let tapSettleMaxTimer = null;
let tapSettlePostSpeechTimer = null;

function renderAutoCrawlInfo() {
  if (!autoCrawlActions) {
    autoCrawlLoadBtn.hidden = false;
    autoCrawlInfo.hidden = true;
    autoCrawlPauseBtn.hidden = true;
    return;
  }
  autoCrawlLoadBtn.hidden = true;
  autoCrawlInfo.hidden = false;
  const total = autoCrawlActions.length;
  if (autoCrawlRunning) {
    const tag = autoCrawlPaused ? ' · paused' : '';
    autoCrawlLabel.textContent =
      `${autoCrawlFileName} · ${autoCrawlIndex + 1}/${total}${tag}`;
  } else {
    autoCrawlLabel.textContent = `${autoCrawlFileName} · ${total} actions`;
  }
  // Pause/resume stays visible for the entire recording — even before the
  // first action and after the loop finishes — so the user can pause
  // pre-emptively or resume between actions without the button flickering.
  if (recording) {
    autoCrawlPauseBtn.hidden = false;
    autoCrawlPauseBtn.textContent = autoCrawlPaused ? '▶ Resume' : '⏸ Pause';
  } else {
    autoCrawlPauseBtn.hidden = true;
  }
}

function buildAutoCrawlStatusPanel() {
  if (!autoCrawlActions) {
    autoCrawlListEl.innerHTML = '';
    autoCrawlStatusEl.hidden = true;
    autoCrawlSelectedIndex = -1;
    return;
  }
  autoCrawlListEl.innerHTML = '';
  autoCrawlActions.forEach((row, idx) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'autocrawl-label';
    label.textContent = formatActionLabel(row);
    li.appendChild(label);
    li.addEventListener('click', (e) => {
      // Clicks on the jump button bubble up — ignore so the row doesn't
      // re-toggle its selection state after the jump runs.
      if (e.target.classList.contains('jump-btn')) return;
      selectAutoCrawlRow(idx);
    });
    autoCrawlListEl.appendChild(li);
  });
  autoCrawlStatusEl.hidden = false;
  refreshAutoCrawlHighlight();
}

function selectAutoCrawlRow(idx) {
  // Toggle: clicking the same row again clears the selection.
  autoCrawlSelectedIndex = (autoCrawlSelectedIndex === idx) ? -1 : idx;
  refreshAutoCrawlHighlight();
}

function refreshAutoCrawlHighlight() {
  if (!autoCrawlActions || autoCrawlStatusEl.hidden) return;
  const items = autoCrawlListEl.children;
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    li.classList.remove('current', 'done', 'selected');
    const oldBtn = li.querySelector('.jump-btn');
    if (oldBtn) oldBtn.remove();
    if (autoCrawlRunning) {
      if (i < autoCrawlIndex) li.classList.add('done');
      else if (i === autoCrawlIndex) li.classList.add('current');
    }
    if (i === autoCrawlSelectedIndex) {
      li.classList.add('selected');
      const btn = document.createElement('button');
      btn.className = 'jump-btn';
      btn.type = 'button';
      btn.textContent = 'Jump here';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToAutoCrawlAction(i);
      });
      li.appendChild(btn);
    }
  }
  if (autoCrawlRunning) {
    const current = items[autoCrawlIndex];
    if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function jumpToAutoCrawlAction(target) {
  if (target == null || target < 0 || target >= autoCrawlActions.length) return;
  autoCrawlSelectedIndex = -1;
  if (!autoCrawlRunning) {
    if (recording) {
      // Loop already finished — restart it from the jump target so the user
      // can replay from any point without re-pressing Record.
      runAutoCrawl(target);
    } else {
      refreshAutoCrawlHighlight();
    }
    return;
  }
  autoCrawlIndex = target;
  // Break out of an in-flight inter-action sleep so the loop picks the new
  // index up now. Don't touch tap settle — let it run its course so the
  // current tap's announcements / screenshots finish cleanly before we
  // jump.
  if (autoCrawlSleepTimer) {
    clearTimeout(autoCrawlSleepTimer);
    autoCrawlSleepTimer = null;
  }
  if (autoCrawlSleepResolve) {
    const r = autoCrawlSleepResolve;
    autoCrawlSleepResolve = null;
    r();
  }
  if (autoCrawlPaused) resumeAutoCrawl();
  renderAutoCrawlInfo();
  refreshAutoCrawlHighlight();
}

autoCrawlLoadBtn.addEventListener('click', () => autoCrawlFileInput.click());

autoCrawlFileInput.addEventListener('change', async () => {
  const file = autoCrawlFileInput.files && autoCrawlFileInput.files[0];
  // Reset so re-selecting the same filename re-triggers `change`.
  autoCrawlFileInput.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('file is empty');
    const actions = [];
    for (let i = 0; i < lines.length; i++) {
      let obj;
      try { obj = JSON.parse(lines[i]); }
      catch (e) { throw new Error(`line ${i + 1}: ${e.message}`); }
      const problem = validateAutoCrawlRow(obj);
      if (problem) throw new Error(`line ${i + 1}: ${problem}`);
      actions.push(obj);
    }
    autoCrawlActions = actions;
    autoCrawlFileName = file.name;
    autoCrawlIndex = 0;
    renderAutoCrawlInfo();
    buildAutoCrawlStatusPanel();
  } catch (e) {
    alert('Could not load auto-crawl file: ' + e.message);
  }
});

autoCrawlRemoveBtn.addEventListener('click', () => {
  stopAutoCrawl();
  autoCrawlActions = null;
  autoCrawlFileName = null;
  autoCrawlIndex = 0;
  renderAutoCrawlInfo();
  buildAutoCrawlStatusPanel();
});

function validateAutoCrawlRow(row) {
  if (!row || typeof row !== 'object' || typeof row.action !== 'string' || !row.action) {
    return 'each row needs an "action" string';
  }
  const a = row.action;
  if (a === 'tap') {
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) {
      return '"tap" needs numeric "x" and "y"';
    }
  } else if (a === 'swipe') {
    if (!Number.isFinite(row.x1) || !Number.isFinite(row.y1)
        || !Number.isFinite(row.x2) || !Number.isFinite(row.y2)) {
      return '"swipe" needs numeric "x1","y1","x2","y2"';
    }
  } else if (a === 'wait') {
    if (row.seconds !== undefined && !(Number.isFinite(row.seconds) && row.seconds >= 0)) {
      return '"wait" optional "seconds" must be a non-negative number';
    }
  }
  return null;
}

async function dispatchAutoCrawlRow(row) {
  const a = row.action;
  // Tag the dispatch locally so the next transcript card carries the params.
  if (a !== 'wait') noteUserAction(row);
  if (a === 'tap') {
    return fetch('/api/gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tap', x: row.x, y: row.y }),
    });
  }
  if (a === 'swipe') {
    return fetch('/api/gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'swipe',
        x1: row.x1, y1: row.y1, x2: row.x2, y2: row.y2,
        durationMs: Number.isFinite(row.durationMs) ? row.durationMs : undefined,
      }),
    });
  }
  if (a === 'wait') {
    if (Number.isFinite(row.seconds)) {
      await autoCrawlSleep(Math.max(0, row.seconds) * 1000);
    } else {
      // No duration → pause until the user clicks Resume.
      pauseAutoCrawl();
      await awaitAutoCrawlResume();
    }
    return;
  }
  // Everything else is a TalkBack broadcast: snake_case → ACTION_SNAKE_CASE.
  const params = { ...(row.params || {}) };
  if (a === 'say' && typeof row.text === 'string') {
    params.PARAMETER_TEXT = row.text;
  }
  return fetch('/api/talkback-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'ACTION_' + a.toUpperCase(),
      params: Object.keys(params).length ? params : undefined,
    }),
  });
}

async function awaitPostActionSettle(row) {
  // `wait` is self-paced — no additional settle delay after it.
  if (!row || row.action === 'wait') return;
  const actionStartAt = Date.now();
  // Base rule first.
  if (row.action === 'tap' || row.action === 'click') {
    await waitForTapSettle();
  } else {
    await autoCrawlSleep(AUTO_CRAWL_ACTION_DELAY_MS);
  }
  if (autoCrawlAbort) return;
  // Then: if a recording screenshot landed (or is about to land) after this
  // action was dispatched, hold until 500 ms past the most recent one. If
  // multiple captures happen in succession, the timer resets on each so we
  // always end after the last. Capped overall by AUTO_CRAWL_CAPTURE_WAIT_CAP_MS.
  await awaitPostCaptureSettle(actionStartAt);
}

async function awaitPostCaptureSettle(actionStartAt) {
  const deadline = actionStartAt + AUTO_CRAWL_CAPTURE_WAIT_CAP_MS;
  while (!autoCrawlAbort) {
    const now = Date.now();
    if (now >= deadline) return;
    if (lastServerCaptureAt > actionStartAt) {
      // A capture for this action has landed. Wait until 500 ms past the
      // most recent one; if more captures arrive during the wait, the loop
      // re-evaluates so we always end after the last.
      const sinceCapture = now - lastServerCaptureAt;
      if (sinceCapture >= AUTO_CRAWL_POST_CAPTURE_MS) return;
      const wait = Math.min(
        AUTO_CRAWL_POST_CAPTURE_MS - sinceCapture,
        deadline - now,
      );
      await autoCrawlSleep(wait);
      continue;
    }
    // No capture observed yet. If a bounds event arrived after this action
    // was dispatched, a capture is in flight — poll briefly and re-check
    // instead of bailing out. Without this, a slow screenshot fetch would
    // cause the next action to fire before the previous focus's capture
    // landed.
    if (lastBoundsAt > actionStartAt) {
      await autoCrawlSleep(Math.min(200, deadline - now));
      continue;
    }
    // No bounds, no capture — the action didn't trigger any focus activity
    // and nothing is coming. Done.
    return;
  }
}

function waitForTapSettle() {
  return new Promise((resolve) => {
    finishTapSettle();              // Clear any stale state from a prior call.
    tapSettleResolver = resolve;
    tapSettleStartAt = Date.now();
    tapSettleHeardSpeech = false;
    tapSettleMaxTimer = setTimeout(() => {
      tapSettleMaxTimer = null;
      finishTapSettle();
    }, AUTO_CRAWL_TAP_SETTLE_MAX_MS);
  });
}

function onTapSettleSpeechHeard() {
  if (!tapSettleResolver || tapSettleHeardSpeech) return;
  tapSettleHeardSpeech = true;
  // Switch from the 5 s cap to a 1.6 s post-speech timer, but never let the
  // post-speech timer push us past the 5 s overall ceiling.
  if (tapSettleMaxTimer) {
    clearTimeout(tapSettleMaxTimer);
    tapSettleMaxTimer = null;
  }
  const elapsed = Date.now() - tapSettleStartAt;
  const cap = Math.max(0, AUTO_CRAWL_TAP_SETTLE_MAX_MS - elapsed);
  const wait = Math.min(AUTO_CRAWL_TAP_SETTLE_POST_SPEECH_MS, cap);
  tapSettlePostSpeechTimer = setTimeout(() => {
    tapSettlePostSpeechTimer = null;
    finishTapSettle();
  }, wait);
}

function finishTapSettle() {
  if (tapSettleMaxTimer) {
    clearTimeout(tapSettleMaxTimer);
    tapSettleMaxTimer = null;
  }
  if (tapSettlePostSpeechTimer) {
    clearTimeout(tapSettlePostSpeechTimer);
    tapSettlePostSpeechTimer = null;
  }
  if (tapSettleResolver) {
    const r = tapSettleResolver;
    tapSettleResolver = null;
    r();
  }
}

function pauseAutoCrawl() {
  if (!autoCrawlRunning) return;
  if (autoCrawlPaused) return;
  autoCrawlPaused = true;
  autoCrawlPausePromise = new Promise((r) => { autoCrawlPauseResolve = r; });
  renderAutoCrawlInfo();
}

function resumeAutoCrawl() {
  if (!autoCrawlPaused) return;
  autoCrawlPaused = false;
  if (autoCrawlPauseResolve) {
    const r = autoCrawlPauseResolve;
    autoCrawlPauseResolve = null;
    autoCrawlPausePromise = null;
    r();
  }
  renderAutoCrawlInfo();
}

async function awaitAutoCrawlResume() {
  if (autoCrawlPaused && autoCrawlPausePromise) {
    await autoCrawlPausePromise;
  }
}

autoCrawlPauseBtn.addEventListener('click', () => {
  if (autoCrawlPaused) resumeAutoCrawl();
  else pauseAutoCrawl();
});

function autoCrawlSleep(ms) {
  return new Promise((resolve) => {
    autoCrawlSleepResolve = resolve;
    autoCrawlSleepTimer = setTimeout(() => {
      autoCrawlSleepTimer = null;
      autoCrawlSleepResolve = null;
      resolve();
    }, ms);
  });
}

async function runAutoCrawl(startIndex = 0) {
  if (autoCrawlRunning || !autoCrawlActions) return;
  autoCrawlRunning = true;
  autoCrawlAbort = false;
  autoCrawlIndex = Math.max(0, Math.min(startIndex, autoCrawlActions.length - 1));
  renderAutoCrawlInfo();
  refreshAutoCrawlHighlight();
  try {
    while (autoCrawlIndex < autoCrawlActions.length) {
      if (autoCrawlAbort) break;
      await awaitAutoCrawlResume();
      if (autoCrawlAbort) break;
      // Snapshot the index at the start of this iteration so we can detect
      // a jump landing during dispatch or settle and skip the auto-advance.
      const idxAtStart = autoCrawlIndex;
      const row = autoCrawlActions[idxAtStart];
      renderAutoCrawlInfo();
      refreshAutoCrawlHighlight();
      try {
        await dispatchAutoCrawlRow(row);
      } catch (e) {
        console.warn('[auto-crawl] dispatch failed at row', idxAtStart + 1, e);
      }
      if (autoCrawlAbort) break;
      if (autoCrawlIndex !== idxAtStart) continue;
      await awaitPostActionSettle(row);
      if (autoCrawlAbort) break;
      if (autoCrawlIndex !== idxAtStart) continue;
      autoCrawlIndex += 1;
    }
  } finally {
    autoCrawlRunning = false;
    autoCrawlPaused = false;
    autoCrawlPauseResolve = null;
    autoCrawlPausePromise = null;
    renderAutoCrawlInfo();
    refreshAutoCrawlHighlight();
  }
}

function stopAutoCrawl() {
  autoCrawlAbort = true;
  if (autoCrawlSleepTimer) {
    clearTimeout(autoCrawlSleepTimer);
    autoCrawlSleepTimer = null;
  }
  if (autoCrawlSleepResolve) {
    const r = autoCrawlSleepResolve;
    autoCrawlSleepResolve = null;
    r();
  }
  // Release any indefinite wait-pause too so the loop can exit.
  if (autoCrawlPauseResolve) {
    const r = autoCrawlPauseResolve;
    autoCrawlPauseResolve = null;
    autoCrawlPausePromise = null;
    r();
  }
  // Break out of any in-flight tap-settle wait.
  finishTapSettle();
}

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
