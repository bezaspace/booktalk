// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Probe the push-to-talk turn boundary.
 * Usage: node probe4.mjs <label> <audioFile> <variant> [tailMs]
 *   variants:
 *     vad          — automatic VAD, N ms of trailing silence, then audioStreamEnd
 *     vadflush2    — automatic VAD, flush, then a second flush 1.5s later
 *     explicit     — automatic VAD DISABLED, activityStart -> audio -> activityEnd
 *     explicittext — VAD disabled, activityStart -> audio -> activityEnd, then text ask
 */
import { GoogleGenAI, Modality, TurnCoverage } from '@google/genai'
import fs from 'node:fs'

const [label, audioFile, variant, tailArg] = process.argv.slice(2)
const TAIL_MS = Number(tailArg ?? 800)
const IN_RATE = 16000
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tok = await (await fetch('http://127.0.0.1:8000/token')).json()
const client = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: 'v1alpha' } })

let turnCompletes = 0
let audioChunks = 0
let interrupted = 0
let closed = null
let firstResponse = null
const transcript = { in: '', out: '' }

const session = await client.live.connect({
  model: tok.model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: 'You are a helpful assistant. Answer briefly in Telugu.' }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
    realtimeInputConfig: {
      turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
      ...(variant.startsWith('explicit')
        ? { automaticActivityDetection: { disabled: true } }
        : {}),
    },
  },
  callbacks: {
    onopen: () => log('open'),
    onmessage: (m) => {
      if (m.goAway) return log('GOAWAY')
      if (m.sessionResumptionUpdate) return
      const c = m.serverContent
      if (!c) return log('msg:', Object.keys(m).filter((k) => m[k] !== undefined).join(',') || 'EMPTY')
      const bits = []
      if (c.modelTurn?.parts) {
        let n = 0
        for (const p of c.modelTurn.parts) if (p.inlineData?.data) { n++; audioChunks++ }
        if (n) bits.push(`audio:${n}`)
      }
      if (c.inputTranscription) { transcript.in += c.inputTranscription.text; bits.push(`IN "${c.inputTranscription.text}"`) }
      if (c.outputTranscription) { transcript.out += c.outputTranscription.text; bits.push(`OUT "${c.outputTranscription.text.slice(0, 60)}"`) }
      if (c.interrupted) { interrupted++; bits.push('INTERRUPTED') }
      if (c.turnComplete) { turnCompletes++; bits.push(`TURN_COMPLETE${c.waitingForInput ? ' waitingForInput' : ''}${c.turnCompleteReason ? ' reason=' + c.turnCompleteReason : ''}`) }
      if (c.generationComplete) bits.push('generationComplete')
      if (bits.length) log('msg:', bits.join(' | '))
      if (firstResponse === null && (audioChunks > 0 || c.outputTranscription)) firstResponse = Date.now() - t0
    },
    onerror: (e) => log('ERROR', e.message),
    onclose: (e) => { closed = { code: e?.code, reason: e?.reason }; log('CLOSE', JSON.stringify(closed)) },
  },
})
log(`=== ${label} variant=${variant} tail=${TAIL_MS}ms file=${audioFile} model=${tok.model} ===`)
await sleep(900)

const pcm = fs.readFileSync(BH_DIR + `/${audioFile}`)
const CHUNK_MS = 100
const bytes = Math.floor((IN_RATE * CHUNK_MS) / 1000) * 2

async function sendAudio(pacedMs) {
  for (let sent = 0; sent < pcm.length; sent += bytes) {
    const slice = pcm.subarray(sent, sent + bytes)
    session.sendRealtimeInput({ audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    if (pacedMs) await sleep(pacedMs)
  }
}
async function sendSilence(ms) {
  const silent = Buffer.alloc(bytes)
  for (let t = 0; t < ms; t += CHUNK_MS) {
    session.sendRealtimeInput({ audio: { data: silent.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    await sleep(CHUNK_MS)
  }
}

// A real user holds the button: press, speak, release.
if (variant === 'explicit' || variant === 'explicittext') {
  log('activityStart')
  session.sendRealtimeInput({ activityStart: {} })
  await sendAudio(CHUNK_MS)
  log(`activityEnd after ${(pcm.length / 2 / IN_RATE).toFixed(2)}s of audio`)
  session.sendRealtimeInput({ activityEnd: {} })
} else {
  await sendAudio(CHUNK_MS)
  log(`audio done, sending ${TAIL_MS}ms trailing silence`)
  await sendSilence(TAIL_MS)
  log('audioStreamEnd')
  session.sendRealtimeInput({ audioStreamEnd: true })
  if (variant === 'vadflush2') {
    await sleep(1500)
    log('second flush (120ms silence + audioStreamEnd)')
    await sendSilence(150)
    session.sendRealtimeInput({ audioStreamEnd: true })
  }
}

const s = Date.now()
while (Date.now() - s < 60000 && turnCompletes === 0 && !closed) await sleep(150)
log(`VERDICT ${label}: turnCompletes=${turnCompletes} audioChunks=${audioChunks} interrupted=${interrupted} firstResponse=${firstResponse} IN="${transcript.in.slice(0, 80)}" OUT="${transcript.out.slice(0, 60)}" closed=${JSON.stringify(closed)}`)

if (variant === 'explicittext' && !closed) {
  const before = turnCompletes
  log('follow-up text question')
  session.sendRealtimeInput({ text: 'Now say the word goodbye.' })
  const s2 = Date.now()
  while (Date.now() - s2 < 30000 && turnCompletes <= before) await sleep(150)
  log(`TEXT AFTER AUDIO: responded=${turnCompletes > before} in ${Date.now() - s2}ms`)
}
try { session.close() } catch {}
await sleep(300)
process.exit(0)
