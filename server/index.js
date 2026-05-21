const path = require('path');
const express = require('express');

const { MobilerunClient } = require('./mobilerun-client');
const { TranscriptCollector } = require('./transcript-collector');
const { execAdb, getAuthToken } = require('./adb');
const { AppHistory } = require('./app-history');
const { RecordingManager } = require('./recording');
const transcriptRoute = require('./routes/transcript');
const screenshotRoute = require('./routes/screenshot');
const treeRoute = require('./routes/tree');
const gestureRoute = require('./routes/gesture');
const actionRoute = require('./routes/action');
const recordingRoute = require('./routes/recording');

const PORT = parseInt(process.env.PORT || '4000', 10);
const PHONE_HOST = process.env.PHONE_HOST || 'localhost';
const PHONE_HTTP_PORT = parseInt(process.env.PHONE_HTTP_PORT || '8080', 10);
const PHONE_WS_PORT = parseInt(process.env.PHONE_WS_PORT || '8081', 10);
const ADB_SERIAL = process.env.ADB_SERIAL || null;

async function main() {
  if (PHONE_HOST === 'localhost') {
    try {
      await execAdb(['forward', `tcp:${PHONE_HTTP_PORT}`, `tcp:${PHONE_HTTP_PORT}`], { serial: ADB_SERIAL });
      await execAdb(['forward', `tcp:${PHONE_WS_PORT}`, `tcp:${PHONE_WS_PORT}`], { serial: ADB_SERIAL });
    } catch (e) {
      console.warn('[adb forward] failed (continuing):', e.message);
    }
  }

  // Clear any leftover TalkBack auto-swipe state from a previous session.
  // The flag lives in TalkBackService across our restarts, so without this
  // sweep a UI without an auto-swipe Stop button would have no way to recover.
  try {
    await execAdb(
      [
        'shell', 'am', 'broadcast',
        '-n', 'com.android.talkback/com.google.android.accessibility.talkback.AccessibilityActionReceiver',
        '-a', 'com.balsdon.talkback.accessibility',
        '-e', 'ACTION', 'ACTION_STOP_AUTO_SWIPE',
      ],
      { serial: ADB_SERIAL },
    );
    console.log('[talkback] cleared auto-swipe state on startup');
  } catch (e) {
    console.warn('[talkback] could not clear auto-swipe state:', e.message);
  }

  const token = await getAuthToken({ serial: ADB_SERIAL });
  if (!token) {
    console.warn('[auth] Could not fetch token via ADB. Set MOBILERUN_TOKEN env var or expose ADB.');
  }

  const collector = new TranscriptCollector();
  const client = new MobilerunClient({
    host: PHONE_HOST,
    port: PHONE_WS_PORT,
    token: process.env.MOBILERUN_TOKEN || token,
    onEvent: (event) => collector.ingest(event),
  });
  client.start();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  const ctx = {
    collector,
    client,
    http: {
      host: PHONE_HOST,
      port: PHONE_HTTP_PORT,
      token: process.env.MOBILERUN_TOKEN || token,
    },
    adbSerial: ADB_SERIAL,
  };

  const appHistory = new AppHistory();
  const recordingManager = new RecordingManager({
    collector,
    phoneHttp: ctx.http,
    appHistory,
  });

  ctx.recordingManager = recordingManager;

  app.use('/api/transcript', transcriptRoute(ctx));
  app.use('/api/screenshot', screenshotRoute(ctx));
  app.use('/api/tree', treeRoute(ctx));
  app.use('/api/gesture', gestureRoute(ctx));
  app.use('/api/talkback-action', actionRoute(ctx));
  app.use('/api/recording', recordingRoute({ manager: recordingManager, appHistory }));

  app.get('/api/status', (_req, res) => {
    res.json({
      mobilerun: client.status(),
      phoneHost: PHONE_HOST,
      phoneWsPort: PHONE_WS_PORT,
      phoneHttpPort: PHONE_HTTP_PORT,
    });
  });

  app.listen(PORT, () => {
    console.log(`portal-web-ui listening on http://localhost:${PORT}`);
    console.log(`  phone WebSocket: ws://${PHONE_HOST}:${PHONE_WS_PORT}`);
    console.log(`  phone HTTP:      http://${PHONE_HOST}:${PHONE_HTTP_PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
