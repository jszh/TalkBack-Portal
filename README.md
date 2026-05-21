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

## Auto-crawl

Upload a JSONL of actions in the header (⤓ Auto-crawl…). When you press
Record, the actions are replayed in order; pressing Stop (or removing the
file with ×) cancels the replay. Between most actions the front-end waits
the event-settle window plus a 1-second buffer. After a `tap` or `click`
(which often navigate or load content) the wait is dynamic: up to 5
seconds total, but ending 1.6 seconds after the first TalkBack
announcement if that's sooner. Additionally, after the base wait, the
loop holds until the most recent server-side recording screenshot is at
least 500 ms old, so the next action never fires before the screenshot
for the current focus has finished writing. A `⏸ Pause / ▶ Resume` button
next to the file name suspends and resumes the replay at any time, and a
`{"action":"wait"}` row pauses the replay automatically until Resume is
clicked.

One verb per row — backend details (`ACTION_` prefix, `PARAMETER_TEXT`, the
gesture/broadcast split) are hidden and translated in code:

| `action` | Required        | Optional      | Notes                                |
| -------- | --------------- | ------------- | ------------------------------------ |
| `tap`    | `x`, `y`        | —             | coordinate tap                       |
| `swipe`  | `x1,y1,x2,y2`   | `durationMs`  | coordinate swipe                     |
| `swipe_left` / `swipe_right` / `swipe_up` / `swipe_down` | — | `params` | TalkBack directional swipe |
| `click` / `long_click`                                   | — | `params` | TalkBack click on focused element |
| `back` / `home`                                          | — | —        | system nav                       |
| `say`                                                    | `text` | —    | speak text                       |
| `wait`                                                   | — | `seconds` | sleep N seconds; without `seconds`, pause until Resume |
| any other verb                                           | — | `params` | passthrough → `ACTION_<UPPER>`   |

See [`examples/auto-crawl.jsonl`](examples/auto-crawl.jsonl) for a runnable
example, or:

```jsonl
{"action": "tap", "x": 540, "y": 1200}
{"action": "swipe_right"}
{"action": "swipe", "x1": 800, "y1": 1500, "x2": 200, "y2": 1500, "durationMs": 300}
{"action": "say", "text": "starting test"}
{"action": "wait", "seconds": 3}
{"action": "click"}
{"action": "wait"}
{"action": "back"}
```

### Status panel + transcript annotations

While a JSONL is loaded, a status panel appears above the transcript listing
every action in the file. As the replay advances, the current line is
highlighted and auto-centered (lyrics-style); previous lines dim. Click any
entry to select it — a `Jump here` button appears on the row. Clicking it
while a recording is running snaps the replay to that action immediately
(interrupting any in-flight wait, settle, or pause). The pause / resume
button stays visible for the entire recording, so you can pause before the
first action, between actions, or after the replay finishes.

Every action — whether replayed from the JSONL, fired from a toolbar
button, typed into the `say` input, tapped/swiped on the screenshot, or
emitted by TalkBack from a physical touch — lands in the transcript as
its own card with the concrete params (e.g. `tap (540, 1200)`,
`swipe (800,1500→200,1500) 300ms`, `say "hello"`). Actions are never
merged into the focus card that follows; the next focus event renders
separately with TalkBack's announcements.

### `user_actions.jsonl` in saved recordings

Every action that affects TalkBack — whether dispatched from the browser
UI (auto-crawl row, toolbar button, `say`, pointer on the screenshot) or
performed directly on the device (physical touch, double-tap, swipe with
fingers) — is appended to a standalone `user_actions.jsonl` inside the
zip. Each row has its own `timestamp_ms` (relative to session start) so
fast sequences and actions that produce no TalkBack feedback are still
preserved. The `source` field distinguishes them:

```jsonl
{"session_id":"...","seq":1,"timestamp_ms":1820,"source":"browser","action":"swipe_right"}
{"session_id":"...","seq":2,"timestamp_ms":2110,"source":"browser","action":"swipe_right"}
{"session_id":"...","seq":3,"timestamp_ms":4905,"source":"browser","action":"tap","x":540,"y":1200}
{"session_id":"...","seq":4,"timestamp_ms":7110,"source":"browser","action":"say","text":"hello"}
{"session_id":"...","seq":5,"timestamp_ms":9220,"source":"phone","action":"swipe_right"}
{"session_id":"...","seq":6,"timestamp_ms":9840,"source":"phone","action":"click","resource_id":"...","class":"...","text":"Open"}
```

Browser-initiated `ACTION_*` broadcasts (toolbar buttons, `say`,
auto-crawl rows) echo back through TalkBack's SSE stream as an
`'action'` event, followed shortly after by a `'gesture'` or `'click'`
event as TalkBack performs the action. The server uses the `'action'`
SSE itself as the dedup anchor — TalkBack only emits it in response
to an ADB broadcast we sent, never from phone-side user input. The
`'action'` row is dropped, and any `'gesture'` / `'click'` SSE that
lands within ~500 ms of it is dropped too. Anything outside that
window is recorded as `source: "phone"`, so a genuine phone-side
swipe one second after a browser swipe is preserved cleanly.
`events.jsonl` continues to hold TalkBack feedback (focus / wrap /
announcement / type / session_start), and the two files share
`timestamp_ms` for correlation.

## What replaces what in the old TaskAudit logcat flow

| Old             | New                                                |
| --------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `adb logcat ... | grep 'execute() feedback=Feedback{...text=""..."'` | `EXTERNAL_A11Y` event with `subtype:"speech"`        |
| `adb logcat ... | grep 'hint="""'`                                   | `EXTERNAL_A11Y` event with `subtype:"hint"`          |
| `adb logcat ... | grep 'action=NAVIGATE.\*success=false'`            | `EXTERNAL_A11Y` event with `subtype:"wrap"`          |
| `adb logcat ... | grep 'Bounds=\['`                                  | `EXTERNAL_A11Y` event with `subtype:"bounds"`        |
| `adb logcat ... | grep 'ViewScrolled'`                               | `EXTERNAL_A11Y` event with `subtype:"view_scrolled"` |
