// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * Live watcher — attaches to the BookTalk tab in the debug-enabled Chrome and
 * streams: console output, exceptions, UI status changes, and every Live API
 * WebSocket frame (audio summarized, control messages verbatim).
 *
 * Usage: node watch.mjs [cdpPort] [urlFilter]
 */
import fs from 'node:fs'

const PORT = Number(process.argv[2] ?? 9333)
const FILTER = process.argv[3] ?? '5173'
const LOGFILE = process.env.LIVE_LOG ?? BH_DIR + '/live.log'
fs.writeFileSync(LOGFILE, '')

const t0 = Date.now()
function say(...a) {
  const line = `[${String((Date.now() - t0) / 1000).padStart(8)}s] ${a
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')}`
  console.log(line)
  fs.appendFileSync(LOGFILE, line + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await r.json()
  return list.filter((t) => t.type === 'page' && (t.url ?? '').includes(FILTER))
}

async function connect() {
  for (let i = 0; i < 600; i++) {
    try {
      const targets = await findTarget()
      if (targets.length) {
        const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res)
          ws.addEventListener('error', rej)
        })
        return { ws, target: targets[0] }
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`no page target matching ${FILTER} on :${PORT}`)
}

const { ws, target } = await connect()
say(`attached to "${target.title}" ${target.url}`)

let id = 0
const pending = new Map()
const liveSockets = new Set()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
    return
  }
  handleEvent(msg)
})

let audioSent = 0
let audioRecv = 0
let recvBytes = 0
let sentFrames = 0
let recvFrames = 0

function fmtArgs(args) {
  return args
    .map((a) => {
      if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
      if (a.preview) {
        const props = (a.preview.properties ?? []).map((p) => `${p.name}:${p.value}`).join(' ')
        return `{${props}}`
      }
      return a.description ?? a.type
    })
    .join(' ')
}

const AUDIO_KEYS = ['audio', 'video', 'mediaChunks']
/** CDP hands WebSocket payloads base64-encoded when they are not plain UTF-8. */
function decodePayload(payload) {
  if (typeof payload !== 'string') return payload
  if (/^[A-Za-z0-9+/=\s]+$/.test(payload) && !payload.trimStart().startsWith('{')) {
    try {
      return Buffer.from(payload, 'base64').toString('utf8')
    } catch {
      return payload
    }
  }
  return payload
}
function summarizeClient(rawPayload) {
  const payload = decodePayload(rawPayload)
  try {
    const o = JSON.parse(payload)
    if (o.realtimeInput) {
      const out = {}
      for (const [k, v] of Object.entries(o.realtimeInput)) {
        if (AUDIO_KEYS.includes(k)) {
          const arr = Array.isArray(v) ? v : [v]
          out[k] = arr.map((b) => `${b?.mimeType} ${b?.data?.length ?? 0}B`)
        } else if (k === 'text') out.text = String(v).slice(0, 100)
        else out[k] = v
      }
      return `realtimeInput ${JSON.stringify(out)}`
    }
    if (o.setup) {
      const g = o.setup.generationConfig ?? {}
      return `setup model=${o.setup.model} generationConfig=${JSON.stringify(g).slice(0, 700)}`
    }
    return JSON.stringify(o).slice(0, 400)
  } catch {
    return `(unparsed ${String(payload).length}B)`
  }
}

function summarizeServer(rawPayload) {
  const payload = decodePayload(rawPayload)
  try {
    const o = JSON.parse(payload)
    if (o.serverContent) {
      const c = o.serverContent
      const bits = []
      if (c.modelTurn?.parts) {
        let n = 0
        for (const p of c.modelTurn.parts) if (p.inlineData?.data) n++
        if (n) bits.push(`audio:${n}`)
      }
      if (c.inputTranscription) bits.push(`IN "${c.inputTranscription.text}"`)
      if (c.interimInputTranscription) bits.push(`INTERIM "${c.interimInputTranscription.text}"`)
      if (c.outputTranscription) bits.push(`OUT "${c.outputTranscription.text.slice(0, 90)}"`)
      if (c.interrupted) bits.push('INTERRUPTED')
      if (c.turnComplete) bits.push(`TURN_COMPLETE${c.turnCompleteReason ? ` reason=${c.turnCompleteReason}` : ''}${c.interactionStatus ? ` status=${c.interactionStatus}` : ''}`)
      if (c.generationComplete) bits.push('generationComplete')
      if (c.waitingForInput) bits.push('waitingForInput')
      return `serverContent ${bits.join(' | ') || '(empty content)'}`
    }
    if (o.sessionResumptionUpdate) return `resumptionUpdate resumable=${o.sessionResumptionUpdate.resumable} handle=${o.sessionResumptionUpdate.newHandle ? 'yes' : 'no'}`
    if (o.goAway) return `GOAWAY timeLeft=${o.goAway.timeLeft}`
    if (o.usageMetadata) return `usage total=${o.usageMetadata.totalTokenCount}`
    if (o.setupComplete) return 'setupComplete'
    return JSON.stringify(o).slice(0, 300)
  } catch {
    return `(unparsed ${String(payload).length}B)`
  }
}

