const { EventEmitter } = require('events');

const MAX_ENTRIES = 500;

/**
 * Demuxes EXTERNAL_A11Y events from mobilerun into:
 *  - speech/hint/wrap entries (rolling buffer with computed delays)
 *  - current bounds rect
 *  - last view_scrolled event timestamp
 *  - last action received from TalkBack
 *
 * The shape mirrors what TaskAudit's existing `TalkBackLogEntry` and
 * `bounds_info` produce, so future host-side tools can drop the logcat path.
 */
class TranscriptCollector extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.bounds = null;
    this.lastScrollAt = 0;
    this.lastAction = null;
    this.lastEntryTimestamp = 0;
  }

  ingest(rpcParams) {
    if (!rpcParams || rpcParams.type !== 'EXTERNAL_A11Y') return;
    const payload = rpcParams.payload || {};
    const subtype = payload.subtype;
    const timestamp = rpcParams.timestamp || Date.now();

    switch (subtype) {
      case 'speech':
      case 'wrap':
      case 'hint':
        // hint flows through the same channel as speech now; downstream
        // consumers append its text to the focus event's announcement[] but
        // don't render the word "hint". Subtype is preserved on the entry so
        // they can also collapse the debounce when a hint arrives.
        this._appendSpeechEntry({ subtype, payload, timestamp });
        break;
      case 'bounds':
        this.bounds = {
          timestamp,
          rect: payload.bounds || null,
          resourceId: payload.resourceId || null,
          className: payload.className || null,
        };
        this.emit('bounds', this.bounds);
        break;
      case 'view_scrolled':
        this.lastScrollAt = timestamp;
        this.emit('view_scrolled', { timestamp });
        break;
      case 'action':
        this.lastAction = { timestamp, action: payload.action || null };
        this.emit('action', this.lastAction);
        break;
      case 'gesture':
        this.emit('gesture', { timestamp, gesture: payload.gesture || null });
        break;
      case 'click':
        this.emit('click', {
          timestamp,
          long: !!payload.long,
          resourceId: payload.resourceId || null,
          className: payload.className || null,
          text: payload.text || null,
        });
        break;
      case 'text_change':
        this.emit('text_change', {
          timestamp,
          resourceId: payload.resourceId || null,
          className: payload.className || null,
          text: payload.text || null,
        });
        break;
      default:
        break;
    }
  }

  _appendSpeechEntry({ subtype, payload, timestamp }) {
    const delayMs = this.lastEntryTimestamp ? Math.max(0, timestamp - this.lastEntryTimestamp) : 0;
    const entry = {
      timestamp,
      delayMs,
      subtype,
      speech: subtype === 'wrap' ? '<wrap>' : payload.speech || '',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.lastEntryTimestamp = timestamp;
    this.emit('entry', entry);
  }

  snapshot({ limit = 100 } = {}) {
    const recent = this.entries.slice(-limit);
    return {
      entries: recent,
      bounds: this.bounds,
      lastScrollAt: this.lastScrollAt,
      lastAction: this.lastAction,
    };
  }
}

module.exports = { TranscriptCollector };
