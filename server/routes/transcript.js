const express = require('express');

module.exports = function transcriptRoute({ collector, recordingManager }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(collector.snapshot({ limit }));
  });

  router.get('/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const write = (type, data) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    write('snapshot', collector.snapshot({ limit: 50 }));

    const onEntry = (entry) => write('entry', entry);
    const onBounds = (bounds) => write('bounds', bounds);
    const onScroll = (data) => write('view_scrolled', data);
    const onAction = (data) => write('action', data);
    const onGesture = (data) => write('gesture', data);
    const onClick = (data) => write('click', data);
    const onTextChange = (data) => write('text_change', data);
    const onAnnouncement = (data) => write('announcement', data);
    const onRecordingCapture = (data) => write('recording_capture', data);

    collector.on('entry', onEntry);
    collector.on('bounds', onBounds);
    collector.on('view_scrolled', onScroll);
    collector.on('action', onAction);
    collector.on('gesture', onGesture);
    collector.on('click', onClick);
    collector.on('text_change', onTextChange);
    collector.on('announcement', onAnnouncement);
    if (recordingManager) recordingManager.on('capture', onRecordingCapture);

    req.on('close', () => {
      collector.off('entry', onEntry);
      collector.off('bounds', onBounds);
      collector.off('view_scrolled', onScroll);
      collector.off('action', onAction);
      collector.off('gesture', onGesture);
      collector.off('click', onClick);
      collector.off('text_change', onTextChange);
      collector.off('announcement', onAnnouncement);
      if (recordingManager) recordingManager.off('capture', onRecordingCapture);
    });
  });

  return router;
};