async function handleEvent(msg) {
  const m = msg.method
  if (m === 'Runtime.consoleAPICalled') {
    const text = fmtArgs(msg.params.args)
    if (msg.params.type === 'debug' && !/\[Live\]|\[shim\]/.test(text)) return
    say(`console.${msg.params.type}: ${text}`)
  } else if (m === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    say(`!! EXCEPTION: ${d.text} :: ${(d.exception?.description ?? '').split('\n').slice(0, 3).join(' / ')}`)
  } else if (m === 'Log.entryAdded') {
    const e = msg.params.entry
    if (e.level === 'error' || e.level === 'warning') say(`log.${e.level}: ${e.text}`)
  } else if (m === 'Network.webSocketCreated') {
    if (/Bidi|generativelanguage|googleapis/.test(msg.params.url)) {
      liveSockets.add(msg.params.requestId)
      say(`WS OPEN  ${msg.params.url.split('?')[0]}`)
    }
  } else if (m === 'Network.webSocketClosed') {
    if (liveSockets.has(msg.params.requestId)) {
      liveSockets.delete(msg.params.requestId)
      say(`WS CLOSED`)
    }
  } else if (m === 'Network.webSocketFrameSent') {
    if (!liveSockets.has(msg.params.requestId)) return
    sentFrames++
    const s = summarizeClient(msg.params.response?.payloadData)
    if (s.startsWith('realtimeInput') && s.includes('audio/pcm')) {
      audioSent++
      if (audioSent % 50 === 1) say(`--> audio frame #${audioSent} ${s.slice(0, 90)}`)
    } else say(`--> ${s}`)
  } else if (m === 'Network.webSocketFrameReceived') {
    if (!liveSockets.has(msg.params.requestId)) return
    recvFrames++
    const s = summarizeServer(msg.params.response?.payloadData)
    recvBytes += msg.params.response?.payloadData?.length ?? 0
    if (s.startsWith('serverContent audio:')) {
      audioRecv++
      if (audioRecv % 50 === 1) say(`<-- audio frame #${audioRecv}`)
    } else say(`<-- ${s}`)
  } else if (m === 'Network.loadingFailed') {
    if (liveSockets.has(msg.params.requestId)) say(`WS FAILED: ${msg.params.errorText} ${msg.params.canceled ? '(canceled)' : ''}`)
  }
}

async function send(method, params = {}) {
  const mid = ++id
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid)
        reject(new Error(`timeout ${method}`))
      }
    }, 15000)
  })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')
say('watching: console + Live websocket + UI state (Ctrl-C to stop)')

// UI state poller — correlates what the user sees with the wire.
let lastUi = ''
setInterval(async () => {
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const t = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
        return JSON.stringify({
          status: t('.status-label'),
          toggle: t('.session-toggle'),
          page: t('.page-indicator') ?? t('[class*=page]') ?? null,
          entries: document.querySelectorAll('.transcript-entry').length,
          last: (document.querySelector('.transcript-entry:last-child .transcript-text')?.textContent ?? '').slice(-60),
          error: t('.error-toast'),
        });
      })()`,
      returnByValue: true,
    })
    const ui = r.result.value
    if (ui && ui !== lastUi) {
      lastUi = ui
      say(`UI ${ui}`)
    }
  } catch {}
}, 1000)

setInterval(() => {
  if (sentFrames || recvFrames) {
    say(`counters: clientFrames=${sentFrames} (audio ${audioSent}) serverFrames=${recvFrames} (audio ${audioRecv}) bytesIn=${recvBytes}`)
  }
}, 15000)

process.on('SIGINT', () => {
  say(`stopping. audio frames sent=${audioSent} recv=${audioRecv} recvBytes=${recvBytes}`)
  process.exit(0)
})
