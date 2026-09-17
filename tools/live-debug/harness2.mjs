// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Harness B — isolate what wedges the Live session.
 *
 * Modes:
 *   audio        — PTT audio turns only, no page context injection
 *   realtime     — page context via sendRealtimeInput({text})   (what BookTalk does)
 *   clientcontent— page context via sendClientContent({turnComplete:false})
 *
 * Env: MODE, CHUNK_MS, TAIL_MS, TURNS, PROBE
 * Probes after the run: send a text question and see if the session still answers.
 */
import { GoogleGenAI, Modality, TurnCoverage } from '@google/genai'
import fs from 'node:fs'

const MODE = process.env.MODE ?? 'audio'
const CHUNK_MS = Number(process.env.CHUNK_MS ?? 100)
const TAIL_MS = Number(process.env.TAIL_MS ?? 0)
const TURNS = Number(process.env.TURNS ?? 3)
const PROBE = process.env.PROBE !== '0'
const IN_RATE = 16000
const MODEL_OVERRIDE = process.env.MODEL ?? ''

const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tokenRes = await (await fetch('http://127.0.0.1:8000/token')).json()
const model = MODEL_OVERRIDE || tokenRes.model
const session_id = JSON.parse(fs.readFileSync(BH_DIR + '/session.json', 'utf8')).session_id

const SYSTEM = `You are BookTalk, a knowledgeable reading companion. You can see the current page because it is injected as context.
LANGUAGE: Always answer in Telugu, keeping English technical terms in English.
CRITICAL: Never speak unless the user asks a question. Page context is NOT a question — stay silent.
If asked a question, answer it thoroughly.`

const st = {
  msgs: 0,
  turnComplete: 0,
  interrupted: 0,
  audioChunks: 0,
  audioSamples: 0,
  closed: null,
  goAway: null,
  firstAudioAt: null,
  errors: [],
  log: [],
}

function logMsg(msg) {
  const keys = Object.keys(msg).filter((k) => msg[k] !== undefined)
  const c = msg.serverContent
  if (!c) {
    st.log.push({ t: Date.now() - t0, kind: keys.join(',') || 'EMPTY', raw: JSON.stringify(msg).slice(0, 300) })
    if (!keys.length || keys.includes('setupComplete')) log(`    msg: ${keys.join(',') || 'EMPTY OBJECT'}`)
    return
  }
  const bits = []
  if (c.modelTurn?.parts) {
    let n = 0
    let s = 0
    for (const p of c.modelTurn.parts) if (p.inlineData?.data) { n++; s += (p.inlineData.data.length * 3) / 4 / 2 }
    if (n) { st.audioChunks += n; st.audioSamples += s; if (st.firstAudioAt === null) st.firstAudioAt = Date.now() - t0; bits.push(`audio:${n}parts/${Math.round(s / 24)}ms`) }
    for (const p of c.modelTurn.parts) if (p.text) bits.push(`textpart:"${p.text.slice(0, 40)}"`)
  }
  if (c.inputTranscription) bits.push(`IN:"${c.inputTranscription.text}"`)
  if (c.interimInputTranscription) bits.push(`INTERIM:"${c.interimInputTranscription.text}"`)
  if (c.outputTranscription) bits.push(`OUT:"${c.outputTranscription.text.slice(0, 60)}"`)
  if (c.interrupted) { st.interrupted++; bits.push('INTERRUPTED') }
  if (c.turnComplete) { st.turnComplete++; bits.push(`TURN_COMPLETE reason=${c.turnCompleteReason ?? '-'} status=${c.interactionStatus ?? '-'}`) }
  if (c.generationComplete) bits.push('generationComplete')
  if (c.waitingForInput) bits.push('waitingForInput')
  st.log.push({ t: Date.now() - t0, kind: 'content', bits })
  log(`    msg: ${bits.join(' | ')}`)
}

const client = new GoogleGenAI({ apiKey: tokenRes.token, httpOptions: { apiVersion: 'v1alpha' } })
let openedAt = 0
const session = await client.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: SYSTEM }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: { targetTokens: '60000' } },
    realtimeInputConfig: { turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO },
  },
  callbacks: {
    onopen: () => { openedAt = Date.now(); log('open') },
    onmessage: (m) => {
      st.msgs++
      if (m.goAway) { st.goAway = Date.now() - t0; log(`    msg: GOAWAY ${JSON.stringify(m.goAway)}`); return }
      if (m.sessionResumptionUpdate) { return }
      logMsg(m)
    },
    onerror: (e) => { st.errors.push(e.message); log(`ERROR ${e.message}`) },
    onclose: (e) => { st.closed = { code: e?.code, reason: e?.reason, openMs: Date.now() - openedAt }; log(`CLOSE ${JSON.stringify(st.closed)}`) },
  },
})
log(`=== MODE=${MODE} chunk=${CHUNK_MS}ms tail=${TAIL_MS}ms turns=${TURNS} model=${model} ===`)
await sleep(700)

