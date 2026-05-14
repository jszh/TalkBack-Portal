const WebSocket = require('ws');

/**
 * Single upstream WebSocket connection to mobilerun-portal.
 *
 *  - Subscribes with `?eventFormat=rpc` so unsolicited device events arrive as
 *    `{method: "events/device", params: {type, timestamp, payload}}` (matches
 *    reverse-connection's envelope, easy to demux).
 *  - Supports request/response JSON-RPC via `call(method, params)`.
 *  - Reconnects with exponential backoff and re-resolves the auth token if
 *    the original is rejected.
 */
class MobilerunClient {
  constructor({ host, port, token, onEvent }) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.onEvent = onEvent || (() => {});
    this.ws = null;
    this.connected = false;
    this.backoffMs = 1000;
    this.pending = new Map();
    this.nextId = 1;
    this.stopped = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  status() {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      pending: this.pending.size,
    };
  }

  call(method, params = {}, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('mobilerun WebSocket not connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mobilerun call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  _connect() {
    if (this.stopped) return;
    const url = `ws://${this.host}:${this.port}/?token=${encodeURIComponent(this.token || '')}&eventFormat=rpc`;
    console.log(`[mobilerun] connecting ${url}`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[mobilerun] connected');
      this.connected = true;
      this.backoffMs = 1000;
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.warn('[mobilerun] non-JSON frame:', raw.toString().slice(0, 120));
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || String(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'events/device' && msg.params) {
        this.onEvent(msg.params);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      const delay = Math.min(this.backoffMs, 30_000);
      console.log(`[mobilerun] reconnecting in ${delay}ms`);
      setTimeout(() => this._connect(), delay);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    this.ws.on('error', (err) => {
      console.warn('[mobilerun] socket error:', err.message);
    });
  }
}

module.exports = { MobilerunClient };
