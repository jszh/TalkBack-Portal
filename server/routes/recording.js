const express = require('express');

module.exports = function recordingRoute({ manager, appHistory }) {
  const router = express.Router();
  // Track the most recent stopped session, awaiting finalize.
  let pending = null;

  router.get('/status', (_req, res) => {
    res.json({
      ...manager.status(),
      hasPending: !!pending,
      pendingId: pending ? pending.id : null,
      pendingEventCount: pending ? pending.events.length : 0,
      pendingCaptureCount: pending ? pending.captures.length : 0,
    });
  });

  router.post('/start', async (_req, res) => {
    // If there is a stopped-but-not-finalized session, discard it.
    if (pending) {
      try { require('fs').rmSync(pending.dir, { recursive: true, force: true }); } catch (_) {}
      pending = null;
    }
    res.json(await manager.start());
  });

  router.post('/stop', async (_req, res) => {
    if (pending) {
      res.status(409).json({ error: 'a recording is already pending finalize', pending: pending.id });
      return;
    }
    const session = await manager.stop();
    if (!session) {
      res.status(400).json({ error: 'no active recording' });
      return;
    }
    pending = session;
    res.json({
      ok: true,
      id: session.id,
      eventCount: session.events.length,
      captureCount: session.captures.length,
      startTime: session.startTime,
    });
  });

  router.post('/capture', async (_req, res) => {
    if (!manager.isActive()) {
      res.json({ ok: false, reason: 'not recording' });
      return;
    }
    try {
      await manager.manualCapture();
      res.json({ ok: true, ...manager.status() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/cancel', (_req, res) => {
    if (manager.isActive()) manager.cancel();
    if (pending) {
      try { require('fs').rmSync(pending.dir, { recursive: true, force: true }); } catch (_) {}
      pending = null;
    }
    res.json({ ok: true });
  });

  router.get('/apps', async (_req, res) => {
    const list = await appHistory.list();
    res.json({ apps: list });
  });

  router.post('/finalize', async (req, res) => {
    if (!pending) {
      res.status(400).json({ error: 'no pending recording to finalize. POST /stop first.' });
      return;
    }
    const session = pending;
    try {
      await manager.finalize(session, req.body || {}, res);
      pending = null;
    } catch (e) {
      console.error('[recording] finalize failed:', e);
      if (!res.headersSent) {
        res.status(400).json({ error: e.message });
      }
    }
  });

  return router;
};
