# BookTalk — MVP Plan

## Overview

A single-user web app for reading a PDF alongside a real-time voice assistant that always knows what page you're on. Built for one user, no auth, no database — just a working MVP to validate the experience.

## User Experience

The user opens the app and is greeted with a clean, minimal upload screen — drag a PDF in or click to browse. Once uploaded, the app splits into two panels:

**Left — PDF Reader.** The document renders like any standard PDF reader: page navigation (prev/next, jump-to-page), scroll, and clear page boundaries. Nothing fancy — just a comfortable reading surface. The current page number is always visible.

**Right — Voice Assistant.** A vertical panel with:
- A large push-to-talk button (hold to speak, release to send). This is the only way to address the assistant — it never listens passively, so ambient noise, typing, or reading aloud to yourself won't trigger it.
- A live transcript showing what the user said and what the assistant replied (since voice can be missed or skimmed).
- A small status indicator (idle / listening / thinking / speaking).

**The core loop:** As the user reads and turns pages, the assistant silently receives the current page's content as context — it does not respond or interrupt on page changes. When the user holds the button and asks a question ("what does this term mean?", "can you explain this paragraph?", "give me background on this concept"), the assistant answers in natural voice, grounded in whatever page the user is currently on. If the assistant is mid-speech and the user presses the button to interrupt, playback stops immediately and the new question takes over.

The whole thing should feel like reading a book with a knowledgeable friend sitting next to you who can see the page you're on and only speaks when you ask.

## Tech Stack

- **Frontend**: Vite + React + TypeScript
- **PDF rendering**: `pdfjs-dist` (client-side, canvas)
- **Live API**: `@google/genai` (client-side WebSocket, direct to Google)
- **Audio**: Native Web Audio API (mic capture at 16kHz PCM; playback at 24kHz PCM)
- **Backend**: FastAPI + PyMuPDF
- **Model**: `gemini-3.1-flash-live-preview`
- **Auth/DB**: None. Ephemeral tokens only — API key stays server-side.

## Backend (minimal, no DB)

- `POST /upload` — accept PDF, hold in memory keyed by a session ID, return page count.
- `GET /page?session=...&page=N` — extract that single page's text with PyMuPDF (~1.3ms/page) and return it. Empty text signals a scanned/image page.
- `GET /token` — mint and return a Gemini ephemeral token.

## Frontend — Three Concerns

1. **PDF panel**: pdf.js renders current page to canvas. Page nav + scroll. On page change, fetch page text from backend.
2. **Voice panel**: push-to-talk button. While held, stream mic PCM to Live session. On release, send `audioStreamEnd`. Play back model PCM. Show live transcript via input/output transcription fields.
3. **Context bridge**: on every page change, update the Live session's context silently:
   - **Text page**: `sendRealtimeInput({ text })` with the page content and an instruction not to respond unless asked.
   - **Scanned/image page**: render the canvas to JPEG and send as a video frame via `sendRealtimeInput({ video })`. No OCR needed — the model sees the page.
   - Enable **context window compression** on the session for long reading sessions.

## Key Behaviors

- **Push-to-talk only** — no always-on VAD. Mic stream stays open but is only forwarded while the button is held.
- **Interruption** — releasing the button during assistant speech clears the playback queue; new input cuts off the model server-side. Also handle `interrupted` events as a safety net.
- **Page-aware context** — silent injection on every page turn. The model never volunteers commentary unless asked.
- **Scanned PDFs** — handled for free via image frames.
- **Session resumption** — implement to survive the ~10-min Live connection limit during long reading sessions.
- **Transcript panel** — shows both sides of the conversation.

## Out of Scope for v1

- Authentication, multi-user, persistence/database
- OCR (Tesseract, cloud OCR) — image frames cover scanned PDFs
- Continuous video / screen-share mode
- Pre-extraction of all pages (extract per-page on demand instead)

## Build Order

1. FastAPI backend (upload, per-page text, ephemeral token)
2. Frontend scaffold + PDF viewer
3. Live session wiring (connect, push-to-talk, audio I/O, transcript)
4. Page-turn context injection (text + image fallback)
5. Session resumption + polish