const pagePayload = async (page) => {
  const p = await (await fetch(`http://127.0.0.1:8000/page?session=${session_id}&page=${page}`)).json()
  return { page: p.page, pageCount: p.page_count, text: p.text }
}

const inject = async (page) => {
  const p = await pagePayload(page)
  if (MODE === 'realtime') {
    session.sendRealtimeInput({
      text: `[CONTEXT — page ${p.page} of ${p.pageCount}. Do NOT respond to this; it is the current page the user is reading.]\n\n${p.text}`,
    })
    log(`    injected page ${p.page} via sendRealtimeInput(text)`)
  } else if (MODE === 'clientcontent') {
    session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [
            {
              text: `[CONTEXT — page ${p.page} of ${p.pageCount}. Do NOT respond to this; it is the current page the user is reading.]\n\n${p.text}`,
            },
          ],
        },
      ],
      turnComplete: false,
    })
    log(`    injected page ${p.page} via sendClientContent(turnComplete:false)`)
  }
}

/** Hold the button with a real question, optional tail silence, then flush. */
const burst = async (name, tailMs = TAIL_MS) => {
  const pcm = fs.readFileSync(BH_DIR + `/${name}.pcm`)
  const perChunkBytes = Math.floor((IN_RATE * CHUNK_MS) / 1000) * 2
  let sent = 0
  const startedAt = Date.now()
  while (sent < pcm.length) {
    const slice = pcm.subarray(sent, sent + perChunkBytes)
    session.sendRealtimeInput({ audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    sent += perChunkBytes
    await sleep(CHUNK_MS)
  }
  const silent = Buffer.alloc(perChunkBytes)
  for (let waited = 0; waited < tailMs; waited += CHUNK_MS) {
    session.sendRealtimeInput({ audio: { data: silent.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    await sleep(CHUNK_MS)
  }
  session.sendRealtimeInput({ audioStreamEnd: true })
  log(`    burst ${name} done: ${(sent / 2 / IN_RATE).toFixed(2)}s audio + ${tailMs}ms silence, flush sent (wall ${Date.now() - startedAt}ms)`)
}

async function waitTurn(timeoutMs, what) {
  const before = { tc: st.turnComplete, audio: st.audioChunks, int: st.interrupted }
  const s = Date.now()
  while (Date.now() - s < timeoutMs) {
    if (st.closed) { log(`    ${what}: session closed while waiting`); return { ok: false, closed: true } }
    if (st.turnComplete > before.tc && st.audioChunks > before.audio) break
    if (st.turnComplete > before.tc && Date.now() - s > 2500) break
    await sleep(50)
  }
  const dt = Date.now() - s
  return {
    ok: st.turnComplete > before.tc,
    ms: dt,
    audioChunks: st.audioChunks - before.audio,
    interrupted: st.interrupted - before.int,
    timedOut: dt >= timeoutMs,
  }
}

const results = []
for (let i = 1; i <= TURNS; i++) {
  const q = `q${((i - 1) % 3) + 1}`
  if (MODE !== 'audio') await inject(Math.min(i, 12))
  log(`--- turn ${i} (${q}) ---`)
  await burst(q)
  const r = await waitTurn(30000, `turn${i}`)
  results.push({ turn: i, q, ...r })
  log(`    turn ${i} => ${JSON.stringify(r)}`)
  await sleep(600)
}

if (PROBE && !st.closed) {
  log('--- probe: can the session still answer a text question? ---')
  const before = st.turnComplete
  session.sendRealtimeInput({ text: 'What is the main idea of the page you can see? Answer in one short sentence.' })
  const s = Date.now()
  while (Date.now() - s < 25000 && st.turnComplete <= before) await sleep(100)
  log(`    probe: responded=${st.turnComplete > before} in ${Date.now() - s}ms`)
}

log('--- summary ---')
log(`    model=${model} mode=${MODE} chunk=${CHUNK_MS} tail=${TAIL_MS}`)
log(`    turns: ${JSON.stringify(results)}`)
log(`    msgs=${st.msgs} turnCompletes=${st.turnComplete} interrupted=${st.interrupted} audioChunks=${st.audioChunks} (${Math.round(st.audioSamples / 24)}ms of speech)`)
log(`    goAway=${st.goAway} closed=${JSON.stringify(st.closed)} errors=${JSON.stringify(st.errors)}`)
try { session.close() } catch {}
fs.writeFileSync(
  BH_DIR + `/raw-${MODE}-${CHUNK_MS}-${TAIL_MS}.log`,
  st.log.map((l) => JSON.stringify(l)).join('\n'),
)
await sleep(300)
process.exit(0)
