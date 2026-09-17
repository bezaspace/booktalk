// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Minimal Live API probe — find a configuration where the model answers audio.
 * Usage: node probe.mjs <label> <audioFile> <strategy> <configVariant> [model]
 *   strategy: one | chunks100 | chunks100paced | chunks20
 *   configVariant: min | app
 */
import { GoogleGenAI, Modality, TurnCoverage } from '@google/genai'
import fs from 'node:fs'

const [label, audioFile, strategy, variant, modelArg] = process.argv.slice(2)
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tok = await (await fetch('http://127.0.0.1:8000/token')).json()
const model = modelArg || tok.model

const configs = {
  min: {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
  app: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: 'You are a helpful assistant. Answer in Telugu.' }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
    realtimeInputConfig: { turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO },
  },
}

const client = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: 'v1alpha' } })
let audioChunks = 0
let samples = 0
let turnCompletes = 0
let closed = null
const messages = []

const session = await client.live.connect({
  model,
  config: configs[variant],
  callbacks: {
    onopen: () => log('open'),
    onmessage: (m) => {
      const keys = Object.keys(m).filter((k) => m[k] !== undefined)
      if (m.goAway) return log('GOAWAY')
      if (m.sessionResumptionUpdate) return
      const c = m.serverContent
      if (!c) {
        messages.push(keys.join(','))
        return log('msg:', keys.join(',') || 'EMPTY')
      }
      const bits = []
      if (c.modelTurn?.parts) {
        let n = 0
        for (const p of c.modelTurn.parts) if (p.inlineData?.data) { n++; samples += (p.inlineData.data.length * 3) / 4 / 2 }
        if (n) { audioChunks += n; bits.push(`audio ${n}`) }
      }
      if (c.inputTranscription) bits.push(`IN "${c.inputTranscription.text}"`)
      if (c.outputTranscription) bits.push(`OUT "${c.outputTranscription.text.slice(0, 50)}"`)
      if (c.interrupted) bits.push('INTERRUPTED')
      if (c.turnComplete) { turnCompletes++; bits.push('TURN_COMPLETE') }
      if (bits.length) log('msg:', bits.join(' | '))
    },
    onerror: (e) => log('ERROR', e.message),
    onclose: (e) => {
      closed = { code: e?.code, reason: e?.reason }
      log('CLOSE', JSON.stringify(closed))
    },
  },
})
log(`=== ${label ?? ''} model=${model} variant=${variant} strategy=${strategy} file=${audioFile} ===`)
await sleep(800)

const pcm = fs.readFileSync(BH_DIR + `/${audioFile}`)
log(`audio: ${(pcm.length / 2 / 16000).toFixed(2)}s`)

if (strategy === 'one') {
  session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
  log('sent as one blob')
} else {
  const ms = strategy === 'chunks20' ? 20 : 100
  const bytes = Math.floor((16000 * ms) / 1000) * 2
  let sent = 0
  while (sent < pcm.length) {
    const slice = pcm.subarray(sent, sent + bytes)
    session.sendRealtimeInput({ audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    sent += bytes
    if (strategy.endsWith('paced')) await sleep(ms)
  }
  log(`sent ${Math.ceil(pcm.length / bytes)} chunks of ${ms}ms${strategy.endsWith('paced') ? ' (paced)' : ' (unpaced)'}`)
}

await sleep(1500)
log('sending audioStreamEnd')
session.sendRealtimeInput({ audioStreamEnd: true })

const s = Date.now()
while (Date.now() - s < 25000 && turnCompletes === 0 && !closed) await sleep(100)
log(`VERDICT ${label}: turnCompletes=${turnCompletes} audioChunks=${audioChunks} (${Math.round(samples / 24)}ms speech) closed=${JSON.stringify(closed)}`)

// text probe: is the session responsive at all?
if (!closed) {
  const before = turnCompletes
  session.sendRealtimeInput({ text: 'Say the word hello. One word only.' })
  const s2 = Date.now()
  while (Date.now() - s2 < 20000 && turnCompletes <= before) await sleep(100)
  log(`TEXT PROBE: responded=${turnCompletes > before} in ${Date.now() - s2}ms`)
}
try { session.close() } catch {}
await sleep(300)
process.exit(0)
