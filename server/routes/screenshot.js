const express = require('express');
const { get } = require('../mobilerun-fetch');

/**
 * Mobilerun's HTTP /screenshot returns JSON `{status, result: <base64 png>}`,
 * not a binary PNG. We unwrap it here so the browser can use the route as a
 * normal <img src>. Uses the shared single-flight fetcher so concurrent
 * callers (e.g. browser + recording manager) share one upstream request.
 */
module.exports = function screenshotRoute({ http: phone }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const hideOverlay = req.query.hideOverlay === 'false' ? 'false' : 'true';
    // Default to JPEG q=75 — ~10x faster than mobilerun's default PNG q=100
    // for the live view. Callers that need archive-quality PNG (the recording
    // manager) can request format=png.
    const format = (req.query.format || 'jpeg').toLowerCase();
    const quality = req.query.quality || (format === 'jpeg' ? '75' : '100');
    try {
      const upstream = await get({
        host: phone.host,
        port: phone.port,
        token: phone.token,
        urlPath: `/screenshot?hideOverlay=${hideOverlay}&format=${format}&quality=${quality}`,
        key: `screenshot:${hideOverlay}:${format}:${quality}`,
      });
      if (upstream.status !== 200) {
        res.status(upstream.status).type('text/plain').send(upstream.body.toString('utf8'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(upstream.body.toString('utf8'));
      } catch (e) {
        res.status(502).json({
          error: 'malformed screenshot response',
          sample: upstream.body.toString('utf8').slice(0, 120),
        });
        return;
      }
      if (parsed.status !== 'success' || typeof parsed.result !== 'string') {
        res.status(502).json({ error: 'mobilerun returned error', detail: parsed });
        return;
      }
      const imageBytes = Buffer.from(parsed.result, 'base64');
      res.set('Cache-Control', 'no-store');
      res.type(format === 'jpeg' ? 'image/jpeg' : 'image/png').send(imageBytes);
    } catch (err) {
      res.status(502).json({ error: 'mobilerun unreachable', detail: err.message });
    }
  });

  return router;
};
