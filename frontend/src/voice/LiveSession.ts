/**
 * LiveSession — wraps the Gemini Live API for BookTalk.
 *
 * Responsibilities:
 *  - Connect with an ephemeral token (no API key in the browser).
 *  - Push-to-talk: stream mic PCM (16kHz) only while the button is held;
 *    send `audioStreamEnd` on release.
 *  - Play back model PCM (24kHz) sequentially, with interrupt support.
 *  - Surface live input/output transcripts.
 *  - Inject page context silently: text pages via `sendRealtimeInput({text})`,
 *    scanned/image pages via `sendRealtimeInput({video})` (JPEG frame).
 *  - Session resumption: capture `sessionResumptionUpdate.newHandle` and
 *    reconnect transparently on GoAway / close.
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
    this.buffer = []
  }
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel || channel.length === 0) return true
    // Average each block of ratio samples to downsample (simple low-pass).
    const out = new Int16Array(Math.floor(channel.length / this.ratio))
    let oi = 0
    for (let i = 0; i + this.ratio <= channel.length; i += this.ratio) {
      let sum = 0
      for (let j = 0; j < this.ratio; j++) sum += channel[i + j]
      const avg = sum / this.ratio
      let s = Math.max(-1, Math.min(1, avg))
      out[oi++] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    if (oi > 0) {
      // Transfer the underlying buffer for zero-copy.
      this.port.postMessage(out.buffer, [out.buffer])
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
    console.debug('[Live] connect() start', { hasResumptionHandle: !!this.resumptionHandle })

    await this.ensureMic()
    await this.ensurePlayback()

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
      realtimeInputConfig: { turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO },
    }

    this.session = await this.client.live.connect({
      model: this.model,
      config,
      callbacks: {
        onopen: () => {
          console.debug('[Live] WebSocket onopen')
          this.callbacks.onStatus(this.pttHeld ? 'listening' : 'connected')
        },
        onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
        onerror: (e: ErrorEvent) => {
          console.error('[Live] WebSocket onerror', e.message)
          this.callbacks.onError(`Live error: ${e.message}`)
        },
        onclose: () => {
          console.warn('[Live] WebSocket onclose. intentionallyClosed=' + this.intentionallyClosed + ' speaking=' + this.speaking + ' queueLen=' + this.playbackQueue.length)
          if (this.intentionallyClosed) return
          // Unexpected close — try to resume if we have a handle.
          this.callbacks.onStatus('connecting')
          this.scheduleReconnect()
        },
      },
    })
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return
    if (this.reconnectTimer) return
    console.warn('[Live] scheduling reconnect in 800ms. hasHandle=' + !!this.resumptionHandle)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.intentionallyClosed) return
      this.connect().catch((err) => {
        console.error('[Live] reconnect failed', err)
        this.callbacks.onError(`Reconnect failed: ${err?.message ?? err}`)
        this.scheduleReconnect()
      })
    }, 800)
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
  /** Begin a push-to-talk burst: forward mic audio until release(). */
  startPushToTalk(): void {
    if (!this.session) return
    this.pttHeld = true
    console.debug('[Live] PTT start — interrupting playback. speaking=' + this.speaking + ' queueLen=' + this.playbackQueue.length)
    // Interrupt any in-flight playback.
    this.stopPlayback()
    // Finalize any pending assistant transcript from a prior turn.
    if (this.currentAssistantEntryId) {
      this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, false)
      this.currentAssistantEntryId = null
      this.currentAssistantText = ''
    }
    this.callbacks.onStatus('listening')
    // Resume audio contexts (browsers suspend until a user gesture).
    void this.audioCtx?.resume()
    void this.playbackCtx?.resume()
  }

  /** End a push-to-talk burst: flush the audio stream. */
  endPushToTalk(): void {
    this.pttHeld = false
    console.debug('[Live] PTT end — flushing audioStreamEnd')
    if (this.session) {
      // Flush cached audio so the server processes the turn promptly.
      this.session.sendRealtimeInput({ audioStreamEnd: true })
    }
    this.callbacks.onStatus('thinking')
  }

  // -----------------------------------------------------------------------
  // Context injection (silent — never triggers a response on its own)
  // -----------------------------------------------------------------------
  /** Inject a text page as silent context. */
  injectTextPage(page: number, pageCount: number, text: string): void {
    if (!this.session) return
    const payload =
      `[CONTEXT — page ${page} of ${pageCount}. Do NOT respond to this; it is the current page the user is reading.]\n\n${text}`
    this.session.sendRealtimeInput({ text: payload })
  }

  /** Inject a scanned/image page as a JPEG frame. */
  injectImagePage(jpegBytes: Uint8Array, page: number, pageCount: number): void {
    if (!this.session) return
    // A short text tag accompanies the frame so the model knows it's context,
    // not a question. The system instruction reinforces silence.
    this.session.sendRealtimeInput({
      video: { data: uint8ToBase64(jpegBytes), mimeType: 'image/jpeg' },
    })
    this.session.sendRealtimeInput({
      text: `[CONTEXT — image of page ${page} of ${pageCount}. Do NOT respond to this; it is the current page the user is reading.]`,
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

    // GoAway — server will disconnect soon; reconnect proactively.
    if (msg.goAway) {
      console.warn('[Live] GoAway received — scheduling reconnect. speaking=' + this.speaking + ' queueLen=' + this.playbackQueue.length)
      this.scheduleReconnect()
      return
    }

    if (!content) {
      console.debug('[Live] message with no serverContent', Object.keys(msg))
      return
    }

    // Transcripts — fragments arrive incrementally; accumulate and emit full text.
    if (content.inputTranscription?.text) {
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
      this.stopPlayback()
      if (this.currentAssistantEntryId) {
        this.callbacks.onTranscriptUpdate(this.currentAssistantEntryId, this.currentAssistantText, false)
        this.currentAssistantEntryId = null
        this.currentAssistantText = ''
      }
      this.callbacks.onStatus(this.pttHeld ? 'listening' : 'connected')
      return
    }

    // Audio parts — enqueue for playback.
    if (content.modelTurn?.parts) {
      const parts = content.modelTurn.parts
      let audioCount = 0
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.enqueueAudio(part.inlineData.data)
          audioCount++
        }
      }
      if (audioCount > 0) {
        console.debug('[Live] audio chunks received', { count: audioCount, queueLen: this.playbackQueue.length, speaking: this.speaking })
      }
    }

    // Turn complete — finalize transcript entries (mark non-partial).
    if (content.turnComplete) {
      console.debug('[Live] turnComplete. speaking=' + this.speaking + ' queueLen=' + this.playbackQueue.length + ' pttHeld=' + this.pttHeld)
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
      if (!this.pttHeld && !this.speaking) {
        this.callbacks.onStatus('connected')
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
