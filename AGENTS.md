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

- Push-to-talk only: mic stream open continuously, PCM forwarded to the Live
  session only while the button is held; `audioStreamEnd` flushes on release.
- Page-turn context is injected silently via `sendRealtimeInput` (text for
  text pages, JPEG video frame for scanned/image pages). The system
  instruction forbids the model from responding to context updates.
- Context window compression + session resumption handle long reading
  sessions (the ~10-min Live connection limit).
