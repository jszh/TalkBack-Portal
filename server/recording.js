const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const archiver = require('archiver');
const { randomUUID, createHash } = require('crypto');
const { get: mrGet } = require('./mobilerun-fetch');

// Adaptive debounce, modeled after TaskAudit/a11y_util.py's TalkBackLogReader:
//  - Initial (bounds only)        : wait long enough for first speech
//  - After speech                 : leave room for a hint to follow
//  - After hint / wrap            : announcement is essentially done
const CAPTURE_DEBOUNCE_INITIAL_MS = 500;
const CAPTURE_DEBOUNCE_AFTER_SPEECH_MS = 700;
const CAPTURE_DEBOUNCE_AFTER_HINT_MS = 150;
const CAPTURE_DEBOUNCE_AFTER_WRAP_MS = 150;
const NO_FEEDBACK_SENTINEL = '<no_feedback>';
const WRAP_SENTINEL = '<wrap>';
// The TalkBack APK mints a monotonic `action_index` for every emitted
// action-like SSE (ADB broadcast OR phone-initiated gesture/click). When
// the SSE is the broadcast's echo, it also carries `from_broadcast: true`;
// otherwise it's a fresh phone action. That gives us a deterministic dedup
// signal AND a stable correlation key linking user_actions ↔ events ↔
// transcript regardless of whether the action came from the browser or
// the device's screen.

function tsTag(date) {
  return new Date(date)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('Z', '');
}

function rectToBoundsBox(rect) {
  if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: rect.left,
    y: rect.top,
    w: Math.max(0, rect.right - rect.left),
    h: Math.max(0, rect.bottom - rect.top),
  };
}

function deriveLabel(announcement) {
  if (!announcement) return '';
  // The announcement is typically "Label, role." or "Label, state, role."
  // We take the first comma-separated chunk as the label heuristic.
  return announcement.split(',')[0].trim();
}

/**
 * RecordingManager listens to TranscriptCollector and (when active) writes
 * one event per accessibility focus change, debouncing screenshot/tree pulls
 * to 500ms after the last focus event. Finalizes to a zip containing:
 *   - events.jsonl
 *   - screenshots/<ts>.png
 *   - trees/<ts>.json
 */
class RecordingManager extends EventEmitter {
  constructor({ collector, phoneHttp, appHistory }) {
    super();
    this.collector = collector;
    this.phoneHttp = phoneHttp;
    this.appHistory = appHistory;
    this.active = null;

    collector.on('bounds', (b) => this._onBounds(b));
    collector.on('entry', (e) => this._onEntry(e));
    collector.on('action', (a) => this._onAction(a));
    collector.on('gesture', (g) => this._onGesture(g));
    collector.on('click', (c) => this._onClick(c));
    collector.on('text_change', (t) => this._onTextChange(t));
    collector.on('announcement', (a) => this._onAnnouncement(a));
  }

  isActive() {
    return this.active != null;
  }

  status() {
    if (!this.active) return { active: false };
    return {
      active: true,
      id: this.active.id,
      startTime: this.active.startTime,
      eventCount: this.active.events.length,
      captureCount: this.active.captures.length,
    };
  }

