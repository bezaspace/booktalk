/**
 * LiveSession — wraps the Gemini Live API for BookTalk.
 *
 * Responsibilities:
 *  - Connect with an ephemeral token (no API key in the browser).
 *  - Push-to-talk as an *explicit* turn boundary: the button press sends
 *    `activityStart` and the release sends `activityEnd`, with automatic VAD
 *    switched off (see the rationale on `config` in `connect()`).
 *  - Play back model PCM (24kHz) sequentially, with interrupt support.
 *  - Surface live input/output transcripts.
 *  - Inject page context silently: text goes through
 *    `sendClientContent({ turnComplete: false })`, which appends to the
 *    conversation without starting a model turn; scanned/image pages send a
 *    JPEG frame via `sendRealtimeInput({ video })` (video is not activity).
 *  - Session resumption: capture `sessionResumptionUpdate.newHandle` and
 *    reconnect transparently on GoAway / close, ignoring callbacks from
 *    sockets that a newer connect() has superseded.
 *  - Context window compression for long reading sessions.
 */

import { GoogleGenAI, Modality, TurnCoverage, type Session, type LiveServerMessage } from '@google/genai'

import type { TranscriptEntry, VoiceStatus } from '../types'

const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

/** System instruction: a knowledgeable friend who can see the current page. */
const SYSTEM_INSTRUCTION = `You are BookTalk, a knowledgeable reading companion sitting next to the user while they read a PDF.

You can "see" the current page: as the user turns pages, you silently receive the page's text content (or an image of the page for scanned/image-only pages) as context. This context is injected automatically on every page change.

LANGUAGE RULES (most important):
- ALWAYS respond in Telugu, no matter what language the user speaks to you in or what language the PDF/book is written in. If the user speaks English, Hindi, Tamil, or any other language, your spoken reply must still be in Telugu.
- MANDATORY: Preserve English words, technical terms, proper nouns, names, code, commands, file paths, and any term that has no clean Telugu equivalent EXACTLY as they are — do NOT translate them into Telugu. For example: "API", "function", "neural network", "algorithm", "HTTP", "database", "JavaScript", "entropy", "Photosynthesis", "mitochondria", and similar terms stay in English inside your Telugu sentences. This is essential — translating such terms into native Telugu would lose meaning and confuse the user.
- Mix Telugu grammar and structure with embedded English terms naturally, the way a fluent Telugu-English bilingual speaker would. For example: "ఈ పేజీలో neural network అనే concept గురించి చెప్పాలంటే..." — Telugu flow with the English term kept intact.
- If a term has a widely accepted, unambiguous Telugu equivalent that loses nothing (e.g. simple everyday words), you may use the Telugu word. When in doubt, keep the English term.

CRITICAL RULES:
- NEVER respond, comment, or speak unless the user explicitly asks you a question by holding the push-to-talk button and speaking.
- Page-turn context updates are NOT questions. Stay silent on every page change. Do not summarize, narrate, or acknowledge receiving a page.
- When the user does ask, answer grounded in whatever page they are currently on. If they ask "what does this term mean?" or "explain this paragraph", use the current page's content.
- If the current page is a scanned/image page, reason from the image you were sent.

RESPONSE LENGTH:
- You have a very large output capacity (up to ~65,000 tokens). USE IT when the question warrants depth.
- Give thorough, detailed, comprehensive explanations when the user asks for an explanation, background, or deep dive. Do not artificially truncate or rush your answer.
- A short factual question can get a short answer, but anything conceptual, explanatory, or "tell me about..." should be answered fully and completely — teach the concept properly, give examples, walk through reasoning step by step, and cover the nuances.
- Think of yourself as a patient tutor who wants the user to genuinely understand, not a chatbot trying to be brief. Long, well-structured spoken explanations are welcome and expected.
- Even in long answers, stay spoken and natural — use pauses, structure, and signposting ("మొదటగా...", "ఇప్పుడు రెండవ భాగం...", "చివరగా...") so the user can follow along by ear.

- If you don't know or the page doesn't contain the answer, say so briefly in Telugu.`

