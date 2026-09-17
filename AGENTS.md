# BookTalk

Single-user web app: read a PDF alongside a real-time Gemini Live voice
assistant that always knows what page you're on. No auth, no DB.

## Layout

- `backend/` — FastAPI + PyMuPDF. In-memory PDF sessions, per-page text
  extraction, Gemini ephemeral token minting. API key stays server-side.
- `frontend/` — Vite + React + TS. pdf.js reader + `@google/genai` Live API
  over WebSocket (direct client-to-server, authed with an ephemeral token).

## Run (dev)

Two processes. From repo root:

```bash
# 1. Backend (FastAPI on :8000) — needs GEMINI_API_KEY in backend/.env
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# 2. Frontend (Vite on :5173) — proxies /api -> :8000
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Debugging the voice session

`DEBUGGING.md` (root) is the reference for the push-to-talk design above: what
was broken, how it was found, why the current design works, and a runbook for
when the assistant goes quiet again. The harnesses that produced that evidence
live in `tools/live-debug/` (protocol probes, a Chrome E2E with a synthetic
microphone, and a live watcher for a real session). Read it before changing
`LiveSession.ts`.

## Verification

- `cd frontend && npx tsc -b` — typecheck
- `cd frontend && npm run build` — production build
- Backend smoke: `curl http://127.0.0.1:8000/health` -> `{"ok":true}`

## Endpoints

- `POST /upload` (multipart `file`) -> `{session_id, page_count}`
- `GET /page?session=...&page=N` -> `{page, page_count, text, is_scanned}`
  (`is_scanned` true => frontend sends a JPEG frame to the Live session)
- `GET /token` -> `{token, model, expires_at}` (single-use ephemeral token)

## Key behaviors

- Push-to-talk only: the mic stream stays open, PCM is forwarded only while
  the button is held. The button **is** the turn boundary — press sends
  `activityStart`, release sends `activityEnd`, and automatic VAD is disabled
  on the session. With automatic VAD the release lands straight off the last
  word, the turn never commits (the audio is accepted, but no turn completes),
  and the question is silently swallowed. Measured: 0ms and 800ms of trailing
  silence still produced nothing; 1500ms worked. Explicit activity is
  deterministic and is what the app uses.
- Mic PCM is batched to ~64ms frames in the capture worklet before it reaches
  the socket (one render quantum would be a WebSocket message every ~2.7ms),
  and the worklet is flushed on release so the end of the last word survives.
- Page-turn context is injected silently: text goes through
  `sendClientContent({ turnComplete: false })`, which appends to the
  conversation without starting a model turn. Scanned/image pages send a JPEG
  frame via `sendRealtimeInput({ video })` plus a `clientContent` note — video
  frames are not "activity" and never trigger a reply on their own. Never use
  `sendRealtimeInput({ text })` for context: text counts as user activity
  there, so the model answers the page out loud instead of staying silent.
- Reconnects are guarded by a per-socket generation counter
  (`LiveSession.sessionGen`); callbacks from a socket that a newer `connect()`
  has superseded are ignored. Without it, closing the previous socket during a
  reconnect re-entered `scheduleReconnect()`, producing an endless
  Connecting…/Ready flicker and a spurious "connection keeps dropping"
  teardown. GoAway schedules the resume instead of connecting on top of the
  still-open socket. Context window compression + session resumption handle
  long reading sessions (the ~10-min Live connection limit).
- `thinkingLevel` is not supported by `gemini-3.8-live` (the server refuses the
  session with close code 1007). Time-to-first-audio is the model's own
  thinking time, so the UI stays in `thinking` until the first audio frame
  arrives; a watchdog recovers it if no turn progress arrives at all.
