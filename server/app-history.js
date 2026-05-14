const fs = require('fs');
const path = require('path');

/**
 * Tiny persistent JSON store for autocomplete history of app_id values.
 * One JSON file in the project root; entries are ordered most-recently-used
 * first.
 */
class AppHistory {
  constructor({ filePath, maxEntries = 50 } = {}) {
    this.filePath = filePath || path.join(__dirname, '..', 'app-history.json');
    this.maxEntries = maxEntries;
    this._cache = null;
  }

  async list() {
    if (this._cache != null) return [...this._cache];
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this._cache = Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch (e) {
      this._cache = [];
    }
    return [...this._cache];
  }

  async add(appId) {
    if (!appId || typeof appId !== 'string') return;
    const trimmed = appId.trim();
    if (!trimmed) return;
    const current = await this.list();
    const filtered = current.filter((v) => v !== trimmed);
    filtered.unshift(trimmed);
    const next = filtered.slice(0, this.maxEntries);
    this._cache = next;
    try {
      await fs.promises.writeFile(this.filePath, JSON.stringify(next, null, 2));
    } catch (e) {
      console.warn('[app-history] failed to persist:', e.message);
    }
  }
}

module.exports = { AppHistory };
