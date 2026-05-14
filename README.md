# TalkBack Recorder

Browser UI + HTTP API in front of Mobilerun Portal. Subscribes to the
forked TalkBack's `EXTERNAL_A11Y` event stream via mobilerun-portal's local
WebSocket, exposes a live transcript / screenshot / hierarchy view, and proxies
gestures and ADB broadcast actions. Records sessions to a zip containing an
events jsonl plus per-event screenshots and a11y trees.

## Architecture

```
         on the phone                      │      on the host
                                           │
  ┌─────────────────────┐                  │   ┌─────────────────────┐
  │ Mobilerun Portal    │ ── WS:8081 ───── │ ─▶│ Node :4000          │
  │  ExternalEventRcv   │                  │   │  TalkBack Recorder  │
  │  EventHub           │ ◀── HTTP:8080 ── │ ──│  SSE event stream   │
  │  HTTP / WS / shot   │                  │   │  screenshot proxy   │
  └─────────────────────┘                  │   │  record → zip       │
            ▲                              │   └──────────┬──────────┘
            │                              │              │
            │       (via adb forward, both lines)         │ HTTP + SSE
     broadcast Intent                      │              ▼
            │                              │   ┌─────────────────────┐
   ┌─────────────────────┐                 │   │ Browser             │
   │ TalkBack            │ ◀── adb am ──── │ ──│ http://localhost:4000│
   │ AccessibilityAction │     broadcast   │   └─────────────────────┘
   │     Receiver        │                 │
   │ (swipe / click /    │  (driven by the toolbar buttons clicked
   │  back / home)       │   from the Browser, relayed via Node)
   └─────────────────────┘                 │
                                           │
```

Two directions of data flow:

- **Events** (TalkBack → browser): forked TalkBack emits accessibility signals
  through `MobilerunBridge`, mobilerun-portal funnels them through its WebSocket,
  the Node server fans them out over Server-Sent Events to the browser.
- **Control** (browser → device): button clicks in the browser become either
  `adb shell am broadcast …` (TalkBack actions: swipe/click/back/home) or
  WebSocket JSON-RPC `tap` / `swipe` calls into mobilerun-portal (taps and
  swipes on the screenshot).

## Prerequisites

1. A device or emulator running:
   - **Forked Mobilerun Portal** (mobilerun-release.apk)
   - **Forked TalkBack** (talkback-release.apk).
2. Both services enabled in Settings → Accessibility.
3. `adb` reachable on the host (`adb devices` succeeds).
4. Node 18+.

## Run

```bash
npm install
npm start
```

Then open <http://localhost:4000>.

The server will automatically `adb forward` ports 8080 (HTTP) and 8081
(WebSocket) and resolve mobilerun's auth token via:

```
adb shell content query --uri content://com.mobilerun.portal/auth_token
```

Set `MOBILERUN_TOKEN` to override.

### Env vars

| Var               | Default     | Purpose                                        |
| ----------------- | ----------- | ---------------------------------------------- |
| `PORT`            | `4000`      | Local HTTP port for the UI                     |
| `PHONE_HOST`      | `localhost` | Mobilerun-portal host (after adb forward)      |
| `PHONE_HTTP_PORT` | `8080`      | Mobilerun-portal HTTP port                     |
| `PHONE_WS_PORT`   | `8081`      | Mobilerun-portal WebSocket port                |
| `MOBILERUN_TOKEN` | (auto)      | Override auth token instead of querying ADB    |
| `ADB_SERIAL`      | (none)      | Pass `adb -s <serial>` for multi-device setups |

## HTTP API

| Method | Path                              | Purpose                                                          |
| ------ | --------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/status`                     | Connection status + ports                                        |
| GET    | `/api/transcript?limit=100`       | Recent speech/hint/wrap/bounds/action snapshot                   |
| GET    | `/api/transcript/stream`          | Server-sent events: `entry`, `bounds`, `view_scrolled`, `action` |
| GET    | `/api/screenshot`                 | PNG from mobilerun `/screenshot`                                 |
| GET    | `/api/tree?full=true&filter=true` | Accessibility tree JSON                                          |
| POST   | `/api/gesture`                    | `{type:"tap",x,y}` or `{type:"swipe",x1,y1,x2,y2,durationMs}`    |
| POST   | `/api/talkback-action`            | `{action:"ACTION_SWIPE_RIGHT", params:{...}}`                    |

## What replaces what in the old TaskAudit logcat flow

| Old             | New                                                |
| --------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `adb logcat ... | grep 'execute() feedback=Feedback{...text=""..."'` | `EXTERNAL_A11Y` event with `subtype:"speech"`        |
| `adb logcat ... | grep 'hint="""'`                                   | `EXTERNAL_A11Y` event with `subtype:"hint"`          |
| `adb logcat ... | grep 'action=NAVIGATE.\*success=false'`            | `EXTERNAL_A11Y` event with `subtype:"wrap"`          |
| `adb logcat ... | grep 'Bounds=\['`                                  | `EXTERNAL_A11Y` event with `subtype:"bounds"`        |
| `adb logcat ... | grep 'ViewScrolled'`                               | `EXTERNAL_A11Y` event with `subtype:"view_scrolled"` |
