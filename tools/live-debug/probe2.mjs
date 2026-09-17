// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Probe whether a Live model responds at all, and how long it takes.
 * Usage: node probe2.mjs <label> <model> [thinkingLevel] [apiVersion]
 */
import { GoogleGenAI, Modality } from '@google/genai'

const [label, model, thinkingLevel, apiVersion = 'v1alpha'] = process.argv.slice(2)
const WAIT_MS = Number(process.env.WAIT_MS ?? 180000)
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)

const tok = await (await fetch('http://127.0.0.1:8000/token')).json()
const client = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion } })

let got = null
let turnCompletes = 0
let closed = null
let audioChunks = 0

const config = {
  responseModalities: [Modality.AUDIO],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
}

log(`=== ${label} model=${model} thinking=${thinkingLevel ?? 'default'} api=${apiVersion} ===`)
const session = await client.live.connect({
  model,
  config,
  callbacks: {
    onopen: () => log('open'),
    onmessage: (m) => {
      const keys = Object.keys(m).filter((k) => m[k] !== undefined)
      if (m.goAway) return log('GOAWAY', JSON.stringify(m.goAway))
      if (m.sessionResumptionUpdate) return
      if (m.usageMetadata) log('usage', JSON.stringify(m.usageMetadata).slice(0, 200))
      const c = m.serverContent
      if (!c) return log('msg:', keys.join(',') || 'EMPTY')
      const bits = []
      if (c.modelTurn?.parts) {
        let n = 0
        for (const p of c.modelTurn.parts) if (p.inlineData?.data) { n++; audioChunks++ }
        if (n) bits.push(`audio:${n}`)
      }
      if (c.inputTranscription) bits.push(`IN "${c.inputTranscription.text}"`)
      if (c.outputTranscription) bits.push(`OUT "${c.outputTranscription.text.slice(0, 80)}"`)
      if (c.interrupted) bits.push('INTERRUPTED')
      if (c.turnComplete) { turnCompletes++; bits.push('TURN_COMPLETE') }
      if (c.generationComplete) bits.push('generationComplete')
      if (c.waitingForInput) bits.push('waitingForInput')
      if (typeof c.turnCompleteReason === 'string' && c.turnCompleteReason !== 'TURN_COMPLETE_REASON_UNSPECIFIED')
        bits.push(`reason=${c.turnCompleteReason}`)
      if (bits.length) log('msg:', bits.join(' | '))
      if (got === null && (audioChunks > 0 || c.outputTranscription || c.turnComplete)) got = Date.now() - t0
    },
    onerror: (e) => log('ERROR', e.message),
    onclose: (e) => { closed = { code: e?.code, reason: e?.reason }; log('CLOSE', JSON.stringify(closed)) },
  },
})
await new Promise((r) => setTimeout(r, 800))

const prompt = 'Say the single word: hello.'
log(`sending text: "${prompt}"`)
session.sendRealtimeInput({ text: prompt })

const s = Date.now()
while (Date.now() - s < WAIT_MS && got === null && !closed) await new Promise((r) => setTimeout(r, 200))
log(`VERDICT ${label}: responded=${got !== null} firstResponse=${got}ms turnCompletes=${turnCompletes} audioChunks=${audioChunks} closed=${JSON.stringify(closed)}`)
try { session.close() } catch {}
await new Promise((r) => setTimeout(r, 300))
process.exit(0)
