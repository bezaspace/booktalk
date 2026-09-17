// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Harness C — validate the intended BookTalk protocol before touching the app.
 *
 * Design under test:
 *   - automaticActivityDetection DISABLED (the PTT button defines the turn)
 *   - PTT press  -> activityStart
 *     PTT release-> activityEnd            (no audioStreamEnd)
 *   - page context -> sendClientContent({turns, turnComplete:false})  (silent)
 *   - audio batched to 64ms chunks
 *
 * Turns: ask, ask, ask-while-speaking (interrupt), ask. Page context injected
 * between turns, and the silence after each injection is asserted.
 */
import { GoogleGenAI, Modality, TurnCoverage } from '@google/genai'
import fs from 'node:fs'

const CHUNK_MS = Number(process.env.CHUNK_MS ?? 64)
const MODEL_OVERRIDE = process.env.MODEL ?? ''
const IN_RATE = 16000
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tok = await (await fetch('http://127.0.0.1:8000/token')).json()
const model = MODEL_OVERRIDE || tok.model
const session_id = JSON.parse(fs.readFileSync(BH_DIR + '/session.json', 'utf8')).session_id

const st = {
  turnCompletes: 0,
  interrupted: 0,
  audioChunks: 0,
  messages: 0,
  closed: null,
  contextEchoes: 0,
  lastEventAt: 0,
  errors: [],
}

const client = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: 'v1alpha' } })
const session = await client.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: {
      parts: [
        {
          text: `You are BookTalk, a reading companion. The user's current page is provided as context.
Always answer in Telugu, keeping English technical terms in English.
Never speak unless the user asks a question — page context is never a question.`,
        },
      ],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
    realtimeInputConfig: {
      turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
      automaticActivityDetection: { disabled: true },
    },
  },
  callbacks: {
    onopen: () => log('open'),
    onmessage: (m) => {
      st.messages++
      st.lastEventAt = Date.now() - t0
      if (m.goAway) return log('GOAWAY', JSON.stringify(m.goAway))
      if (m.sessionResumptionUpdate) return
      const c = m.serverContent
      if (!c) return log('msg:', Object.keys(m).filter((k) => m[k] !== undefined).join(',') || 'EMPTY')
      const bits = []
      if (c.modelTurn?.parts) {
        let n = 0
        for (const p of c.modelTurn.parts) if (p.inlineData?.data) { n++; st.audioChunks++ }
        if (n) bits.push(`audio:${n}`)
      }
      if (c.inputTranscription) bits.push(`IN "${c.inputTranscription.text.slice(0, 70)}"`)
      if (c.outputTranscription) bits.push(`OUT "${c.outputTranscription.text.slice(0, 60)}"`)
      if (c.interrupted) { st.interrupted++; bits.push('INTERRUPTED') }
      if (c.turnComplete) { st.turnCompletes++; bits.push('TURN_COMPLETE') }
      if (c.generationComplete) bits.push('generationComplete')
      if (bits.length) log('    msg:', bits.join(' | '))
    },
    onerror: (e) => { st.errors.push(e.message); log('ERROR', e.message) },
    onclose: (e) => { st.closed = { code: e?.code, reason: e?.reason }; log('CLOSE', JSON.stringify(st.closed)) },
  },
})
log(`=== fixed-protocol harness: model=${model} chunk=${CHUNK_MS}ms ===`)
await sleep(800)

const bytes = Math.floor((IN_RATE * CHUNK_MS) / 1000) * 2

/** One push-to-talk burst: activityStart, paced audio, activityEnd. */
async function ptt(name) {
  const pcm = fs.readFileSync(BH_DIR + `/${name}.pcm`)
  const before = { tc: st.turnCompletes, audio: st.audioChunks, int: st.interrupted, msgs: st.messages }
  const t = Date.now()
  session.sendRealtimeInput({ activityStart: {} })
  for (let sent = 0; sent < pcm.length; sent += bytes) {
    const slice = pcm.subarray(sent, sent + bytes)
    session.sendRealtimeInput({ audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    await sleep(CHUNK_MS)
  }
  session.sendRealtimeInput({ activityEnd: {} })
  log(`    PTT(${name}) released after ${Date.now() - t}ms of audio`)
  return before
}

async function waitTurn(before, timeoutMs, what) {
  const s = Date.now()
  while (Date.now() - s < timeoutMs) {
    if (st.closed) return { ok: false, closed: true }
    if (st.turnCompletes > before.tc) {
      // let the audio keep flowing a moment so we measure the whole turn
      await sleep(1200)
      return { ok: true, ms: Date.now() - s, audio: st.audioChunks - before.audio }
    }
    await sleep(50)
  }
  return { ok: false, timedOut: true, ms: Date.now() - s }
}

/** Silent context injection via clientContent; asserts the model stays quiet. */
async function injectPage(page) {
  const p = await (await fetch(`http://127.0.0.1:8000/page?session=${session_id}&page=${page}`)).json()
  const msgsBefore = st.messages
  const audioBefore = st.audioChunks
  session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [
          {
            text: `[CONTEXT — page ${p.page} of ${p.page_count}. This is the page the user is reading. Do NOT respond to this.]\n\n${p.text}`,
          },
        ],
      },
    ],
    turnComplete: false,
  })
  await sleep(3000)
  const echoed = st.messages > msgsBefore || st.audioChunks > audioBefore
  if (echoed) st.contextEchoes++
  log(`    injected page ${p.page} (${p.text.length} chars) — model stayed silent: ${!echoed}`)
  return !echoed
}

const results = []

// turn 1: plain question
await injectPage(1)
let before = await ptt('q1')
let r = await waitTurn(before, 30000, 'turn1')
results.push({ turn: 1, ...r })
log(`    turn1 => ${JSON.stringify(r)}`)

// turn 2: plain question after a page turn
await injectPage(2)
before = await ptt('q2')
r = await waitTurn(before, 30000, 'turn2')
results.push({ turn: 2, ...r })
log(`    turn2 => ${JSON.stringify(r)}`)

// turn 3: interrupt the model while it is speaking
const intBefore = st.interrupted
log('    waiting for the model to start speaking before interrupting...')
const w = Date.now()
while (Date.now() - w < 20000 && st.audioChunks === before.audio + 1) await sleep(100)
await sleep(1500)
before = await ptt('q3')
r = await waitTurn(before, 30000, 'turn3')
results.push({ turn: 3, interrupted: st.interrupted - intBefore, ...r })
log(`    turn3 (interrupt) => ${JSON.stringify(r)} interruptedEvents=${st.interrupted - intBefore}`)

// turn 4: another plain question on a new page
await injectPage(3)
before = await ptt('q1')
r = await waitTurn(before, 30000, 'turn4')
results.push({ turn: 4, ...r })
log(`    turn4 => ${JSON.stringify(r)}`)

log('--- summary ---')
log(`    results: ${JSON.stringify(results)}`)
log(`    turnCompletes=${st.turnCompletes} interrupted=${st.interrupted} audioChunks=${st.audioChunks} contextEchoes=${st.contextEchoes}`)
log(`    closed=${JSON.stringify(st.closed)} errors=${JSON.stringify(st.errors)}`)
try { session.close() } catch {}
await sleep(300)
process.exit(0)
