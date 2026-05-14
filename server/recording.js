const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const { randomUUID, createHash } = require('crypto');
const { get: mrGet } = require('./mobilerun-fetch');

const ACTION_TO_EVENT_TYPE = {
  ACTION_SWIPE_LEFT: 'swipe left',
  ACTION_SWIPE_RIGHT: 'swipe right',
  ACTION_SWIPE_UP: 'swipe up',
  ACTION_SWIPE_DOWN: 'swipe down',
  ACTION_CLICK: 'tap',
  ACTION_LONG_CLICK: 'long_tap',
  ACTION_BACK: 'back',
  ACTION_FOCUS_ELEMENT: 'focus',
  ACTION_AUTO_SWIPE_FWD: 'swipe right',
  ACTION_AUTO_SWIPE_BWD: 'swipe left',
};

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
class RecordingManager {
  constructor({ collector, phoneHttp, appHistory }) {
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
      captures: [],
      lastActionAt: 0,
      lastAction: null,
      lastBounds: null,
      pendingFocus: null,
      eventSeq: 0,
      captureTimer: null,
      capturePromise: null,
      treeHashToFilename: new Map(),
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
    let upgradingAnnouncement = false;
    // A focus is only committed when the screenshot is captured (500 ms after
    // the last bounds event). Until then, we keep overwriting rect / class /
    // resourceId so they reflect the most recent — i.e., stabilized — focus.
    if (!this.active.pendingFocus) {
      this.active.pendingFocus = {
        firstBoundsAt: now,
        announcements: [],
        action: this._consumeAction(now),
      };
    } else if (this.active.pendingFocus.announcementOnly) {
      // A free-floating announcement was buffering when bounds arrived. The
      // announcement was probably the setup speech for *this* focus, so
      // promote it to a regular focus event — keep its announcements.
      upgradingAnnouncement = true;
      this.active.pendingFocus.announcementOnly = false;
      this.active.pendingFocus.firstBoundsAt = now;
      if (!this.active.pendingFocus.action) {
        this.active.pendingFocus.action = this._consumeAction(now);
      }
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
    const action = this.active.lastAction;
    const eventType =
      ACTION_TO_EVENT_TYPE[action] ||
      (action ? action.replace(/^ACTION_/, '').toLowerCase() : 'swipe right');
    this.active.events.push({
      event_seq: this.active.eventSeq,
      timestamp_ms: timestamp - this.active.startTime,
      event_type: eventType,
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
      screenshot_id: null,
      tree_id: null,
    });
  }

  _onAction(action) {
    if (!this.active || !action) return;
    this.active.lastAction = action.action || null;
    this.active.lastActionAt = action.timestamp || Date.now();
  }

  _onGesture(gesture) {
    // Touch-screen gestures (swipe left/right/up/down, tap, long_tap, ...)
    // detected by TalkBack. They drive a focus change just like ADB
    // ACTION_* broadcasts do, so we route them through the same
    // last-action machinery — the next bounds event will pick this up as
    // its `event_type`.
    if (!this.active || !gesture) return;
    this.active.lastAction = gesture.gesture || null;
    this.active.lastActionAt = gesture.timestamp || Date.now();
  }

  _onClick(click) {
    // Clicks usually move accessibility focus (the resulting screen has new
    // focus). We attribute them to that next bounds event the same way
    // gestures / ADB actions do, so we don't double-record (e.g., a double-tap
    // fires both onGesture("tap") AND TYPE_VIEW_CLICKED).
    if (!this.active || !click) return;
    this.active.lastAction = click.long ? 'long_tap' : 'tap';
    this.active.lastActionAt = click.timestamp || Date.now();
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
    // Only attribute an action to this focus if it was recent (within 2s)
    // and we haven't yet used it.
    if (!this.active.lastAction) return null;
    const age = focusTimestamp - this.active.lastActionAt;
    if (age < 0 || age > 2_000) return null;
    const action = this.active.lastAction;
    this.active.lastAction = null;
    return action;
  }

  _writeFocusEvent(focus, extras = {}) {
    if (!this.active || !focus) return;
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

    // Action triggered but TalkBack said nothing — write a single
    // no_feedback-content event typed by the action, NOT a separate empty
    // focus card.
    if (!hasSpeech && hasAction) {
      const eventType =
        ACTION_TO_EVENT_TYPE[focus.action] ||
        focus.action.replace(/^ACTION_/, '').toLowerCase();
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
        talkback: { announcement: [NO_FEEDBACK_SENTINEL], offset_ms: 0 },
        screenshot_id: extras.screenshot_id || null,
        tree_id: extras.tree_id || null,
      });
      return;
    }

    this.active.eventSeq += 1;
    let eventType;
    if (focus.announcementOnly) {
      eventType = 'announcement';
    } else {
      eventType =
        ACTION_TO_EVENT_TYPE[focus.action] ||
        (focus.action ? focus.action.replace(/^ACTION_/, '').toLowerCase() : 'swipe right');
    }
    const labelSource = focus.announcements[0] || announcements[0] || '';
    const event = {
      event_seq: this.active.eventSeq,
      timestamp_ms: focus.timestamp - this.active.startTime,
      event_type: eventType,
      user_feedback: '',
      ui_element: {
        resource_id: focus.resourceId || '',
        class: focus.className || '',
        role: '',
        label: focus.announcementOnly ? '' : deriveLabel(labelSource),
        bounds: rectToBoundsBox(focus.rect),
        state: [],
      },
      talkback: {
        announcement: announcements,
        offset_ms: 0,
      },
      screenshot_id: extras.screenshot_id || null,
      tree_id: extras.tree_id || null,
    };
    this.active.events.push(event);
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

  // Flush the pending focus without screenshot/tree (used by stop()).
  _flushPendingFocus() {
    if (!this.active || !this.active.pendingFocus) return;
    const focus = this.active.pendingFocus;
    this.active.pendingFocus = null;
    this._writeFocusEvent(focus);
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
      // Capture failed — restore the focus so the next bounds event keeps
      // accumulating into the same record instead of being lost.
      if (this.active && !this.active.pendingFocus) {
        this.active.pendingFocus = focus;
      }
      return;
    }
    if (!this.active) return; // recording stopped while we were waiting
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
    this._writeFocusEvent(focus, { screenshot_id: screenshotName, tree_id: treeName });
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
