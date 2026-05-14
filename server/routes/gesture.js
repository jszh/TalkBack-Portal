const express = require('express');

module.exports = function gestureRoute({ client }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { type } = req.body || {};
    try {
      let result;
      if (type === 'tap') {
        const { x, y } = req.body;
        result = await client.call('tap', { x, y });
      } else if (type === 'swipe') {
        // mobilerun ActionDispatcher reads startX/startY/endX/endY (not x1/y1/x2/y2).
        const { x1, y1, x2, y2, durationMs } = req.body;
        result = await client.call('swipe', {
          startX: x1, startY: y1, endX: x2, endY: y2,
          duration: durationMs || 200,
        });
      } else {
        res.status(400).json({ error: `unknown gesture type: ${type}` });
        return;
      }
      res.json({ ok: true, result });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
};
