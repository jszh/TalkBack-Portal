const express = require('express');
const { get } = require('../mobilerun-fetch');

/**
 * Mobilerun wraps every HTTP response in `{status, result, ...}`. For the tree
 * endpoints `result` is itself a JSON-stringified tree, so we unwrap and
 * re-parse to surface the tree as plain JSON. Uses the shared single-flight
 * fetcher to dedupe concurrent callers.
 */
module.exports = function treeRoute({ http: phone }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const full = req.query.full === 'true' || req.query.full === '1';
    const filter = req.query.filter == null ? '' : `?filter=${encodeURIComponent(req.query.filter)}`;
    const upstreamPath = full ? `/a11y_tree_full${filter}` : `/a11y_tree`;
    try {
      const upstream = await get({
        host: phone.host,
        port: phone.port,
        token: phone.token,
        urlPath: upstreamPath,
        key: `tree:${upstreamPath}`,
      });
      if (upstream.status !== 200) {
        res.status(upstream.status).type('text/plain').send(upstream.body.toString('utf8'));
        return;
      }
      const bodyText = upstream.body.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch (e) {
        res.status(502).json({ error: 'malformed tree response', sample: bodyText.slice(0, 120) });
        return;
      }
      if (parsed.status !== 'success') {
        res.status(502).json({ error: 'mobilerun returned error', detail: parsed });
        return;
      }
      const result = parsed.result;
      if (typeof result === 'string') {
        try {
          res.json(JSON.parse(result));
        } catch (_) {
          res.type('text/plain').send(result);
        }
      } else {
        res.json(result);
      }
    } catch (err) {
      res.status(502).json({ error: 'mobilerun unreachable', detail: err.message });
    }
  });

  return router;
};
