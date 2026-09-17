// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Harness A — drive the real Gemini Live API with BookTalk's exact config.
 *
 * Reproduces the app's push-to-talk pattern (audio only while "held", then
 * audioStreamEnd) using real spoken questions, several turns in a row,
 * including an interrupt-while-speaking turn and a page-context injection.
 *
 * Usage: node harness.mjs [chunkMs] [turns]
 */
import { GoogleGenAI, Modality, TurnCoverage } from '@google/genai'
import fs from 'node:fs'

const CHUNK_MS = Number(process.argv[2] ?? 100)
const TURNS = Number(process.argv[3] ?? 3)
const IDLE_MS = Number(process.argv[4] ?? 0)
const BACKEND = 'http://127.0.0.1:8000'
const IN_RATE = 16000

const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function token() {
  const r = await fetch(`${BACKEND}/token`)
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`)
  return r.json()
}

async function pageText(sessionId, page) {
  const r = await fetch(`${BACKEND}/page?session=${sessionId}&page=${page}`)
  return r.json()
}

// ---- app's system instruction (trimmed to the parts that matter here) ----
const SYSTEM_INSTRUCTION = `You are BookTalk, a knowledgeable reading companion sitting next to the user while they read a PDF.

You can "see" the current page: as the user turns pages, you silently receive the page's text content as context.

LANGUAGE RULES: ALWAYS respond in Telugu. Keep English technical terms in English.

CRITICAL RULES:
- NEVER respond, comment, or speak unless the user explicitly asks you a question by holding the push-to-talk button and speaking.
- Page-turn context updates are NOT questions. Stay silent on every page change.
- When the user does ask, answer grounded in whatever page they are currently on.

RESPONSE LENGTH: Give thorough, detailed explanations when asked.`

class Probe {
  constructor() {
    this.events = []
    this.stats = {
      messages: 0,
      audioChunks: 0,
      audioSamples: 0,
      inputTranscription: '',
      outputTranscription: '',
      turnCompleteAt: [],
      interruptedAt: [],
      firstMessageAt: null,
      firstAudioAt: null,
      goAwayAt: null,
      closed: null,
      errors: [],
    }
  }
  note(tag, extra) {
    this.events.push({ t: Date.now() - t0, tag, ...extra })
    log(`EVENT ${tag}`, extra ?? '')
  }
}

async function run(label, chunkMs) {
  const { token: tok, model } = await token()
  log(`=== ${label} | model=${model} chunk=${chunkMs}ms ===`)

  const probe = new Probe()
  let session
  const client = new GoogleGenAI({ apiKey: tok, httpOptions: { apiVersion: 'v1alpha' } })

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
    realtimeInputConfig: { turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO },
  }

  let openedAt = 0
  session = await client.live.connect({
    model,
    config,
    callbacks: {
      onopen: () => {
        openedAt = Date.now()
        probe.note('open')
      },
      onmessage: (msg) => {
        probe.stats.messages++
        if (probe.stats.firstMessageAt === null) probe.stats.firstMessageAt = Date.now() - t0
        const keys = Object.keys(msg).filter((k) => msg[k] !== undefined)
        if (msg.sessionResumptionUpdate) {
          probe.note('resumptionUpdate', {
            resumable: msg.sessionResumptionUpdate.resumable,
            hasHandle: !!msg.sessionResumptionUpdate.newHandle,
          })
          return
        }
        if (msg.goAway) {
          probe.stats.goAwayAt = Date.now() - t0
          probe.note('GOAWAY', { timeLeft: msg.goAway.timeLeft })
          return
        }
        const c = msg.serverContent
        if (!c) {
          probe.note('otherMessage', { keys })
          return
        }
        const detail = {}
        if (c.modelTurn) {
          let n = 0
          let samples = 0
          for (const p of c.modelTurn.parts ?? []) {
            if (p.inlineData?.data) {
              n++
              samples += Math.floor((p.inlineData.data.length * 3) / 4 / 2)
            }
            if (p.text) detail.partText = p.text.slice(0, 60)
          }
          probe.stats.audioChunks += n
          probe.stats.audioSamples += samples
          if (probe.stats.firstAudioAt === null && n > 0) probe.stats.firstAudioAt = Date.now() - t0
          detail.audioParts = n
          detail.samples = samples
        }
        if (c.inputTranscription) {
          probe.stats.inputTranscription += c.inputTranscription.text
          detail.input = c.inputTranscription.text
        }
        if (c.outputTranscription) {
          probe.stats.outputTranscription += c.outputTranscription.text
          detail.output = c.outputTranscription.text
        }
        if (c.interrupted) {
          probe.stats.interruptedAt.push(Date.now() - t0)
          probe.note('INTERRUPTED', detail)
          return
        }
        if (c.turnComplete) {
          probe.stats.turnCompleteAt.push(Date.now() - t0)
          probe.note('TURN_COMPLETE', {
            audioChunks: probe.stats.audioChunks,
            outChars: probe.stats.outputTranscription.length,
          })
          return
        }
        if (c.generationComplete) detail.generationComplete = true
        if (Object.keys(detail).length) probe.note('content', detail)
      },
      onerror: (e) => {
        probe.stats.errors.push(e.message)
        probe.note('ERROR', { message: e.message })
      },
      onclose: (e) => {
        probe.stats.closed = {
          code: e?.code,
          reason: e?.reason,
          openMs: Date.now() - openedAt,
        }
        probe.note('CLOSE', probe.stats.closed)
      },
    },
  })

  // --- helper: hold PTT with a spoken question, release with audioStreamEnd ---
  const hold = async (pcmFile, { holdMs, tag }) => {
    const pcm = fs.readFileSync(BH_DIR + `/${pcmFile}.pcm`)
    const total = pcm.length / 2 / IN_RATE
    const perChunkSamples = Math.floor((IN_RATE * chunkMs) / 1000)
    const perChunkBytes = perChunkSamples * 2
    const start = Date.now()
    const wallMs = holdMs ?? Math.ceil(total * 1000) + 250
    let sent = 0
    log(`>>> ${tag}: holding ${wallMs}ms of ${total.toFixed(2)}s audio, ${perChunkBytes}B/chunk`)
    while (Date.now() - start < wallMs) {
      const target = Math.floor(((Date.now() - start) / 1000) * IN_RATE) * 2
      while (sent + perChunkBytes <= Math.min(target, pcm.length)) {
        const slice = pcm.subarray(sent, sent + perChunkBytes)
        session.sendRealtimeInput({
          audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
        })
        sent += perChunkBytes
      }
      if (sent >= pcm.length && Date.now() - start > total * 1000 + 100) break
      await sleep(5)
    }
    // pad the rest of the hold with silence (user kept the button held)
    const silent = Buffer.alloc(perChunkBytes)
    while (Date.now() - start < wallMs) {
      session.sendRealtimeInput({
        audio: { data: silent.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      })
      await sleep(chunkMs)
    }
    log(`<<< ${tag}: audioStreamEnd after ${Date.now() - start}ms (${sent}B sent)`)
    session.sendRealtimeInput({ audioStreamEnd: true })
    return Date.now() - start
  }

  const waitFor = async (pred, timeoutMs, what) => {
    const s = Date.now()
    while (Date.now() - s < timeoutMs) {
      if (probe.stats.closed) return false
      if (pred()) return true
      await sleep(50)
    }
    log(`!!! timeout waiting for ${what} after ${timeoutMs}ms`)
    return false
  }

  const session_id = JSON.parse(fs.readFileSync(BH_DIR + '/session.json', 'utf8')).session_id

  // --- page context injection (exactly what App.tsx does) ---
  const inject = async (page) => {
    const p = await pageText(session_id, page)
    const payload = `[CONTEXT — page ${p.page} of ${p.page_count}. Do NOT respond to this; it is the current page the user is reading.]\n\n${p.text}`
    session.sendRealtimeInput({ text: payload })
    log(`    injected page ${page} (${p.text.length} chars, is_scanned=${p.is_scanned})`)
  }

  const turns = []
  try {
    await sleep(600)
    await inject(1)

    for (let i = 1; i <= TURNS; i++) {
      const before = {
        audioChunks: probe.stats.audioChunks,
        tc: probe.stats.turnCompleteAt.length,
        int: probe.stats.interruptedAt.length,
      }
      if (i > 1) await inject(Math.min(i, 12))
      const q = `q${((i - 1) % 3) + 1}`
      const flushAt = Date.now()
      await hold(q, { tag: `T${i}` })
      const got = await waitFor(() => probe.stats.turnCompleteAt.length > before.tc, 45000, `T${i} turnComplete`)
      const t = {
        turn: i,
        question: q,
        responded: got,
        firstAudioMs: probe.stats.firstAudioAt === null ? null : Date.now() - flushAt,
        audioChunks: probe.stats.audioChunks - before.audioChunks,
        interrupted: probe.stats.interruptedAt.length - before.int,
        outputChars: probe.stats.outputTranscription.length,
      }
      turns.push(t)
      log(`    T${i} result`, t)
      if (!got) log(`    (no response — see events)`)

      // Interrupt test: after the model starts speaking, hold PTT again mid-turn.
      if (i < TURNS && i % 2 === 1) {
        await sleep(1200)
        const intBefore = probe.stats.interruptedAt.length
        await hold(`q${((i) % 3) + 1}`, { tag: `T${i}-interrupt` })
        await waitFor(() => probe.stats.interruptedAt.length > intBefore, 8000, 'interrupted flag')
        const got2 = await waitFor(
          () => probe.stats.turnCompleteAt.length > before.tc + 1,
          45000,
          `T${i}b turnComplete`,
        )
        turns.push({ turn: `${i}b`, question: 'interrupt', responded: got2 })
        log(`    T${i}b result`, turns[turns.length - 1])
      }
      await sleep(400)
    }
  } catch (e) {
    probe.note('HARNESS_ERROR', { message: String(e?.message ?? e) })
  }

  // Optional long idle: watch for GoAway / spontaneous close.
  if (IDLE_MS > 0) {
    log(`--- idling ${IDLE_MS}ms to observe GoAway / spontaneous close ---`)
    const idleStart = Date.now()
    while (Date.now() - idleStart < IDLE_MS) {
      await sleep(5000)
      if (probe.stats.closed) break
      const s = Math.round((Date.now() - idleStart) / 1000)
      if (s % 30 < 6) log(`    idle ${s}s goAway=${probe.stats.goAwayAt} msgs=${probe.stats.messages}`)
    }
  }

  const openMs = Date.now() - openedAt
  log(`--- summary ${label} ---`)
  log(`    openMs=${openMs} messages=${probe.stats.messages} audioChunks=${probe.stats.audioChunks}`)
  log(`    turns=${JSON.stringify(turns)}`)
  log(`    inputTranscript="${probe.stats.inputTranscription.slice(0, 120)}"`)
  log(`    outputTranscript="${probe.stats.outputTranscription.slice(0, 160)}"`)
  log(`    close=${JSON.stringify(probe.stats.closed)} goAway=${probe.stats.goAwayAt} errors=${JSON.stringify(probe.stats.errors)}`)
  try {
    session.close()
  } catch {}
  await sleep(500)
  return { label, turns, stats: probe.stats, openMs }
}

await run(`chunk=${CHUNK_MS}ms`, CHUNK_MS)
process.exit(0)