  async start() {
    if (this.active) return this.status();
    const id = randomUUID();
    const dir = path.join(os.tmpdir(), `portal_recording_${id}`);
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'trees'), { recursive: true });
    this.active = {
      id,
      dir,
      startTime: Date.now(),
      events: [],
      userActions: [],
      captures: [],
      lastActionAt: 0,
      lastAction: null,
      // FIFO queue of actions awaiting attribution to a focus event. Each
      // entry is {action, actionIndex, ts}. Includes both ADB broadcasts
      // (queued by _onAction) and phone-initiated gestures / clicks
      // (queued by _onGesture / _onClick when not echoes). TalkBack
      // processes actions serially, so the queue head is whatever's
      // currently flowing back through the SSE pipeline. Consumed in
      // order by _consumeAction (focus) and peeked by _writeWrapEvent.
      pendingActions: [],
      // Focus events already written to active.events[] that lack
      // action_index because the click/gesture SSE was still in flight at
      // write time. Retroactively patched when the SSE eventually arrives.
      untaggedFocusEvents: [],
      lastBounds: null,
      pendingFocus: null,
      eventSeq: 0,
      userActionSeq: 0,
      captureTimer: null,
      capturePromise: null,
      // Best-effort capture: fires the moment a bounds arrives (no debounce)
      // and stashes the resulting PNG+tree in memory. Reused whenever a
      // focus event is written without going through the settled
      // _captureNow path — settled-fetch failure, intermediate fast-swipe
      // flush, or stop() flushing a pending focus — so events.jsonl gets
      // a screenshot in all of those cases too. Never emits the 'capture'
      // SSE (auto-crawl pacing still waits on the settled capture).
      bestEffortInFlight: false,
      // Promise tracking the in-flight best-effort fetch so stop() can
      // await it before flushing the final pending focus.
      bestEffortPromise: null,
      bestEffortCapture: null,
      treeHashToFilename: new Map(),
      // Tracks the most recently written screenshot/tree pair so that
      // events written outside the focus-capture path (currently: wrap
      // markers) can still carry meaningful screenshot/tree references.
      // Wrap means TalkBack tried to navigate but couldn't, so the screen
      // is identical to the last captured focus — reusing that capture
      // is semantically correct.
      lastCapture: null,
    };
    // Capture the initial state of the device before returning. The very
    // first jsonl event is a session_start whose screenshot/tree are the
    // device as the user saw it at the moment they hit Record.
    try {
      await this._writeSessionStartEvent();
    } catch (e) {
      console.warn('[recording] session_start capture failed:', e.message);
    }
    return this.status();
  }

  async _writeSessionStartEvent() {
    if (!this.active) return;
    const session = this.active;
    const ts = session.startTime;
    const [png, tree] = await Promise.all([
      this._fetchScreenshot(),
      this._fetchTree(),
    ]);
    if (this.active !== session) return;
    const tag = tsTag(ts);
    const screenshotName = `start_${tag}.png`;
    fs.writeFileSync(path.join(session.dir, 'screenshots', screenshotName), png);

    const treeHash = createHash('sha256').update(tree).digest('hex');
    let treeName = session.treeHashToFilename.get(treeHash);
    if (!treeName) {
      treeName = `start_${tag}.json`;
      fs.writeFileSync(path.join(session.dir, 'trees', treeName), tree);
      session.treeHashToFilename.set(treeHash, treeName);
    }
    session.captures.push({ timestamp: ts, screenshot: screenshotName, tree: treeName });
    session.lastCapture = { screenshot_id: screenshotName, tree_id: treeName };

    session.eventSeq += 1;
    const lastBounds = session.lastBounds;
    session.events.push({
      event_seq: session.eventSeq,
      timestamp_ms: 0,
      event_type: 'session_start',
      user_feedback: '',
      ui_element: {
        resource_id: lastBounds?.resourceId || '',
        class: lastBounds?.className || '',
        role: '',
        label: '',
        bounds: rectToBoundsBox(lastBounds?.rect),
        state: [],
      },
      talkback: { announcement: [], offset_ms: 0 },
      screenshot_id: screenshotName,
      tree_id: treeName,
    });
  }

  async stop() {
    if (!this.active) return null;
    if (this.active.captureTimer) {
      clearTimeout(this.active.captureTimer);
      this.active.captureTimer = null;
    }
    // If a capture is mid-flight (screenshot/tree fetch in progress), wait for
    // it to land in events[] before clearing `active` — otherwise the last
    // focus's event is silently dropped by _captureNow's `!this.active` guard.
    if (this.active.capturePromise) {
      try { await this.active.capturePromise; } catch (_) {}
    }
    // Also wait for the best-effort capture so its buffer lands in
    // bestEffortCapture in time for _flushPendingFocus to pick it up.
    // Without this, stop()'s final write would race the in-flight fetch
    // and the trailing focus event would end up with no screenshot.
    if (this.active.bestEffortPromise) {
      try { await this.active.bestEffortPromise; } catch (_) {}
    }
    this._flushPendingFocus();
    const session = this.active;
    this.active = null;
    return session;
  }

  cancel() {
    const session = this.stop();
    if (session) {
      try {
        fs.rmSync(session.dir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  _onBounds(bounds) {
    if (!this.active) return;
    const now = bounds.timestamp || Date.now();
    this.active.lastBounds = bounds;
    // Fire a best-effort capture immediately, in parallel with the debounced
    // settled capture below. If the settled fetch later fails, this buffer is
    // used as a fallback so events.jsonl still gets a screenshot.
    this._kickBestEffortCapture();
    // Fast-swipe case: a new bounds means TalkBack moved on to a new focus.
    // If the in-progress pendingFocus already heard any speech or hint,
    // commit it as its own event before starting fresh — otherwise the
    // intermediate item is silently dropped (the previous behavior just
    // overwrote rect/class on the same pendingFocus). We don't take a
    // screenshot here because the device has already transitioned visually;
    // writing screenshot_id=null is more honest than attaching the next
    // focus's screenshot to the intermediate event.
    if (this.active.pendingFocus && !this.active.pendingFocus.announcementOnly) {
      const pf = this.active.pendingFocus;
      const hasContent =
        (pf.announcements && pf.announcements.length) ||
        (pf.hints && pf.hints.length);
      if (hasContent) {
        if (this.active.captureTimer) {
          clearTimeout(this.active.captureTimer);
          this.active.captureTimer = null;
        }
        this.active.pendingFocus = null;
        // If the best-effort capture for this focus has landed, persist it
        // and reference it on the intermediate event so the row isn't
        // written with a null screenshot. Sync — if best-effort is still
        // in flight at this moment we accept the null (acceptable for
        // fast-swipe intermediate frames; settled captures of the focuses
        // that actually settle still get full screenshots).
        const be = this.active.bestEffortCapture;
        if (be) {
          const ids = this._writeBestEffortToDisk(be);
          this.active.bestEffortCapture = null;
          this._writeFocusEvent(pf, ids);
        } else {
          this._writeFocusEvent(pf);
        }
      }
    }
    let upgradingAnnouncement = false;
    // A focus is only committed when the screenshot is captured (500 ms after
    // the last bounds event). Until then, we keep overwriting rect / class /
    // resourceId so they reflect the most recent — i.e., stabilized — focus.
    //
    // We do NOT consume the pendingActions queue here. For /api/gesture and
    // phone-initiated touches, the 'click'/'gesture' SSE carrying the
    // action_index arrives AFTER the bounds SSE (TalkBack detects the focus
    // change before finishing the click), so a consume here would always
    // miss. The consume is deferred to _writeFocusEvent (~500-700ms later),
    // by which point the SSE has reliably populated the queue.
    if (!this.active.pendingFocus) {
      this.active.pendingFocus = {
        firstBoundsAt: now,
        announcements: [],
        action: null,
        actionIndex: null,
      };
    } else if (this.active.pendingFocus.announcementOnly) {
      // A free-floating announcement was buffering when bounds arrived. The
      // announcement was probably the setup speech for *this* focus, so
      // promote it to a regular focus event — keep its announcements.
      upgradingAnnouncement = true;
      this.active.pendingFocus.announcementOnly = false;
      this.active.pendingFocus.firstBoundsAt = now;
    }
    const focus = this.active.pendingFocus;
    focus.timestamp = now;
    focus.rect = bounds.rect;
    focus.resourceId = bounds.resourceId;
    focus.className = bounds.className;
    // Drop transient signals from the previous focus iteration — anything
    // collected after this point belongs to the new target. (Exception:
    // when we just upgraded an announcement, keep the speech that arrived
    // before bounds.)
    if (!upgradingAnnouncement) {
      focus.announcements = [];
      focus.hints = [];
      focus.wrapped = false;
    }
    this._scheduleCapture();
  }

  _onEntry(entry) {
    if (!this.active) return;
    if (entry.subtype === 'speech' || entry.subtype === 'hint') {
      const trimmed = (entry.speech || '').trim();
      if (!trimmed) return;
      if (!this.active.pendingFocus) {
        // No focus context — free-floating announcement (toast, notification,
        // etc.). Bootstrap an announcement-only pending focus.
        this.active.pendingFocus = {
          firstBoundsAt: entry.timestamp || Date.now(),
          timestamp: entry.timestamp || Date.now(),
          rect: null,
          resourceId: null,
          className: null,
          announcements: [],
          hints: [],
          action: null,
          actionIndex: null,
          announcementOnly: true,
        };
      }
      // Hint text is buffered separately and concatenated AFTER the speech
      // on flush, so the announcement list reads as:
      //   <main speech...>
      //   <hint text>
      // even though TalkBack emits the hint-only feedback part before the
      // text-only part.
      if (entry.subtype === 'hint') {
        if (!this.active.pendingFocus.hints) this.active.pendingFocus.hints = [];
        this.active.pendingFocus.hints.push(trimmed);
        this._scheduleCapture(CAPTURE_DEBOUNCE_AFTER_HINT_MS);
      } else {
        this.active.pendingFocus.announcements.push(trimmed);
        this._scheduleCapture(CAPTURE_DEBOUNCE_AFTER_SPEECH_MS);
      }
    } else if (entry.subtype === 'wrap') {
      // Wrap fires the moment navigation runs out. Commit it immediately as
      // its own event, typed by whatever triggered it (gesture/action/click)
      // — without consuming lastAction so the subsequent focus event inherits
      // the same event_type.
      this._writeWrapEvent(entry.timestamp || Date.now());
    }
  }

  _writeWrapEvent(timestamp) {
    if (!this.active) return;
    const lastBounds = this.active.lastBounds;
    this.active.eventSeq += 1;
    // Wrap means TalkBack couldn't navigate further — the screen still shows
    // the boundary element from the last focus capture. Reuse that capture's
    // screenshot/tree rather than emit null, so every event in the recording
    // has visual context. The triggering action is in user_actions.jsonl, so
    // event_type stays purely descriptive ("wrap").
    const last = this.active.lastCapture || {};
    const event = {
      event_seq: this.active.eventSeq,
      timestamp_ms: timestamp - this.active.startTime,
      event_type: 'wrap',
      user_feedback: '',
      ui_element: {
        resource_id: lastBounds?.resourceId || '',
        class: lastBounds?.className || '',
        role: '',
        label: '',
        bounds: rectToBoundsBox(lastBounds?.rect),
        state: [],
      },
      talkback: { announcement: [WRAP_SENTINEL], offset_ms: 0 },
      screenshot_id: last.screenshot_id || null,
      tree_id: last.tree_id || null,
    };
    // Consume the queue head — wrap is the terminal event for this
    // action (TalkBack tried to navigate but couldn't, so no follow-up
    // focus event will fire). If we only peeked, the stale entry would
    // hang around until its TTL and get picked up by a later unrelated
    // focus event.
    this._trimPendingActions(Date.now());
    const consumed = this.active.pendingActions.shift();
    if (consumed && consumed.actionIndex != null) {
      event.action_index = consumed.actionIndex;
    }
    this.active.events.push(event);
  }

  _onAction(action) {
    if (!this.active || !action) return;
    const ts = action.timestamp || Date.now();
    // 'action' SSE for an ADB broadcast normally arrives BEFORE bounds
    // (the server emits it as the broadcast lands, before TalkBack runs
    // it), so retroactive tagging shouldn't have work to do — but try
    // first to be safe, then queue for the upcoming focus to consume.
    if (!this._tagRetroactiveFocus(action.actionIndex ?? null)) {
      this.active.pendingActions.push({
        action: action.action || null,
        actionIndex: action.actionIndex ?? null,
        ts,
      });
      this._trimPendingActions(ts);
    }
    // 'action' SSE is always the echo of an ADB broadcast we sent. Stamp
    // the index onto the matching browser user_actions row the route
    // already appended, so the saved file lets you correlate user_actions
    // ↔ events ↔ transcript with the same action_index.
    if (action.actionIndex != null) {
      const verb = this._normalizeActionVerb(action.action);
      if (verb) this._tagBrowserUserActionRow(verb, action.actionIndex);
    }
  }

  _trimPendingActions(now) {
    const cutoff = now - 5_000;
    const q = this.active.pendingActions;
    while (q.length && q[0].ts < cutoff) q.shift();
  }

  _tagBrowserUserActionRow(verb, actionIndex) {
    // The route's noteUserAction call ran before the broadcast was sent, so
    // the matching row is the OLDEST browser-source entry for this verb
    // that hasn't been tagged yet — scan forward (FIFO) so consecutive
    // dispatches of the same verb get paired with their indices in the
    // order they happened.
    const rows = this.active.userActions;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.source === 'browser' && r.action === verb && r.action_index == null) {
        r.action_index = actionIndex;
        return;
      }
    }
  }

  // Called by the gesture / talkback-action routes (source defaults to
  // 'browser') and by the SSE-driven handlers below (source = 'phone').
  // Echo suppression for browser-initiated ADB broadcasts happens at the
  // call site (the SSE handlers return early when fromBroadcast is true),
  // so by the time we get here the call already represents a row to log.
  noteUserAction(details, source = 'browser') {
    if (!this.active || !details) return;
    const ts = Date.now();
    this.active.userActionSeq += 1;
    this.active.userActions.push({
      seq: this.active.userActionSeq,
      timestamp_ms: ts - this.active.startTime,
      source,
      ...details,
    });
  }

  _normalizeActionVerb(raw) {
    if (!raw || typeof raw !== 'string') return null;
    // ACTION_SWIPE_RIGHT -> swipe_right ; "swipe right" -> swipe_right
    return raw.replace(/^ACTION_/i, '').toLowerCase().replace(/\s+/g, '_');
  }

  _onGesture(gesture) {
    // Touch-screen gestures (swipe left/right/up/down, tap, long_tap, ...)
    // detected by TalkBack. Echoes (from_broadcast=true) skip — they're an
    // ADB broadcast we already queued via _onAction. Otherwise queue with
    // the fresh action_index and write a phone user_actions row.
    if (!this.active || !gesture) return;
    this.active.lastAction = gesture.gesture || null;
    this.active.lastActionAt = gesture.timestamp || Date.now();
    if (gesture.fromBroadcast) return;
    const verb = this._normalizeActionVerb(gesture.gesture);
    if (!verb) return;
    if (gesture.actionIndex != null) {
      // /api/gesture and phone-initiated swipes typically race bounds and
      // lose — by the time this SSE arrives, the focus event has often
      // already been written without an index. Patch it retroactively;
      // otherwise queue for an upcoming focus that hasn't been written.
      if (!this._tagRetroactiveFocus(gesture.actionIndex)) {
        this.active.pendingActions.push({
          action: gesture.gesture,
          actionIndex: gesture.actionIndex,
          ts: gesture.timestamp || Date.now(),
        });
        this._trimPendingActions(gesture.timestamp || Date.now());
      }
    }
    const note = { action: verb };
    if (gesture.actionIndex != null) note.action_index = gesture.actionIndex;
    this.noteUserAction(note, 'phone');
  }

  _onClick(click) {
    // Clicks fired by TalkBack — either from a browser ACTION_CLICK (echo,
    // from_broadcast=true) or from a physical double-tap (fresh action_index).
    if (!this.active || !click) return;
    this.active.lastAction = click.long ? 'long_tap' : 'tap';
    this.active.lastActionAt = click.timestamp || Date.now();
    if (click.fromBroadcast) return;
    const verb = click.long ? 'long_click' : 'click';
    if (click.actionIndex != null) {
      // Same late-arrival pattern as gesture: prefer retroactive tag of
      // the already-written focus event.
      if (!this._tagRetroactiveFocus(click.actionIndex)) {
        this.active.pendingActions.push({
          action: verb,
          actionIndex: click.actionIndex,
          ts: click.timestamp || Date.now(),
        });
        this._trimPendingActions(click.timestamp || Date.now());
      }
    }
    const details = { action: verb };
    if (click.resourceId) details.resource_id = click.resourceId;
    if (click.className) details.class = click.className;
    if (click.text) details.text = click.text;
    if (click.actionIndex != null) details.action_index = click.actionIndex;
    this.noteUserAction(details, 'phone');
  }

  _onTextChange(change) {
    if (!this.active || !change) return;
    this._writeStandaloneEvent({
      event_type: 'type',
      timestamp: change.timestamp,
      resourceId: change.resourceId,
      className: change.className,
      label: '',
      announcement: change.text ? [change.text] : [],
    });
  }

  _onAnnouncement(announcement) {
    // System-driven announcement (TYPE_ANNOUNCEMENT / TYPE_NOTIFICATION_STATE_CHANGED)
    // tagged by the APK. Always standalone — never merged into a focus
    // event the way free-floating speech historically was — so a status
    // announcement that lands between an action and its focus can't
    // contaminate the focus row.
    if (!this.active || !announcement) return;
    const ts = announcement.timestamp || Date.now();
    this.active.eventSeq += 1;
    // Seed with lastCapture so the event always has *some* visual context
    // even if the fresh capture below fails. _attachFreshCapture patches
    // screenshot_id / tree_id in-place when its fetch lands.
    const last = this.active.lastCapture || {};
    const event = {
      event_seq: this.active.eventSeq,
      timestamp_ms: ts - this.active.startTime,
      event_type: 'announcement',
      user_feedback: '',
      ui_element: {
        resource_id: '',
        class: '',
        role: '',
        label: '',
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        state: [],
      },
      talkback: {
        announcement: announcement.text ? [announcement.text] : [],
        offset_ms: 0,
      },
      screenshot_id: last.screenshot_id || null,
      tree_id: last.tree_id || null,
    };
    this.active.events.push(event);
    // Announcements aren't tied to a bounds event, so there's no settled
    // capture coming for them. Kick a fresh fetch so the row reflects
    // whatever was on screen at announcement time, not the stale state of
    // the last focus.
    this._attachFreshCapture(event);
  }

  // Fetch a fresh screenshot+tree and patch the given event with the
  // resulting ids. Reuses a recent best-effort buffer if one is on hand;
  // otherwise issues its own fetch (mobilerun-fetch coalesce keys dedupe
  // any concurrent settled capture at the HTTP layer). Silent on failure
  // — the event keeps whatever screenshot_id it was seeded with.
  _attachFreshCapture(event) {
    const session = this.active;
    if (!session) return;
    const be = session.bestEffortCapture;
    if (be && Date.now() - be.ts < 1000) {
      const ids = this._writeBestEffortToDisk(be);
      session.bestEffortCapture = null;
      event.screenshot_id = ids.screenshot_id;
      event.tree_id = ids.tree_id;
      return;
    }
    this._fetchAndPatch(event, session);
  }

  async _fetchAndPatch(event, session) {
    try {
      const [png, tree] = await Promise.all([
        this._fetchScreenshot(),
        this._fetchTree(),
      ]);
      if (this.active !== session) return;     // recording stopped
      const ids = this._writeBestEffortToDisk({ png, tree, ts: Date.now() });
      event.screenshot_id = ids.screenshot_id;
      event.tree_id = ids.tree_id;
    } catch (_) {
      // Best-effort — fall back to the lastCapture seed.
    }
  }

  _writeStandaloneEvent({ event_type, timestamp, resourceId, className, label, announcement }) {
    this.active.eventSeq += 1;
    this.active.events.push({
      event_seq: this.active.eventSeq,
      timestamp_ms: timestamp - this.active.startTime,
      event_type,
      user_feedback: '',
      ui_element: {
        resource_id: resourceId || '',
        class: className || '',
        role: '',
        label: label || '',
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        state: [],
      },
      talkback: { announcement, offset_ms: 0 },
      screenshot_id: null,
      tree_id: null,
    });
  }

  _consumeAction(focusTimestamp) {
    // Pop the oldest queued action — TalkBack processes actions serially, so
    // the focus that just settled belongs to the queue head. Works for both
    // ADB broadcasts (queued by _onAction) and phone-initiated gestures /
    // clicks (queued by _onGesture / _onClick).
    this._trimPendingActions(focusTimestamp);
    const q = this.active.pendingActions;
    while (q.length > 0) {
      const head = q[0];
      const age = focusTimestamp - head.ts;
      if (age < -1_000) return null;          // future timestamp; skip
      q.shift();
      return { action: head.action, actionIndex: head.actionIndex };
    }
    return null;
  }

  _writeFocusEvent(focus, extras = {}) {
    if (!this.active || !focus) return;
    // Late consume — by the time we write, the click/gesture SSE has had the
    // full debounce + capture window (~500-700ms) to arrive and populate the
    // queue. Announcement-only events don't consume; they're system speech
    // and not tied to a user action.
    if (!focus.announcementOnly && focus.actionIndex == null) {
      const consumed = this._consumeAction(focus.timestamp || Date.now());
      if (consumed) {
        focus.action = consumed.action;
        focus.actionIndex = consumed.actionIndex;
      }
    }
    const hints = focus.hints || [];
    const announcements = [...focus.announcements, ...hints];
    const hasSpeech = announcements.length > 0;
    const hasAction = !!focus.action;

    // Passive focus (no preceding user action, no speech) — typically an app
    // opening or a settle re-emit on an unlabeled container. Suppress to
    // avoid littering the recording with empty events.
    if (!hasSpeech && !hasAction && !focus.announcementOnly) {
      return;
    }

    // event_type is purely descriptive of the TalkBack-side event ("focus"
    // for a bounds-driven focus change, "announcement" for free-floating
    // speech). The triggering user input lives in user_actions.jsonl, so we
    // no longer merge the action verb into events.jsonl.
    const eventType = focus.announcementOnly ? 'announcement' : 'focus';
    const finalAnnouncements = hasSpeech ? announcements : [NO_FEEDBACK_SENTINEL];
    const labelSource = focus.announcements[0] || announcements[0] || '';
    const label = (!focus.announcementOnly && hasSpeech) ? deriveLabel(labelSource) : '';

    this.active.eventSeq += 1;
    const event = {
      event_seq: this.active.eventSeq,
      timestamp_ms: focus.timestamp - this.active.startTime,
      event_type: eventType,
      user_feedback: '',
      ui_element: {
        resource_id: focus.resourceId || '',
        class: focus.className || '',
        role: '',
        label,
        bounds: rectToBoundsBox(focus.rect),
        state: [],
      },
      talkback: {
        announcement: finalAnnouncements,
        offset_ms: 0,
      },
      screenshot_id: extras.screenshot_id || null,
      tree_id: extras.tree_id || null,
    };
    if (focus.actionIndex != null) event.action_index = focus.actionIndex;
    this.active.events.push(event);
    // Still no action_index? Register the event for retroactive tagging — a
    // click/gesture SSE that lands after our write window will patch it.
    // Only meaningful for non-announcement focuses (announcements aren't
    // tied to user actions).
    if (!focus.announcementOnly && focus.actionIndex == null) {
      this.active.untaggedFocusEvents.push({ event, at: Date.now() });
      this._trimUntaggedFocuses(Date.now());
    }
  }

  _trimUntaggedFocuses(now) {
    const cutoff = now - 5_000;
    const q = this.active.untaggedFocusEvents;
    while (q.length && q[0].at < cutoff) q.shift();
  }

  _tagRetroactiveFocus(actionIndex) {
    if (!this.active || actionIndex == null) return false;
    this._trimUntaggedFocuses(Date.now());
    const head = this.active.untaggedFocusEvents.shift();
    if (!head) return false;
    head.event.action_index = actionIndex;
    return true;
  }

  _writeMarkerEvent(eventType, sentinel, focus) {
    if (!this.active) return;
    this.active.eventSeq += 1;
    this.active.events.push({
      event_seq: this.active.eventSeq,
      timestamp_ms: focus.timestamp - this.active.startTime,
      event_type: eventType,
      user_feedback: '',
      ui_element: {
        resource_id: focus.resourceId || '',
        class: focus.className || '',
        role: '',
        label: '',
        bounds: rectToBoundsBox(focus.rect),
        state: [],
      },
      talkback: { announcement: [sentinel], offset_ms: 0 },
      screenshot_id: null,
      tree_id: null,
    });
  }

  // Flush the pending focus on stop(). Tries the best-effort buffer first
  // so the final event in events.jsonl gets a screenshot — stop() awaits
  // bestEffortPromise before calling this, so a successful in-flight
  // best-effort lands in the buffer in time to be picked up here.
  _flushPendingFocus() {
    if (!this.active || !this.active.pendingFocus) return;
    const focus = this.active.pendingFocus;
    this.active.pendingFocus = null;
    const be = this.active.bestEffortCapture;
    if (be) {
      const ids = this._writeBestEffortToDisk(be);
      this.active.bestEffortCapture = null;
      this._writeFocusEvent(focus, ids);
    } else {
      this._writeFocusEvent(focus);
    }
  }

  _scheduleCapture(delayMs = CAPTURE_DEBOUNCE_INITIAL_MS) {
    if (!this.active) return;
    if (this.active.captureTimer) {
      clearTimeout(this.active.captureTimer);
    }
    this.active.captureTimer = setTimeout(() => this._kickCapture(), delayMs);
  }

  _kickCapture() {
    if (!this.active) return;
    this.active.captureTimer = null;
    // Track the in-flight capture so stop() can await it before tearing down.
    const promise = this._captureNow().finally(() => {
      if (this.active && this.active.capturePromise === promise) {
        this.active.capturePromise = null;
      }
    });
    this.active.capturePromise = promise;
  }

  // Fires immediately on every bounds (no debounce) and stashes the PNG+tree
  // in memory. The settled `_captureNow`, the intermediate-flush branch in
  // _onBounds, and stop()'s _flushPendingFocus all reach into this buffer
  // when they'd otherwise write a focus event with no screenshot. Guarded
  // so we never run concurrent captures — any other capture in flight
  // (best-effort OR settled) preempts.
  _kickBestEffortCapture() {
    if (!this.active) return;
    if (this.active.bestEffortInFlight) return;
    if (this.active.capturePromise) return;
    this.active.bestEffortInFlight = true;
    const promise = this._bestEffortCaptureNow().finally(() => {
      if (this.active) {
        this.active.bestEffortInFlight = false;
        if (this.active.bestEffortPromise === promise) {
          this.active.bestEffortPromise = null;
        }
      }
    });
    this.active.bestEffortPromise = promise;
  }

  async _bestEffortCaptureNow() {
    if (!this.active) return;
    const session = this.active;
    let png = null;
    let tree = null;
    try {
      [png, tree] = await Promise.all([this._fetchScreenshot(), this._fetchTree()]);
    } catch (e) {
      // Best-effort means best effort — drop the failure silently. The
      // settled capture will run its own fetch later and report any
      // persistent issue through its own error path.
      return;
    }
    if (this.active !== session) return;       // recording stopped
    if (!this.active.pendingFocus) return;     // settled already captured this focus
    this.active.bestEffortCapture = { png, tree, ts: Date.now() };
  }

  // Persist the in-memory best-effort buffer to disk and return
  // {screenshot_id, tree_id} suitable for passing as `extras` to
  // _writeFocusEvent. Mirrors the file-write + tree-dedup + captures-push
  // behavior of _captureNow's success path; callers are responsible for
  // clearing active.bestEffortCapture afterward.
  _writeBestEffortToDisk(be) {
    if (!this.active) return { screenshot_id: null, tree_id: null };
    const ts = Date.now();
    const tag = tsTag(ts);
    const screenshotName = `ss_${tag}.png`;
    fs.writeFileSync(path.join(this.active.dir, 'screenshots', screenshotName), be.png);

    const treeHash = createHash('sha256').update(be.tree).digest('hex');
    let treeName = this.active.treeHashToFilename.get(treeHash);
    if (!treeName) {
      treeName = `tree_${tag}.json`;
      fs.writeFileSync(path.join(this.active.dir, 'trees', treeName), be.tree);
      this.active.treeHashToFilename.set(treeHash, treeName);
    }

    this.active.captures.push({ timestamp: ts, screenshot: screenshotName, tree: treeName });
    this.active.lastCapture = { screenshot_id: screenshotName, tree_id: treeName };
    return { screenshot_id: screenshotName, tree_id: treeName };
  }

  /**
   * User-initiated capture (e.g., the "refresh screenshot" button). Cancels any
   * pending debounce, synthesizes a focus from the last known bounds if no new
   * focus event has arrived since the last capture, and fires the capture
   * immediately. Returns a promise that resolves when the event lands.
   */
  manualCapture() {
    if (!this.active) return Promise.resolve();
    if (this.active.captureTimer) {
      clearTimeout(this.active.captureTimer);
      this.active.captureTimer = null;
    }
    if (!this.active.pendingFocus && this.active.lastBounds) {
      const lb = this.active.lastBounds;
      this.active.pendingFocus = {
        timestamp: Date.now(),
        rect: lb.rect,
        resourceId: lb.resourceId,
        className: lb.className,
        announcements: [],
        action: null,
      };
    }
    if (this.active.capturePromise) return this.active.capturePromise;
    this._kickCapture();
    return this.active.capturePromise || Promise.resolve();
  }

  async _captureNow() {
    if (!this.active || !this.active.pendingFocus) return;
    // Freeze the focus at the start of the capture so any bounds events that
    // arrive while we await the screenshot become a fresh pendingFocus for
    // the next capture cycle instead of mutating this one.
    const focus = this.active.pendingFocus;
    this.active.pendingFocus = null;

    const ts = Date.now();
    const tag = tsTag(ts);
    const screenshotName = `ss_${tag}.png`;
    let png = null;
    let tree = null;
    try {
      [png, tree] = await Promise.all([this._fetchScreenshot(), this._fetchTree()]);
    } catch (e) {
      console.warn('[recording] capture failed:', e.message);
      // Settled fetch failed — fall back to the best-effort buffer if we
      // captured one when the bounds first arrived. This is the whole
      // point of best-effort: events.jsonl still gets a screenshot when
      // the settled fetch can't.
      const be = this.active && this.active.bestEffortCapture;
      if (be) {
        png = be.png;
        tree = be.tree;
        this.active.bestEffortCapture = null;
        // Fall through to the write-to-disk path below.
      } else {
        // No fallback either — restore the focus so the next bounds event
        // keeps accumulating into the same record instead of being lost.
        if (this.active && !this.active.pendingFocus) {
          this.active.pendingFocus = focus;
        }
        return;
      }
    }
    if (!this.active) return; // recording stopped while we were waiting
    // Whether settled succeeded or we fell back to best-effort, the buffer
    // is consumed at this point — clear it so it can't be reused for a
    // later focus.
    this.active.bestEffortCapture = null;
    fs.writeFileSync(path.join(this.active.dir, 'screenshots', screenshotName), png);

    // Dedupe trees by content hash — if the new tree is identical to one we
    // already wrote, reuse that filename instead of saving a duplicate.
    const treeHash = createHash('sha256').update(tree).digest('hex');
    let treeName = this.active.treeHashToFilename.get(treeHash);
    if (!treeName) {
      treeName = `tree_${tag}.json`;
      fs.writeFileSync(path.join(this.active.dir, 'trees', treeName), tree);
      this.active.treeHashToFilename.set(treeHash, treeName);
    }

    this.active.captures.push({ timestamp: ts, screenshot: screenshotName, tree: treeName });
    this.active.lastCapture = { screenshot_id: screenshotName, tree_id: treeName };
    this._writeFocusEvent(focus, { screenshot_id: screenshotName, tree_id: treeName });
    // Signal to subscribers (transcript SSE route) that a capture just landed.
    // The auto-crawl loop uses this to delay the next action until the
    // screenshot has been written.
    this.emit('capture', {
      timestamp: ts,
      timestamp_ms: ts - this.active.startTime,
      screenshot_id: screenshotName,
      tree_id: treeName,
    });
  }

  async _fetchScreenshot() {
    // Recording uses archive-quality PNG (the browser's live view uses JPEG
    // for latency — see routes/screenshot.js). Different coalesce key, so we
    // don't share an in-flight JPEG fetch and end up writing a low-quality
    // PNG to disk.
    const upstream = await mrGet({
      host: this.phoneHttp.host,
      port: this.phoneHttp.port,
      token: this.phoneHttp.token,
      urlPath: '/screenshot?hideOverlay=true&format=png&quality=100',
      key: 'screenshot:true:png:100',
    });
    if (upstream.status !== 200) {
      throw new Error(`screenshot http ${upstream.status}`);
    }
    const json = JSON.parse(upstream.body.toString('utf8'));
    if (json.status !== 'success' || typeof json.result !== 'string') {
      throw new Error(json.error || 'screenshot failed');
    }
    return Buffer.from(json.result, 'base64');
  }

  async _fetchTree() {
    const upstream = await mrGet({
      host: this.phoneHttp.host,
      port: this.phoneHttp.port,
      token: this.phoneHttp.token,
      urlPath: '/a11y_tree_full',
      key: 'tree:/a11y_tree_full',
    });
    if (upstream.status !== 200) {
      throw new Error(`tree http ${upstream.status}`);
    }
    const json = JSON.parse(upstream.body.toString('utf8'));
    if (json.status !== 'success') {
      throw new Error(json.error || 'tree failed');
    }
    const tree = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
    return Buffer.from(tree, 'utf8');
  }

  /**
   * Finalize a previously stopped session: writes events.jsonl with the
   * supplied metadata, builds the zip, and streams it back to the response.
   * Also persists the app_id to the autocomplete history.
   */
  async finalize(session, metadata, res) {
    const { participant, app_id, session_id, task } = metadata;
    if (!participant || !app_id || !session_id) {
      throw new Error('Missing participant, app_id, or session_id');
    }
    // Apply metadata to every event, in order.
    const lines = session.events.map((evt) => {
      const enriched = {
        session_id,
        app_id,
        participant,
        task: task || '',
        ...evt,
      };
      return JSON.stringify(enriched);
    });
    const jsonlPath = path.join(session.dir, 'events.jsonl');
    fs.writeFileSync(jsonlPath, lines.join('\n') + (lines.length ? '\n' : ''));

    // Standalone log of every action dispatched from the browser UI. Kept
    // separate from events.jsonl so no action is lost to merging or
    // missing-feedback drops.
    const uaLines = (session.userActions || []).map((ua) => {
      const enriched = {
        session_id,
        app_id,
        participant,
        task: task || '',
        ...ua,
      };
      return JSON.stringify(enriched);
    });
    const userActionsPath = path.join(session.dir, 'user_actions.jsonl');
    fs.writeFileSync(userActionsPath, uaLines.join('\n') + (uaLines.length ? '\n' : ''));

    if (this.appHistory) await this.appHistory.add(app_id);

    const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    const zipName = `recording_${safe(participant)}_${safe(app_id)}_${safe(session_id)}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (err) => {
      console.error('[recording] zip error', err);
      try { res.end(); } catch (_) {}
    });
    zip.pipe(res);
    zip.file(jsonlPath, { name: 'events.jsonl' });
    zip.file(userActionsPath, { name: 'user_actions.jsonl' });
    const screenshotsDir = path.join(session.dir, 'screenshots');
    if (fs.existsSync(screenshotsDir)) {
      zip.directory(screenshotsDir, 'screenshots');
    }
    const treesDir = path.join(session.dir, 'trees');
    if (fs.existsSync(treesDir)) {
      zip.directory(treesDir, 'trees');
    }
    await zip.finalize();
    // Clean up the temp dir after the response drains.
    res.on('close', () => {
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch (_) {}
    });
  }
}

module.exports = { RecordingManager };