/** Callbacks the UI subscribes to. */
export interface LiveSessionCallbacks {
  onStatus: (status: VoiceStatus) => void
  onTranscript: (entry: TranscriptEntry) => void
  onTranscriptUpdate: (id: string, text: string, partial: boolean) => void
  onError: (message: string) => void
  /** Recoverable nudge (toast only, session stays usable). */
  onNotice?: (message: string) => void
  /** Fatal: reconnects exhausted. The session is already torn down to idle;
   *  the UI should reset to the pre-start state (not stay "active"). */
  onExhausted?: (message: string) => void
  /** Mint a fresh ephemeral token for reconnects. Tokens are single-use
   *  (uses=1), so resuming after GoAway/close with the original token fails.
   *  If omitted, reconnects reuse the original token (best-effort). */
  refreshToken?: () => Promise<{ token: string; model: string }>
}

/** Mic-capture AudioWorklet processor source, inlined as a string.
 * Downsamples the input channel to 16kHz Int16 PCM and posts chunks. */
const CAPTURE_WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.targetRate = options.processorOptions?.targetRate || 16000
    this.ratio = Math.round(sampleRate / this.targetRate)
    if (this.ratio < 1) this.ratio = 1
    // Batch to ~64ms frames. One render quantum is only ~2.7ms at 16kHz, which
    // would put a WebSocket message on the wire roughly 375 times a second;
    // the Live API expects 20-100ms audio chunks.
    this.batchSamples = Math.max(1, Math.round(this.targetRate * 0.064))
    this.out = new Int16Array(this.batchSamples)
    this.outLen = 0
    // Push-to-talk release asks for whatever is still buffered, so the tail of
    // the last word is not left sitting in the worklet.
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.cmd === 'flush') this.flush()
    }
  }
  flush() {
    if (this.outLen === 0) return
    const chunk = this.out.slice(0, this.outLen)
    this.outLen = 0
    // Transfer the underlying buffer for zero-copy.
    this.port.postMessage(chunk.buffer, [chunk.buffer])
  }
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel || channel.length === 0) return true
    // Average each block of ratio samples to downsample (simple low-pass).
    for (let i = 0; i + this.ratio <= channel.length; i += this.ratio) {
      let sum = 0
      for (let j = 0; j < this.ratio; j++) sum += channel[i + j]
      const avg = sum / this.ratio
      const s = Math.max(-1, Math.min(1, avg))
      this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.outLen === this.batchSamples) this.flush()
    }
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
`

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function int16BufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

let entryCounter = 0
function nextEntryId(role: 'user' | 'assistant'): string {
  entryCounter += 1
  return `${role}-${entryCounter}`
}

export class LiveSession {
  private callbacks: LiveSessionCallbacks
  private model: string

  private client: GoogleGenAI
  private session: Session | null = null

  // Mic capture
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private captureNode: AudioWorkletNode | null = null
  private scriptProcessor: ScriptProcessorNode | null = null
  private micOpen = false
  private pttHeld = false
  private micAnalyser: AnalyserNode | null = null
  // Push-to-talk bookkeeping. A burst is an explicit activity in the session:
  // press => activityStart, release => activityEnd. `activityOpen` tracks an
  // activityStart that has not been closed yet; `pttAudioChunks` counts the
  // chunks forwarded during it, so a press that produced no audio closes the
  // activity without leaving the UI waiting on a turn that cannot arrive.
  private activityOpen = false
  private pttAudioChunks = 0
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null
  // With an explicit turn boundary the server always has a complete turn, so
  // this watchdog is only a net for a genuinely dead socket.
  private static readonly THINKING_WATCHDOG_MS = 45000
  // Every live.connect() gets a generation number. Callbacks from a socket a
  // later connect() has superseded are ignored; otherwise the old socket's
  // onclose schedules another reconnect (connect -> close old -> onclose ->
  // reconnect -> ...), which is what produced the "Connecting…/Ready" flicker
  // and the spurious "connection keeps dropping" teardown.
  private sessionGen = 0
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly GOAWAY_RESUME_MS = 1500

  // Playback
  private playbackCtx: AudioContext | null = null
  private playbackQueue: { buffer: AudioBuffer; source: AudioBufferSourceNode }[] = []
  private nextPlayTime = 0
  private speaking = false

  // Session resumption
  private resumptionHandle: string | null = null
  private intentionallyClosed = false

  // Transcript bookkeeping. Transcription fragments arrive incrementally and
  // must be concatenated; we accumulate per active entry and emit the full text.
  private currentUserEntryId: string | null = null
  private currentAssistantEntryId: string | null = null
  private currentUserText = ''
  private currentAssistantText = ''

  constructor(token: string, model: string, callbacks: LiveSessionCallbacks) {
    this.model = model
    this.callbacks = callbacks
    this.client = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------
  async connect(): Promise<void> {
    this.intentionallyClosed = false
    this.callbacks.onStatus('connecting')
    console.debug('[Live] connect() start', { hasResumptionHandle: !!this.resumptionHandle, model: this.model })

    await this.ensureMic()
    await this.ensurePlayback()

    // Ephemeral tokens are single-use: mint a fresh one for every reconnect
    // that carries a resumption handle. The initial connect uses the token
    // passed to the constructor.
    if (this.resumptionHandle && this.callbacks.refreshToken) {
      try {
        const fresh = await this.callbacks.refreshToken()
        this.model = fresh.model
        this.client = new GoogleGenAI({ apiKey: fresh.token, httpOptions: { apiVersion: 'v1alpha' } })
        console.debug('[Live] refreshed ephemeral token for resume', { model: this.model })
      } catch (e) {
        console.error('[Live] token refresh failed, reusing original token', e)
      }
    }

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Long reading sessions — compress the context window when it fills.
      contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
      // Resume from a previous handle if we have one.
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : undefined,
      // Include audio activity + all video since last turn, so scanned-page
      // frames sent during page turns are visible when the user asks.
      realtimeInputConfig: {
        turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
        // Push-to-talk, not an open mic: the button IS the turn boundary.
        //
        // With automatic VAD the server decides when the user's turn ended,
        // and it needs trailing silence to commit end-of-speech. Releasing the
        // button straight off the last word therefore left the turn open: the
        // audio was accepted (it even interrupted the model) but no turn ever
        // completed, so no transcript and no answer arrived and the UI sat in
        // "Thinking…" until a timeout. Measured against the live API: 0ms and
        // 800ms of trailing silence still produced nothing, 1500ms worked.
        // Disabling VAD and sending activityStart/activityEnd on the button
        // makes the boundary explicit and deterministic.
        automaticActivityDetection: { disabled: true },
      },
    }

    // This connect supersedes anything before it; older sockets go inert.
    const gen = ++this.sessionGen
    const isCurrent = () => gen === this.sessionGen

    // Drop any dead socket before opening a new one (reconnect path).
    if (this.session) {
      try {
        this.session.close()
      } catch {
        /* already dead */
      }
      this.session = null
    }
    this.lastCloseReason = 'clean open'

    this.session = await this.client.live.connect({
      model: this.model,
      config,
      callbacks: {
        onopen: () => {
          if (!isCurrent()) return
          console.debug('[Live] WebSocket onopen', { gen, resumed: !!this.resumptionHandle })
          this.openedAt = Date.now()
          this.reconnectAttempts = 0
          // A connection that survives 15s counts as healthy — reset the
          // early-close counter so one-off blips don't accumulate forever.
          if (this.steadyTimer) clearTimeout(this.steadyTimer)
          this.steadyTimer = setTimeout(() => {
            if (isCurrent() && !this.intentionallyClosed) {
              this.earlyCloses = 0
              console.debug('[Live] connection steady for 15s, reset early-close counter')
            }
          }, LiveSession.STEADY_AFTER_MS)
          this.callbacks.onStatus(this.pttHeld ? 'listening' : 'connected')
        },
        onmessage: (msg: LiveServerMessage) => {
          if (!isCurrent()) return
          this.handleMessage(msg)
        },
        onerror: (e: ErrorEvent) => {
          if (!isCurrent()) return
          console.error('[Live] WebSocket onerror', e.message)
          this.lastCloseReason = e.message || 'websocket error'
          this.callbacks.onError(`Live error: ${e.message}`)
        },
        onclose: (e?: CloseEvent) => {
          if (!isCurrent()) {
            console.debug('[Live] ignoring close from superseded socket', { gen, current: this.sessionGen })
            return
          }
          const code = (e as CloseEvent | undefined)?.code
          const reason = (e as CloseEvent | undefined)?.reason
          const openMs = this.openedAt ? Date.now() - this.openedAt : -1
          console.warn('[Live] WebSocket onclose. code=' + code + ' reason=' + reason + ' openMs=' + openMs + ' intentionallyClosed=' + this.intentionallyClosed)
          if (this.steadyTimer) {
            clearTimeout(this.steadyTimer)
            this.steadyTimer = null
          }
          if (this.intentionallyClosed) return
          this.lastCloseReason = reason || (typeof code === 'number' ? `close code ${code}` : 'unexpected close')
          // Opened fine but died young, repeatedly → the server (or the
          // network) is rejecting the live session itself. Stop looping and
          // say so; the toast shows the close code/reason.
          if (openMs >= 0 && openMs < LiveSession.STEADY_AFTER_MS) {
            this.earlyCloses += 1
          }
          if (this.earlyCloses > LiveSession.MAX_EARLY_CLOSES) {
            console.error('[Live] connection died young ' + this.earlyCloses + 'x in a row. last=' + this.lastCloseReason)
            const msg =
              `Voice connection keeps dropping (${this.earlyCloses}x, last: ${this.lastCloseReason}). Check network/VPN, then press Start.`
            this.earlyCloses = 0
            this.resumptionHandle = null
            // Tear down to idle first so one Start press cleanly restarts;
            // then report. Without this the UI stays "active" with a dead
            // session and PTT half-enabled.
            this.close()
            if (this.callbacks.onExhausted) this.callbacks.onExhausted(msg)
            else this.callbacks.onError(msg)
            return
          }
          // Unexpected close — try to resume if we have a handle.
          this.callbacks.onStatus('connecting')
          this.scheduleReconnect()
        },
      },
    })
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private earlyCloses = 0
  private openedAt = 0
  private steadyTimer: ReturnType<typeof setTimeout> | null = null
  private lastCloseReason = 'unknown'
  private static readonly MAX_RESUME_ATTEMPTS = 2
  private static readonly MAX_RECONNECT_ATTEMPTS = 5
  private static readonly MAX_EARLY_CLOSES = 4
  private static readonly STEADY_AFTER_MS = 15000

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return
    if (this.reconnectTimer) return
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > LiveSession.MAX_RECONNECT_ATTEMPTS) {
      console.error('[Live] giving up after ' + LiveSession.MAX_RECONNECT_ATTEMPTS + ' reconnects. lastClose=' + this.lastCloseReason)
      const msg =
        `Voice connection keeps dropping (${LiveSession.MAX_RECONNECT_ATTEMPTS} retries, last: ${this.lastCloseReason}). Press Start for a fresh session.`
      this.reconnectAttempts = 0
      // Drop the possibly-stale resumption handle so the next manual Start
      // begins clean instead of replaying a handle the server rejects.
      this.resumptionHandle = null
      this.close()
      if (this.callbacks.onExhausted) this.callbacks.onExhausted(msg)
      else this.callbacks.onError(msg)
      return
    }
    // After a couple of failed resume attempts the handle itself is likely
    // stale (server rejected it) — retry fresh without it rather than
    // looping on the same rejected handle forever.
    if (this.reconnectAttempts > LiveSession.MAX_RESUME_ATTEMPTS && this.resumptionHandle) {
      console.warn('[Live] dropping stale resumption handle, will reconnect fresh')
      this.resumptionHandle = null
    }
    const backoffMs = Math.min(800 * 2 ** (this.reconnectAttempts - 1), 10000)
    // ±25% jitter so reconnect storms don't beat in lockstep with the LB.
    const jitteredMs = Math.round(backoffMs * (0.75 + Math.random() * 0.5))
    console.warn('[Live] scheduling reconnect in ' + jitteredMs + 'ms. attempt=' + this.reconnectAttempts + ' hasHandle=' + !!this.resumptionHandle)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.intentionallyClosed) return
      this.connect().catch((err) => {
        console.error('[Live] reconnect failed', err)
        this.callbacks.onError(`Reconnect failed: ${err?.message ?? err}`)
        this.scheduleReconnect()
      })
    }, jitteredMs)
  }

  /** Idempotent: open mic + capture worklet once. */
  private async ensureMic(): Promise<void> {
    if (this.micOpen) return
    const AudioCtxCtor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined
    if (!AudioCtxCtor) {
      throw new Error('Web Audio API not supported in this browser.')
    }
    // Secure-context check — AudioWorklet and getUserMedia require HTTPS or localhost.
    if (!window.isSecureContext) {
      console.warn('[Live] isSecureContext=false — mic may fail on http://booktalk.local without flag')
    }
    const ctx = new AudioCtxCtor({ sampleRate: 48000 } as AudioContextOptions)
    this.audioCtx = ctx

    // Prefer AudioWorklet; fall back to ScriptProcessor for insecure contexts / old browsers.
    const hasWorklet = !!(ctx as unknown as { audioWorklet?: { addModule: (url: string) => Promise<void> } }).audioWorklet?.addModule

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const source = ctx.createMediaStreamSource(this.micStream)
    // Level tap for the mic meter (no output connection — stays silent).
    try {
      this.micAnalyser = ctx.createAnalyser()
      this.micAnalyser.fftSize = 512
      source.connect(this.micAnalyser)
    } catch {
      this.micAnalyser = null
    }

    if (hasWorklet) {
      try {
        const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        await (ctx as unknown as { audioWorklet: { addModule: (u: string) => Promise<void> } }).audioWorklet.addModule(url)
        URL.revokeObjectURL(url)

        const node = new AudioWorkletNode(ctx, 'capture-processor', {
          processorOptions: { targetRate: INPUT_SAMPLE_RATE },
        } as AudioWorkletNodeOptions)
        source.connect(node)
        // Don't connect to destination — we don't want to hear ourselves.
        node.port.onmessage = (ev: MessageEvent) => {
          // Only forward while PTT is held.
          if (this.pttHeld && this.session) {
            const b64 = int16BufferToBase64(ev.data as ArrayBuffer)
            this.session.sendRealtimeInput({
              audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
            })
            this.pttAudioChunks += 1
          }
        }
        this.captureNode = node as unknown as AudioWorkletNode
        this.micOpen = true
        return
      } catch (e) {
        console.warn('[Live] AudioWorklet failed, falling back to ScriptProcessor', e)
        // fall through to ScriptProcessor fallback
      }
    }

    // --- ScriptProcessor fallback (deprecated but works everywhere) ---
    // 4096 buffer, downsample 48k -> 16k via averaging.
    const processor = (ctx as unknown as { createScriptProcessor: (a: number, b: number, c: number) => ScriptProcessorNode }).createScriptProcessor(4096, 1, 1)
    const ratio = Math.round((ctx.sampleRate || 48000) / INPUT_SAMPLE_RATE)
    processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!this.pttHeld || !this.session) return
      const input = ev.inputBuffer.getChannelData(0)
      const outLen = Math.floor(input.length / ratio)
      const out = new Int16Array(outLen)
      for (let i = 0, oi = 0; i + ratio <= input.length; i += ratio, oi++) {
        let sum = 0
        for (let j = 0; j < ratio; j++) sum += input[i + j]!
        const avg = sum / ratio
        const s = Math.max(-1, Math.min(1, avg))
        out[oi] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      if (out.length > 0) {
        const b64 = int16BufferToBase64(out.buffer as ArrayBuffer)
        this.session!.sendRealtimeInput({
          audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
        })
        this.pttAudioChunks += 1
      }
    }
    source.connect(processor)
    // ScriptProcessor must be connected to destination to run, but keep it silent via a gain node at 0.
    const gain = ctx.createGain()
    gain.gain.value = 0
    processor.connect(gain)
    gain.connect(ctx.destination)
    // Keep reference to avoid GC
    this.scriptProcessor = processor
    this.micOpen = true
  }

  private async ensurePlayback(): Promise<void> {
    if (this.playbackCtx) return
    this.playbackCtx = new AudioContext()
  }

  // -----------------------------------------------------------------------
  // Push to talk
  // -----------------------------------------------------------------------
  /** Begin a push-to-talk burst: open an explicit activity and stream audio. */
  startPushToTalk(): void {
    if (!this.session) return
    if (this.pttHeld) return // re-entrant pointerdown — already in a burst
    this.pttHeld = true
    this.pttAudioChunks = 0
    this.disarmThinkingWatchdog()
    console.debug('[Live] PTT start — activityStart. speaking=' + this.speaking + ' queueLen=' + this.playbackQueue.length)
    // Pressing the button is also how the user barges in: stop local playback
    // now, and let the activityStart below cancel the server's generation.
    this.stopPlayback()
    // Finalize any pending assistant transcript from a prior turn.
    if (this.currentAssistantEntryId) {
      this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, false)
      this.currentAssistantEntryId = null
      this.currentAssistantText = ''
    }
    // Open the turn: everything sent until activityEnd is part of this
    // question, and the server needs no silence to decide where it ended.
    this.session.sendRealtimeInput({ activityStart: {} })
    this.activityOpen = true
    this.callbacks.onStatus('listening')
    // Resume audio contexts (browsers suspend until a user gesture).
    void this.audioCtx?.resume()
    void this.playbackCtx?.resume()
  }

  /** Current mic input peak 0..1 (for the level meter). 0 when mic closed. */
  getMicLevel(): number {
    if (!this.micOpen || !this.micAnalyser) return 0
    try {
      const buf = new Uint8Array(this.micAnalyser.fftSize)
      this.micAnalyser.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]! - 128) / 128
        if (v > peak) peak = v
      }
      return Math.min(1, peak)
    } catch {
      return 0
    }
  }

  /** Whether a burst is currently held (for window-level release fallback). */
  isHolding(): boolean {
    return this.pttHeld
  }

  /** End a push-to-talk burst: close the activity, which ends the turn. */
  endPushToTalk(): void {
    // Idempotent: pointerup + pointercancel/pointerleave can all fire for one
    // press. Only the first release ends the burst.
    if (!this.pttHeld) return
    this.pttHeld = false

    const hadAudio = this.pttAudioChunks > 0
    const session = this.session

    if (!this.activityOpen) {
      // Never opened (released before the first chunk, or the session died
      // mid-press) — there is no turn to close.
      if (!this.speaking) this.callbacks.onStatus('connected')
      return
    }
    this.activityOpen = false

    if (session) {
      // Hand over the tail of a partially filled audio batch, then close the
      // turn. The 30ms gap is well below the threshold of perception and lets
      // that last batch reach the socket before the activity ends.
      try {
        this.captureNode?.port.postMessage({ cmd: 'flush' })
      } catch {
        /* worklet already gone */
      }
      const closeActivity = () => {
        if (this.intentionallyClosed) return
        try {
          session.sendRealtimeInput({ activityEnd: {} })
        } catch (e) {
          console.warn('[Live] activityEnd failed', e)
        }
      }
      if (hadAudio) setTimeout(closeActivity, 30)
      else closeActivity()
    }

    if (!hadAudio) {
      // A tap, or a press with nothing captured: the activity is closed, but no
      // answer can be on its way, so do not pretend to be thinking.
      console.debug('[Live] PTT end with no audio — activity closed without a turn')
      if (!this.speaking) this.callbacks.onStatus('connected')
      return
    }

    console.debug('[Live] PTT end — activityEnd. chunks=' + this.pttAudioChunks)
    this.callbacks.onStatus('thinking')
    this.armThinkingWatchdog()
  }

  private armThinkingWatchdog(): void {
    this.disarmThinkingWatchdog()
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = null
      // A complete turn was sent and nothing came back. Recover to Ready
      // instead of sitting in "Thinking…" forever.
      console.warn('[Live] thinking watchdog fired — no turn progress for ' + LiveSession.THINKING_WATCHDOG_MS + 'ms')
      this.callbacks.onStatus('connected')
      if (this.callbacks.onNotice) {
        this.callbacks.onNotice("Didn't get a response for that one — hold the button and ask again.")
      }
    }, LiveSession.THINKING_WATCHDOG_MS)
  }

  /** Extend the watchdog: the turn is alive but has not produced audio yet. */
  private extendThinkingWatchdog(): void {
    if (this.thinkingTimer) this.armThinkingWatchdog()
  }

  private disarmThinkingWatchdog(): void {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer)
      this.thinkingTimer = null
    }
  }

  // -----------------------------------------------------------------------
  // Context injection (silent — never triggers a response on its own)
  // -----------------------------------------------------------------------
  /** Inject a text page as silent context. */
  injectTextPage(page: number, pageCount: number, text: string): void {
    if (!this.session) return
    const payload =
      `[CONTEXT — page ${page} of ${pageCount}. This is the page the user is currently reading. Do NOT respond to this.]\n\n${text}`
    // turnComplete:false appends the page to the conversation without starting
    // a model turn, so the model can see the page but stays silent. Sending the
    // same text as realtime input does not work: there, text counts as user
    // activity, and the model starts answering the page out loud.
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: payload }] }],
      turnComplete: false,
    })
  }

  /** Inject a scanned/image page as a JPEG frame. */
  injectImagePage(jpegBytes: Uint8Array, page: number, pageCount: number): void {
    if (!this.session) return
    // A frame is not activity (only voice and text are), so this never triggers
    // a reply by itself. The accompanying note must still go through
    // clientContent — as realtime text it would make the model describe the
    // page unprompted.
    this.session.sendRealtimeInput({
      video: { data: uint8ToBase64(jpegBytes), mimeType: 'image/jpeg' },
    })
    this.session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [
            {
              text: `[CONTEXT — image of page ${page} of ${pageCount}. This is the page the user is currently reading. Do NOT respond to this.]`,
            },
          ],
        },
      ],
      turnComplete: false,
    })
  }

  // -----------------------------------------------------------------------
  // Incoming messages
  // -----------------------------------------------------------------------
  private handleMessage(msg: LiveServerMessage): void {
    const content = msg.serverContent

    // Session resumption update — capture the latest handle.
    if (msg.sessionResumptionUpdate) {
      const upd = msg.sessionResumptionUpdate
      console.debug('[Live] sessionResumptionUpdate', { resumable: upd.resumable, hasHandle: !!upd.newHandle })
      if (upd.resumable && upd.newHandle) {
        this.resumptionHandle = upd.newHandle
      }
    }

    // GoAway — the server is about to drop this connection. Resume on a fresh
    // socket shortly before that happens instead of reconnecting on top of a
    // still-open one (the resumption handle keeps it the same reading session).
    if (msg.goAway) {
      console.warn('[Live] GoAway received — will resume on a new connection. speaking=' + this.speaking)
      if (!this.goAwayTimer) {
        this.goAwayTimer = setTimeout(() => {
          this.goAwayTimer = null
          if (!this.intentionallyClosed) this.scheduleReconnect()
        }, LiveSession.GOAWAY_RESUME_MS)
      }
      return
    }

    if (!content) {
      // Keep-alive / metadata-only frames: {}, setupComplete, usageMetadata.
      return
    }

    // Any transcript means the turn was accepted, but not that an answer is on
    // its way — a thorough answer can think for a while before its first audio
    // frame, so this only extends the watchdog.
    if (content.inputTranscription?.text) {
      this.extendThinkingWatchdog()
      if (!this.currentUserEntryId) {
        this.currentUserEntryId = nextEntryId('user')
        this.currentUserText = content.inputTranscription.text
        this.callbacks.onTranscript({
          id: this.currentUserEntryId,
          role: 'user',
          text: this.currentUserText,
          partial: true,
        })
      } else {
        this.currentUserText += content.inputTranscription.text
        this.callbacks.onTranscriptUpdate(this.currentUserEntryId, this.currentUserText, true)
      }
    }
    if (content.outputTranscription?.text) {
      this.extendThinkingWatchdog()
      if (!this.currentAssistantEntryId) {
        this.currentAssistantEntryId = nextEntryId('assistant')
        this.currentAssistantText = content.outputTranscription.text
        this.callbacks.onTranscript({
          id: this.currentAssistantEntryId,
          role: 'assistant',
          text: this.currentAssistantText,
          partial: true,
        })
      } else {
        this.currentAssistantText += content.outputTranscription.text
        this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, true)
      }
    }

    // Interruption — stop playback immediately and finalize the partial
    // assistant transcript so the next response starts a fresh entry.
    if (content.interrupted) {
      console.warn('[Live] INTERRUPTED — stopping playback. pttHeld=' + this.pttHeld + ' queueLen=' + this.playbackQueue.length + ' speaking=' + this.speaking)
      this.disarmThinkingWatchdog()
      this.stopPlayback()
      if (this.currentAssistantEntryId) {
        this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, false)
        this.currentAssistantEntryId = null
        this.currentAssistantText = ''
      }
      this.callbacks.onStatus(this.pttHeld ? 'listening' : 'connected')
      return
    }

    // Audio parts — enqueue for playback. The first audio of a turn means the
    // answer has started, so the wait-for-a-response watchdog is done.
    if (content.modelTurn?.parts) {
      const parts = content.modelTurn.parts
      let audioCount = 0
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.enqueueAudio(part.inlineData.data)
          audioCount++
        }
      }
      if (audioCount > 0) this.disarmThinkingWatchdog()
    }

    // Turn complete — finalize transcript entries (mark non-partial).
    if (content.turnComplete) {
      this.disarmThinkingWatchdog()
      if (content.turnCompleteReason && content.turnCompleteReason !== 'TURN_COMPLETE_REASON_UNSPECIFIED') {
        console.warn('[Live] turnComplete reason=' + content.turnCompleteReason)
      }
      if (this.currentUserEntryId) {
        this.callbacks.onTranscriptUpdate(this.currentUserEntryId, this.currentUserText, false)
        this.currentUserEntryId = null
        this.currentUserText = ''
      }
      if (this.currentAssistantEntryId) {
        this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, false)
        this.currentAssistantEntryId = null
        this.currentAssistantText = ''
      }
      // A turn that ends without an answer (the model decided it had nothing
      // to say, or it was waiting for more input) must not leave the UI
      // claiming to think.
      if (!this.speaking && !this.pttHeld) {
        this.callbacks.onStatus('connected')
        if (this.pttAudioChunks > 0 && !this.currentAssistantText && content.waitingForInput) {
          this.callbacks.onNotice?.("I didn't catch that — try holding the button and speaking again.")
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Playback (24kHz PCM Int16, base64)
  // -----------------------------------------------------------------------
  private enqueueAudio(base64: string): void {
    const ctx = this.playbackCtx
    if (!ctx) return
    const pcm = this.base64ToInt16(base64)
    // The model occasionally emits empty/tiny keep-alive chunks. Scheduling
    // a ~0-length buffer flickers playback state (START then instant ENDED,
    // Speaking → Ready). Drop anything under 20ms.
    if (pcm.length < Math.floor(OUTPUT_SAMPLE_RATE * 0.02)) {
      console.debug('[Live] skipping tiny audio chunk', { samples: pcm.length })
      return
    }
    const float = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      float[i] = pcm[i] / 0x8000
    }
    const buffer = ctx.createBuffer(1, float.length, OUTPUT_SAMPLE_RATE)
    buffer.copyToChannel(float, 0)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const now = ctx.currentTime
    const startAt = Math.max(now, this.nextPlayTime)
    source.start(startAt)
    this.nextPlayTime = startAt + buffer.duration
    this.playbackQueue.push({ buffer, source })

    if (!this.speaking) {
      this.speaking = true
      if (!this.pttHeld) this.callbacks.onStatus('speaking')
      console.debug('[Live] playback START', { samples: float.length, dur: buffer.duration.toFixed(3), ctxTime: now.toFixed(3) })
    }

    source.onended = () => {
      this.playbackQueue = this.playbackQueue.filter((q) => q.source !== source)
      if (this.playbackQueue.length === 0) {
        this.nextPlayTime = 0
        this.speaking = false
        console.debug('[Live] playback ENDED (queue drained)')
        if (!this.pttHeld) this.callbacks.onStatus('connected')
      }
    }
  }

  private stopPlayback(): void {
    if (this.playbackQueue.length > 0) {
      console.debug('[Live] stopPlayback — clearing ' + this.playbackQueue.length + ' queued sources')
    }
    for (const q of this.playbackQueue) {
      try {
        q.source.onended = null
        q.source.stop()
      } catch {
        /* already stopped */
      }
    }
    this.playbackQueue = []
    this.nextPlayTime = 0
    this.speaking = false
  }

  private base64ToInt16(b64: string): Int16Array {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Int16Array(bytes.buffer)
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------
  close(): void {
    this.intentionallyClosed = true
    // Invalidate any callback still in flight from the socket we are closing.
    this.sessionGen += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.goAwayTimer) {
      clearTimeout(this.goAwayTimer)
      this.goAwayTimer = null
    }
    if (this.steadyTimer) {
      clearTimeout(this.steadyTimer)
      this.steadyTimer = null
    }
    this.disarmThinkingWatchdog()
    this.activityOpen = false
    this.earlyCloses = 0
    this.openedAt = 0
    this.stopPlayback()
    try {
      this.session?.close()
    } catch {
      /* ignore */
    }
    this.session = null
    this.captureNode?.disconnect()
    try {
      this.scriptProcessor?.disconnect()
    } catch {
      /* ignore */
    }
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micAnalyser = null
    void this.audioCtx?.close()
    void this.playbackCtx?.close()
    this.audioCtx = null
    this.playbackCtx = null
    this.micStream = null
    this.captureNode = null
    this.scriptProcessor = null
    this.micOpen = false
    this.callbacks.onStatus('idle')
  }
}
