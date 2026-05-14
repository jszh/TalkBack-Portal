const express = require('express');
const { execAdb } = require('../adb');

const BROADCAST_ACTION = 'com.balsdon.talkback.accessibility';
// Android 8+ refuses implicit broadcasts to manifest-declared receivers, so we
// always target the receiver explicitly. Without -n, the broadcast completes
// (result=0) but TalkBack's receiver never runs.
const TARGET_COMPONENT =
  'com.android.talkback/com.google.android.accessibility.talkback.AccessibilityActionReceiver';

/**
 * Relays TalkBack ADB actions (ACTION_SWIPE_RIGHT, ACTION_START_AUTO_SWIPE, ...)
 * by shelling out to `adb shell am broadcast`. Targets the receiver explicitly
 * so the action is delivered on Android 8+.
 */
module.exports = function actionRoute({ adbSerial }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { action, params } = req.body || {};
    if (!action || typeof action !== 'string') {
      res.status(400).json({ error: 'action (string) required' });
      return;
    }
    const args = [
      'shell',
      'am',
      'broadcast',
      '-n',
      TARGET_COMPONENT,
      '-a',
      BROADCAST_ACTION,
      '-e',
      'ACTION',
      action,
    ];
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'number' && Number.isInteger(value)) {
          args.push('--ei', key, String(value));
        } else {
          args.push('-e', key, String(value));
        }
      }
    }
    try {
      const out = await execAdb(args, { serial: adbSerial });
      res.json({ ok: true, output: out.trim() });
    } catch (e) {
      res.status(502).json({ error: e.message, stderr: e.stderr });
    }
  });

  return router;
};
