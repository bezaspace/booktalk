# BookTalk voice debugging — what broke, how we found it, and why the fix works

A full write-up of the investigation into "the voice assistant answers the first
question, then gets stuck in _Thinking…_ or flickers between _Connecting…_ and
_Ready_". Read this before changing anything in `frontend/src/voice/LiveSession.ts`.
The reusable part is [§7 Methodology](#7-methodology-how-to-debug-this-class-of-bug)
and the [§9 runbook](#9-runbook-the-assistant-went-quiet-again).

- Harnesses used for all of this: `tools/live-debug/`
- Fixed in: `frontend/src/voice/LiveSession.ts`
- Model under test: `gemini-3.8-live`, `@google/genai` 2.22.0, API version `v1alpha`

---

## 1. TL;DR

Three independent bugs, all of which had to be fixed:

| # | Bug | Effect | Fix |
|---|-----|--------|-----|
| 1 | **The push-to-talk turn was never closed.** Audio was streamed while the button was held, then `audioStreamEnd` was sent immediately after the last spoken sample. With automatic VAD the server needs trailing silence to commit end-of-speech, so the turn stayed open forever. | The question was silently swallowed: no input transcript, no answer, UI stuck in `Thinking…` until a 30 s watchdog. Once wedged, the session ignored *all* further input until restarted. | Disable automatic VAD (`automaticActivityDetection.disabled = true`) and make the button the turn boundary: press → `activityStart`, release → `activityEnd`. |
| 2 | **Page context was sent as realtime text.** `sendRealtimeInput({ text })` counts as *user activity*, so the model answered the page out loud instead of treating it as silent context. | The assistant narrated whatever page you turned to, and those unsolicited turns collided with the user's own questions. | Send page text with `sendClientContent({ turns, turnComplete: false })`, which appends to the conversation without starting a model turn. Keep `sendRealtimeInput({ video })` for scanned pages (video is not activity). |
| 3 | **Reconnect storm.** `connect()` set `intentionallyClosed = false` and then closed the previous socket; that socket's `onclose` therefore scheduled another reconnect, which closed the new socket, and so on. | Endless `Connecting…`/`Ready` flicker, then a bogus "Voice connection keeps dropping (5x, …)" teardown. | Per-socket generation counter: callbacks from a superseded socket are ignored. GoAway schedules a resume instead of connecting on top of a live socket. |

A fourth change is hygiene, not a bug fix: mic audio is now batched to ~64 ms
frames instead of one WebSocket message every ~2.7 ms (see §5).

**Evidence that the fix landed** — the user's own live session, observed on the wire:

```
--> setup model=models/gemini-3.8-live generationConfig={"responseModalities":["AUDIO"]}
--> {"clientContent":{"turns":[{"parts":[{"text":"[CONTEXT — page 61 of 770 …
    … 0 server frames came back from the page context  ✔ silent
[Live] PTT start — activityStart. speaking=false queueLen=0
--> realtimeInput {"activityStart":{}}
[Live] PTT end — activityEnd. chunks=28
--> realtimeInput {"activityEnd":{}}
<-- serverContent IN "Hey, please explain what's going on here."      (330 ms after release)
[Live] PTT start — activityStart. speaking=true queueLen=21            (barge-in)
<-- serverContent INTERRUPTED
<-- serverContent TURN_COMPLETE
<-- serverContent IN "Could you please explain using real world examples, please?"
```

---

## 2. The symptoms, as reported

> "When I upload the PDF of any book and go onto any page and ask it any
> question, initially it's trying to answer about what's there on the page but
> eventually as I ask the next question or interrupt it using PTT and ask some
> other questions, it just stays either in thinking, stuck in thinking or its
> state is always flickering between connecting and ready."

Three distinct complaints in there, and they were three different bugs:

1. "**initially it's trying to answer about what's there on the page**" → bug 2
   (it really was answering the page, unprompted).
2. "**stuck in thinking**" → bug 1 (the turn never closed, so there was nothing
   to complete).
3. "**flickering between connecting and ready**" → bug 3 (reconnect storm).

The app's own console output from the user's failed question, captured live:

```
[Live] PTT start — interrupting playback. speaking=true queueLen=27
[Live] INTERRUPTED — stopping playback. pttHeld=true queueLen=7 speaking=true
[Live] turnComplete. speaking=false queueLen=0 pttHeld=true
[Live] PTT end — flushing audioStreamEnd. chunks=1331          # ≈3.5 s of speech
[Live] no server activity after flush — sending silence kick   # the 120 ms band-aid
[Live] thinking watchdog fired — no server activity, recovering
error toast: "Didn't catch a response — the mic audio may not have arrived."
```

`chunks=1331` tells you the audio *was* captured and sent (1331 chunks × 42
samples ≈ 3.5 s). The failure was not "the mic didn't work".

---

## 3. Root cause 1 — the turn never closed (the important one)

### What the code did

`LiveSession` opened an always-on mic stream, forwarded PCM only while the
push-to-talk button was held, and on release sent:

```ts
this.session.sendRealtimeInput({ audioStreamEnd: true })
```

That is the documented pattern ("when the audio stream is paused … send an
`audioStreamEnd` event to flush any cached audio") and it looks correct. It is
not sufficient here, because **with automatic VAD the server still has to decide
that the user's turn ended**, and it decides that from *silence*.

### The experiment that proved it

`tools/live-debug/probe4.mjs` sends the same real spoken question (TTS-generated,
16 kHz PCM, 4.88 s) under four different turn-boundary strategies:

| Variant | What is sent | Result |
|---|---|---|
| `vad`, 0 ms silence | audio → `audioStreamEnd` (what the app did) | ❌ `turnCompletes=0`, no transcript, no audio, **no error** |
| `vad`, 800 ms silence | audio + 800 ms silence → `audioStreamEnd` | ❌ still nothing |
| `vad`, 1500 ms silence | audio + 1500 ms silence → `audioStreamEnd` | ✅ transcript + answer (`firstResponse=10.5s`, 28 audio chunks) |
| `explicit` | VAD disabled: `activityStart` → audio → `activityEnd` | ✅ transcript + answer (`firstResponse=10.9s`, 32 audio chunks) |
| `explicit` then text | as above, then a text question | ✅ audio turn **and** the follow-up text turn both answered |

And with the app's exact config and sequence (`harness.mjs` / `harness2.mjs`),
**nine consecutive audio turns produced zero server responses** — while the
sessions stayed open, healthy-looking, emitting only `setupComplete` and
`resumptionUpdate`, and eventually dying with close code `1006`.

### The signature that made this confusing

The audio **was** accepted. In the very first harness run, ~640 ms into the user's
speech the server sent:

```
EVENT INTERRUPTED
EVENT TURN_COMPLETE
```

i.e. **VAD detected the speech and even interrupted the model** — but the turn
was never finalized. So "did the audio arrive?" and "did the turn close?" are two
different questions, and only the second one was broken. That asymmetry is the
fingerprint of this failure: *speech detection working is not evidence that the
turn boundary works.*

### Consequence: the session wedges

Once a turn is left open, the session stops responding to everything — including
`sendRealtimeInput({ text })`. In `probe.mjs`/`harness2.mjs`, after the audio turn
failed, a follow-up text question also produced nothing in 20 s across every
variant. This is why the user saw "the first question works, then it's dead until
I press Start again": recovery required a fresh session.

### Why the "silence kick" didn't save it

The code already anticipated this failure and added a band-aid: if no server
content arrives 6 s after the flush, send 120 ms of silence plus a second
`audioStreamEnd`. The probe matrix above shows 800 ms is still not enough, so
120 ms was never going to work. It also only fired once the UI was already
stuck in `Thinking…`.

### The fix

Disable automatic VAD and let the button define the turn:

```ts
realtimeInputConfig: {
  turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
  automaticActivityDetection: { disabled: true },
},
```

```ts
startPushToTalk() { … this.session.sendRealtimeInput({ activityStart: {} }) … }
endPushToTalk()   { … this.session.sendRealtimeInput({ activityEnd: {} }) … }
```

Note that `audioStreamEnd` must **not** be sent in this configuration — the docs
are explicit: *"An `audioStreamEnd` isn't sent in this configuration. Instead, any
interruption of the stream is marked by an `activityEnd` message."*

Two details worth keeping:

- **Lazy-safe close.** Release before any audio was forwarded still closes the
  activity (so the server isn't left mid-activity) but does *not* switch the UI to
  `Thinking…`, because no answer can be coming.
- **Flush the worklet first.** On release the code asks the capture worklet for
  its partially filled batch, waits 30 ms, then sends `activityEnd`. Without the
  flush, up to 64 ms of the last word would still be sitting in the worklet.

### Why it works

With explicit activity the turn boundary is a client-controlled event, not an
inference. There is no silence-detection threshold to fall under, no dependence
on how abruptly the user releases the button, and the failure mode disappears for
every release timing. Measured: the input transcript now arrives ~270–330 ms
after release in every turn (see §1), including when the user interrupts the
model mid-sentence.

---

## 4. Root cause 2 — page context was a spoken turn

### What the code did

```ts
injectTextPage(page, pageCount, text) {
  this.session.sendRealtimeInput({ text: `[CONTEXT — page …] ${text}` })
}
```

The system instruction says "page-turn context updates are NOT questions. Stay
silent on every page change". The instruction was not the problem — the *channel*
was.

### Why it happened

Both voice **and text** delivered through `sendRealtimeInput` count as user
activity. From the installed SDK (`LiveServerContent` /
`AutomaticActivityDetection` docs in `@google/genai` 2.22.0):

> "If enabled, detected voice **and text** input count as activity."

and activity handling defaults to `START_OF_ACTIVITY_INTERRUPTS`. So injecting a
page of text starts a turn, exactly like speaking does. Observed:

- `harness.mjs`, page injected → empty server message 550 ms later → model turn
  → (interrupted by the user's speech shortly after).
- `probe2.mjs`, plain text input → `audio:1` + `OUT "Hello."` in 3.9 s.

That is the "it's trying to answer about what's on the page" symptom: the app was
literally asking the model to talk about the page.

### The fix

```ts
this.session.sendClientContent({
  turns: [{ role: 'user', parts: [{ text: payload }] }],
  turnComplete: false,     // append context, do NOT start a turn
})
```

`LiveClientContent.turnComplete` documents exactly this: *"If true … the server
content generation should start with the currently accumulated prompt. Otherwise,
the server will await additional messages before starting generation."*

For scanned/image pages the JPEG frame stays on `sendRealtimeInput({ video })` —
video is **not** activity and never triggers a reply by itself (with
`turnCoverage: TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO` the frame is attached
to the next real turn) — and the accompanying note text moved to
`sendClientContent` like everything else.

### Verified

- Protocol harness: page injected 3–4 times per run, `model stayed silent: true`
  every time, and the answers were still grounded in the injected page.
- Real app, user's session: page-61 injection → **0 server frames**.
- Automated E2E: `CHECK PASS — page context does not trigger speech`.

### Caveat found while testing

Injecting `clientContent` *while the model is mid-turn* can cut that turn short
(`INTERRUPTED` + `TURN_COMPLETE`). For a reading companion that is defensible —
you turned the page, the assistant should move on — but if that ever becomes
undesirable, it needs to be handled deliberately (e.g. queue the injection until
`turnComplete`).

---

## 5. Contributing issue — 375 audio messages per second

The capture worklet posted one message per `process()` call, i.e. one per 128-sample
render quantum. At 48 kHz that downsamples to **42 samples ≈ 2.7 ms**, so a single
push-to-talk burst emitted **~375 WebSocket messages/second** (the user's 3.5 s
question = 1331 messages). The Live API expects 20–100 ms chunks.

Fixed by accumulating ~64 ms (1024 samples at 16 kHz) inside the worklet and
posting whole batches, with a `{ cmd: 'flush' }` message so the release path can
drain the partial batch.

**Important:** this was *not* the cause of the hangs. Probes at ~2.7 ms, 20 ms and
100 ms chunking all failed identically before the turn-boundary fix, and all
succeeded after it. Treat this as hygiene (CPU, frame overhead, burstiness), and
don't expect chunk size alone to fix a silent-turn bug.

---

## 6. Root cause 3 — the reconnect storm

### The bug, in the code

```ts
async connect() {
  this.intentionallyClosed = false          // (1)
  …
  if (this.session) { this.session.close() } // (2) old socket's onclose fires …
  this.session = await this.client.live.connect({ … onclose: (e) => {
      if (this.intentionallyClosed) return   // (3) … false, so it does NOT return
      …
      this.scheduleReconnect()               // (4) schedules another connect()
  }})
}
```

Every reconnect closes the socket it is replacing, that socket's `onclose` is no
longer "intentional", so it schedules another reconnect — which closes the
*new* socket, whose `onclose` schedules another… The `earlyCloses` counter then
trips ("opened fine but died young"), producing the red
"Voice connection keeps dropping (Nx, …)" toast on top of the flicker. GoAway made
it worse: the app reconnected *immediately* on GoAway, so the old socket was
superseded while still open, guaranteeing the loop started.

### The fix

```ts
const gen = ++this.sessionGen
const isCurrent = () => gen === this.sessionGen
// every callback starts with: if (!isCurrent()) return
```

plus `close()` bumping `sessionGen` so in-flight callbacks from a session we just
tore down are inert, and GoAway scheduling a resume after a short delay instead of
connecting on top of a live socket:

```ts
if (msg.goAway) {
  if (!this.goAwayTimer) this.goAwayTimer = setTimeout(() => this.scheduleReconnect(), 1500)
  return
}
```

### Verification status — read this before trusting it

This fix is **verified by construction and code review, not by reproducing the
storm**. Chrome's `Network.emulateNetworkConditions({offline:true})` did not
actually drop the open WebSocket in the E2E run (0 reconnect schedules were
logged, 0 superseded closes observed), so the guard was never exercised live. If
reconnect flapping is ever suspected again, reproduce it deliberately — e.g. kill
the socket from the server side, or add a temporary test hook that closes the
socket — and confirm you see `ignoring close from superseded socket` lines.

---

## 7. Methodology: how to debug this class of bug

### 7.1 Split the problem into layers first

The reported symptom mixed three layers, and every guess made at the wrong layer
wasted time. The layers, and what a failure looks like at each:

| Layer | Question | Failure smells like |
|---|---|---|
| Client state machine | Does the UI reflect a session that exists? | Status flapping, PTT enabled while disconnected, `sessionActive` true with a dead socket |
| Protocol / turn boundary | Did the client send a *complete* turn? | No `IN` transcript; "thinking" with no server frames; session silently ignores input |
| Model / config | Does the model answer at all? | Session answers text but not audio (or vice versa); close code `1007`; very long thinking |

The single most useful diagnostic question during this investigation was:

> **Did the input transcript arrive?**
> - **No `IN "…"` after release** → protocol/turn-boundary problem (bug 1).
> - **`IN` but no `modelTurn` audio** → model/config/thinking problem.
> - **Audio but no `turnComplete`** → turn-pacing problem (see §8.5).

### 7.2 Harnesses (in `tools/live-debug/`)

Run them in parallel panes; they hit the real API and cost nothing but time.

| Script | Purpose |
|---|---|
| `gen_assets.py` | Generates a 12-page test PDF, TTS-spoken questions (`.wav` for the browser + `.pcm` 16 kHz for protocol tests), uploads the PDF, writes `session.json`. |
| `probe.mjs` | Minimal config + one audio file, sent as one blob / 100 ms paced / 20 ms. Answers "can this model answer audio at all, with this config?" |
| `probe2.mjs` | Text-only, long wait, optional `thinkingLevel`. Answers "does the session respond at all?" — a text probe is the fastest liveness check. |
| `probe4.mjs` | The turn-boundary matrix (§3). The single most valuable script here. |
| `harness.mjs` / `harness2.mjs` | Replays the app's exact config and PTT sequence, with per-turn metrics and every raw server message logged. |
| `harness3.mjs` | Validates a *candidate* design end-to-end before touching app code: explicit activity, silent `clientContent` context, barge-in. |
| `e2e.mjs` | Drives the **real app** in Chrome with a synthetic microphone and asserts UI-level checks (see §7.4). |
| `watch.mjs` | Attaches to the user's live Chrome and streams console + every Live WebSocket frame + UI state. Use this while a human tests. |

### 7.3 Read the SDK, not just the docs

The installed SDK's `.d.ts` and bundled JS are the authoritative spec for the
version actually in use. Three facts that mattered here came from
`frontend/node_modules/@google/genai/dist/genai.d.ts`, not from the web docs:

- text counts as activity;
- `turnCompleteReason` / `waitingForInput` / `interactionStatus` exist on
  `LiveServerContent` and are worth logging;
- `generationComplete` is followed by `turnComplete` only *after* the model
  believes realtime playback has finished.

`sdk version drift also matters`: a cached skill claimed
`gemini-3.1-flash-live-preview` was "the recommended model" and that
`gemini-2.5-flash-native-audio-preview-*` was deprecated, while the live docs'
session-management page used `gemini-3.8-live` and the account's own `models.list`
had `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`,
`gemini-3.1-flash-live-preview` and more. **Trust `models.list` and the live docs
over any cached text**, including `AGENTS.md` and skills.

```bash
cd backend && uv run python -c "
from google import genai; from app.config import get_settings
c = genai.Client(api_key=get_settings().gemini_api_key, http_options={'api_version':'v1alpha'})
print([m.name for m in c.models.list(config={'page_size':200}) if 'live' in m.name])"
```

### 7.4 Observing the browser without disturbing the user

Two lessons, both learned the hard way:

- **Never attach to the user's main Chrome.** A running Chrome with no
  `--remote-debugging-port` cannot be attached to, and enabling it requires a
  browser restart. Launch a *dedicated* window instead — the user's tabs stay
  untouched and you get a clean profile:

  ```bash
  google-chrome --remote-debugging-port=9333 --user-data-dir=/tmp/bh/chrome-user \
    --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
    http://localhost:5173/
  ```

  **Launch it from a persistent pane** (herdr), not from a shell that ends with
  the command — the browser dies with the shell and the user sees a window open
  and vanish.

- **Inject a synthetic microphone instead of capturing audio.** Overriding
  `getUserMedia` before page scripts run makes the app consume real spoken audio
  with no mic and no flakiness (`e2e.mjs`, `MIC_SHIM`): create an `AudioContext`,
  a `MediaStreamAudioDestinationNode`, and return `dest.stream` from
  `getUserMedia`; then `decodeAudioData` a TTS-generated WAV and play it into the
  destination on demand. Combined with `--autoplay-policy=no-user-gesture-required`
  this is fully deterministic.

- **CDP gotchas that cost real time:**
  - WebSocket frame payloads are at `msg.params.response.payloadData`, *not*
    `msg.params.payloadData` (the latter is `undefined`, which silently degrades
    every frame to "unparsed 9B").
  - Those payloads may be base64 for WebSocket frames — decode before
    `JSON.parse`, or you cannot read the server's messages at all.
  - `Runtime.enable` **replays** buffered console messages, so you can read logs
    emitted *before* you attached (this is how the user's failed session was
    captured after the fact). Replayed lines all share the attach timestamp, so
    ordering is reliable but timings are not.
  - `Network.emulateNetworkConditions({offline:true})` does not necessarily drop
    an established WebSocket — do not use it to test reconnects.

### 7.5 Operational gotchas

- **`pkill -f <pattern>` will kill your own shell** when the pattern also appears
  in the command line you are currently running (`pkill -f "watch.mjs"` inside a
  command that mentions `watch.mjs`). It silently terminated two of my run
  commands. Bracket the pattern (`"[w]atch.mjs"`) or, better, match on
  `/proc/$pid/cmdline` for processes whose *executable* is `node`:

  ```bash
  for p in $(pgrep -x node); do
    tr '\0' ' ' < "/proc/$p/cmdline" | grep -q 'watch\.mjs' && kill "$p"
  done
  ```

- **Console noise hides signal.** The first E2E run reported a transient
  pdf.js `Loading aborted` exception on unmount/destroy; it is harmless. My own
  first E2E run also had two *harness* bugs (a wrong array index and a too-strict
  length threshold) that produced false FAILs while the app was behaving
  correctly. Always read the captured transcript before believing a check.

- Use `herdr pane wait-output --match "<marker>"` to block until a run finishes
  rather than sleeping on a fixed timeout, and make every long run print a unique
  final marker (`E2E VERDICT`, `VERDICT …`) for exactly this purpose.

---

## 8. Live API facts confirmed during this work

Everything below was verified against `gemini-3.8-live` on `v1alpha`, September 2026.

1. **Activity semantics.** Voice *and text* sent via `sendRealtimeInput` count as
   user activity; images/video do not. Activity handling defaults to
   `START_OF_ACTIVITY_INTERRUPTS`, which is what makes barge-in work.
2. **Turn boundaries.**
   - Automatic VAD on (default): the server infers the end of the turn from
     silence. `audioStreamEnd` only applies in this mode.
   - Automatic VAD off (`automaticActivityDetection.disabled = true`): the client
     must send `activityStart` / `activityEnd`; `audioStreamEnd` must not be sent.
     This is the correct mode for push-to-talk.
3. **Silent context.** `sendClientContent({ turns, turnComplete: false })` appends
   to the conversation without starting generation. `sendRealtimeInput({ text })`
   does the opposite.
4. **Turn pacing.** `generationComplete` means the model finished generating;
   `turnComplete` can follow several seconds later (7–9 s observed), which the SDK
   describes as the model waiting for realtime playback to finish. Do not treat
   `generationComplete`/`turnComplete` as interchangeable, and do not build a
   watchdog that only listens for `turnComplete`.
5. **`thinkingLevel` is not supported by `gemini-3.8-live`.** Sending it closes
   the socket with code `1007` and reason `"Thinking level is not supported for
   this model."` — a config error that presents as a connection failure.
6. **Time-to-first-audio is the model's thinking time** (~8–15 s for long Telugu
   explanations with this system instruction). It is not a hang, and it cannot be
   tuned via `thinkingLevel` on this model. Options if it matters: trim the
   instruction's verbosity demand, or switch to a model that accepts
   `thinkingLevel`.
7. **Ephemeral tokens** are single-use for *starting* a session (`uses: 1`,
   `newSessionExpireTime` ≈60 s) but can be reused to **resume** a session within
   `expireTime` — so reconnecting with a resumption handle does not require a new
   token, though minting one is harmless.
8. **Session/connection limits.** ~10 min per connection (resumption carries the
   session across connections); 15 min audio-only / 2 min audio+video per session
   without compression; `contextWindowCompression` removes the session limit;
   `GoAway` is sent before the server terminates the connection.
9. **A wedged session stays wedged.** Once a turn is left open, subsequent input
   (including text) produces nothing. Recovery requires a new session.

---

## 9. Runbook: "the assistant went quiet again"

1. **Reproduce with the harness before touching app code.** Generate assets, then:
   ```bash
   cd tools/live-debug && node probe2.mjs liveness gemini-3.8-live   # does text answer at all?
   node probe4.mjs explicit q1.pcm explicit                          # does an explicit-activity audio turn answer?
   ```
   If `probe4 explicit` works and the app doesn't, the app's turn handling is the
   problem, not the API.
2. **Watch the live wire.** Launch a dedicated Chrome window with
   `--remote-debugging-port`, run `watch.mjs`, and use the app. Read the frames:
   - `--> realtimeInput {"activityStart":{}}` then `{"activityEnd":{}}` present?
   - `<-- serverContent IN "…"` within ~1 s of release? If not → turn boundary
     (§3).
   - `<-- serverContent TURN_COMPLETE` and no stuck `Thinking…`?
   - `<-- serverContent INTERRUPTED` when you barge in?
   - Any `GOAWAY`, `WS CLOSED`, or close code? `1007` means a rejected config.
3. **Check for reconnect flapping:** count `scheduling reconnect` lines and look
   for `ignoring close from superseded socket`. A storm means the generation
   guard was bypassed or lost.
4. **Check the UI state machine:** `sessionActive` must not stay true with a dead
   socket (PTT then silently does nothing — `onPTTStart` returns early when
   `liveRef.current` is null).
5. **If nothing reproduces, run the automated E2E** (`e2e.mjs`) with the synthetic
   mic; it asserts 14 UI-level checks including silent context, barge-in, a
   network drop, and "answers after the reconnect". Read `frames-*.log` when a
   check fails.
6. **Re-read `AGENTS.md`.** It documents the current intended behavior; if the
   code and that file disagree, work out which one is stale before "fixing"
   anything.

---

## 10. Verification performed

`tools/live-debug/e2e.mjs`, real app + synthetic mic, final run: **14/14 checks**

```
CHECK PASS — page context does not trigger speech (status=Ready)
CHECK PASS — turn 1 answered
CHECK PASS — turn 1 returns to Ready
CHECK PASS — turn 2 starts speaking
CHECK PASS — answering continues after the interrupt
CHECK PASS — turn 2 (after interrupt) returns to Ready
CHECK PASS — turn 3 answered
CHECK PASS — turn 3 returns to Ready
CHECK PASS — recovers to Ready after a network drop
CHECK PASS — no reconnect storm (0 reconnect schedules)
CHECK PASS — no exhausted-teardown
CHECK PASS — answers after the reconnect
CHECK PASS — no error toast at the end
CHECK PASS — user speech was transcribed (5 entries)
```

Plus a human acceptance test in the user's own Chrome window on a real 770-page
book, observed live on the wire (§1). The first automated run caught a real
protocol failure (`1/…` of the turn checks failing) before the fix and passed
after it; typecheck (`npx tsc -b`) and `npx oxlint` are clean.

## 11. Known limitations / not verified

1. **GoAway → session-resumption handoff over a ~10-minute session was never
   observed live** (no GoAway appeared in testing; one stuck session died with
   `1006` after ~6.5 min instead). The code follows the documented pattern, but a
   genuine long-read soak test is still owed.
2. **The reconnect-storm fix is verified by construction, not by reproduction**
   (§6). Deliberately break the socket to exercise it.
3. **Scanned/image-only PDFs were never exercised** — the test PDF is text, so the
   `video` + `clientContent` branch has only been reasoned about, not run.
4. **`clientContent` mid-turn can truncate the model's answer** (§4), which is
   currently accepted behavior.
5. **Time-to-first-audio (~8–15 s) is inherent to the model + instruction**; the
   UI is honest about it (`Thinking…`), but if it becomes a complaint the levers
   are the instruction's length demand or the model choice.
