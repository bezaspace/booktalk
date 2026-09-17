# `tools/live-debug` — Gemini Live API debugging harnesses

These scripts were used to diagnose and fix the BookTalk voice failures. The full
write-up (symptoms → root causes → evidence → fix → verification) is in
[`../../DEBUGGING.md`](../../DEBUGGING.md); this file is just how to run them.

They talk to the **real** Live API using ephemeral tokens from the local backend,
so the backend must be running (`:8000`) and `GEMINI_API_KEY` must be set.

## Setup

```bash
cd tools/live-debug
ln -sfn ../../frontend/node_modules node_modules   # scripts import @google/genai
export BH_DIR=/tmp/bh                              # scratch dir (default: /tmp/bh)
```

## 1. Generate test assets

```bash
cd backend && env PYTHONPATH=$PWD uv run python ../../tools/live-debug/gen_assets.py
```

Writes into `$BH_DIR`: a 12-page `test.pdf`, spoken questions from Gemini TTS
(`q1..q3.wav` at 24 kHz for the browser, `q1..q3.pcm` raw 16 kHz mono for protocol
tests), and `session.json` from `POST /upload`.

## 2. Protocol probes (no browser)

| Command | What it answers |
|---|---|
| `node probe.mjs label q1.pcm chunks100paced min` | Can the model answer audio at all, with a minimal config? Try `one`, `chunks100`, `chunks100paced`, `chunks20`. |
| `node probe2.mjs label gemini-3.8-live` | Liveness: does a **text** question get answered? (`WAIT_MS=180000` to extend the wait, optional 3rd arg is a `thinkingLevel`.) |
| `node probe4.mjs label q1.pcm explicit` | The turn-boundary matrix: `vad [tailMs]`, `vadflush2`, `explicit`, `explicittext`. This is the one that found the bug. |
| `env MODE=audio PROBE=1 node harness2.mjs` | Replays the app's config and PTT sequence; `MODE` is `audio`, `realtime` or `clientcontent`. |
| `node harness3.mjs` | Validates the intended design end-to-end (explicit activity + silent context + barge-in). |

Each prints a `VERDICT …` summary line — a good `herdr pane wait-output --match`
marker.

## 3. Browser tests (real app, synthetic microphone)

```bash
node e2e.mjs fixed runs-a         # launches its own Chrome, asserts 14 UI checks
BH_CDP_PORT=9344 node e2e.mjs fixed runs-b
```

`e2e.mjs` overrides `getUserMedia` before the app loads, feeding decoded TTS WAVs
into a `MediaStreamAudioDestinationNode`, then drives the real push-to-talk button
over CDP and asserts UI-level checks. It writes `e2e-*.log`, `console-*.log`,
`frames-*.log` and a screenshot into `$BH_DIR`.

## 4. Watching a human use the app

Launch a **dedicated** Chrome (keep the user's own browser out of it) from a
persistent terminal so it doesn't die with your shell:

```bash
google-chrome --remote-debugging-port=9333 --user-data-dir=/tmp/bh/chrome-user \
  --no-first-run --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
  http://localhost:5173/

LIVE_LOG=/tmp/bh/live.log node watch.mjs 9333 5173
```

`watch.mjs` streams console output, UI state changes, and every Live WebSocket
frame (control frames verbatim, audio summarized) to stdout and `$LIVE_LOG`.

Gotchas baked into these scripts, worth knowing if you edit them: WebSocket frame
payloads live at `msg.params.response.payloadData` and may be base64;
`Runtime.enable` replays buffered console messages (so you can read logs from
before you attached, but with unreliable timestamps).
