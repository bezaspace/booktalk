// Scratch dir for generated assets/logs (see README.md).
const BH_DIR = process.env.BH_DIR ?? '/tmp/bh'
/**
 * BookTalk E2E harness — drives the real app in Chrome over CDP.
 *
 * - Launches an isolated Chrome with a synthetic microphone (a JS shim replaces
 *   getUserMedia with a MediaStream fed from real spoken-question WAVs).
 * - Uploads a test PDF, starts the Live session, then runs a multi-turn
 *   push-to-talk scenario including interrupts, exactly like a user would.
 * - Records: status transitions, transcript growth, console output, JS
 *   exceptions, and every Live API WebSocket frame (control messages only).
 *
 * Usage: node e2e.mjs [scenario] [label]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const SCENARIO = process.argv[2] ?? 'turns'
const LABEL = process.argv[3] ?? SCENARIO
const HEADLESS = process.env.BH_HEADED !== '1'
const CDP_PORT = Number(process.env.BH_CDP_PORT ?? 9333)
const ASSET_PORT = 8123
const OUT = BH_DIR + `/e2e-${LABEL}-${Date.now()}.log`

const lines = []
const t0 = Date.now()
function say(...a) {
  const line = `[${String(Date.now() - t0).padStart(7)}ms] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
  lines.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const startedAt = Date.now()

// ---------------------------------------------------------------------------
// static asset server (question WAVs for the synthetic mic)
// ---------------------------------------------------------------------------
function serveAssets() {
  const srv = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''))
    const path = BH_DIR + `/${name}`
    if (!/^[a-z0-9_.-]+$/i.test(name) || !fs.existsSync(path)) {
      res.writeHead(404).end('nope')
      return
    }
    const body = fs.readFileSync(path)
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
    })
    res.end(body)
  })
  return new Promise((resolve) => srv.listen(ASSET_PORT, '127.0.0.1', () => resolve(srv)))
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        }
        return
      }
      for (const fn of this.listeners) fn(msg)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 30000)
    })
  }
  on(fn) {
    this.listeners.push(fn)
  }
}

async function launchChrome() {
  const profile = BH_DIR + `/chrome-${LABEL}`
  fs.rmSync(profile, { recursive: true, force: true })
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1500,950',
    ...(HEADLESS ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
    'about:blank',
  ]
  const child = spawn('/usr/local/bin/google-chrome', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (/DevTools listening|ERROR|FATAL/.test(s)) process.stderr.write(`[chrome] ${s}`)
  })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) {
        say(`chrome up (${HEADLESS ? 'headless' : 'headed'})`)
        return child
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('chrome did not start')
}

async function newPage() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })
  const t = await r.json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  return new CDP(ws)
}

// Synthetic microphone: getUserMedia -> MediaStream fed by decoded WAV buffers.
const MIC_SHIM = `(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  const buffers = {};
  if (!window.isSecureContext) console.warn('[shim] insecure context');
  try {
    navigator.mediaDevices.getUserMedia = async () => {
      console.log('[shim] getUserMedia -> synthetic stream');
      return dest.stream;
    };
  } catch (e) { console.error('[shim] failed to override getUserMedia', e); }
  window.__bh = {
    ctx, dest,
    async load(name) {
      const r = await fetch('http://127.0.0.1:${ASSET_PORT}/' + name + '.wav');
      buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
      console.log('[shim] loaded', name, buffers[name].duration.toFixed(2) + 's');
      return buffers[name].duration;
    },
    async play(name) {
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
      const src = ctx.createBufferSource();
      src.buffer = buffers[name];
      src.connect(dest);
      src.start();
      window.__bh.current = src;
      console.log('[shim] playing', name, 'ctx=' + ctx.state, 't=' + ctx.currentTime.toFixed(2));
      return buffers[name].duration;
    },
    stop() { try { window.__bh.current && window.__bh.current.stop(); } catch {} },
    state() { return { ctx: ctx.state, t: ctx.currentTime, playing: !!window.__bh.current }; }
  };
})();`

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

function summarizeFrame(rawPayload) {
  const payload = decodePayload(rawPayload)
  try {
    const o = JSON.parse(payload)
    const out = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'setup') {
        const s = v ?? {}
        out.setup = {
          model: s.model,
          keys: Object.keys(s.generationConfig ?? {}),
          generationConfig: s.generationConfig,
        }
      } else if (k === 'realtimeInput') {
        const ri = v ?? {}
        const small = {}
        for (const [rk, rv] of Object.entries(ri)) {
          if (AUDIO_KEYS.includes(rk)) {
            const b = rv
            const blobs = Array.isArray(b) ? b : [b]
            small[rk] = blobs.map((x) => ({ mime: x?.mimeType, b64len: x?.data?.length ?? 0 }))
          } else if (rk === 'text') {
            small.text = String(rv).slice(0, 80)
          } else {
            small[rk] = rv
          }
        }
        out.realtimeInput = small
      } else if (k === 'clientContent') {
        out.clientContent = v
      } else {
        out[k] = v
      }
    }
    return out
  } catch {
    return { raw: String(payload).slice(0, 120) }
  }
}

function summarizeServerFrame(rawPayload) {
  const payload = decodePayload(rawPayload)
  try {
    const o = JSON.parse(payload)
    const out = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'serverContent') {
        const c = { ...v }
        if (c.modelTurn?.parts) {
          c.modelTurn = {
            parts: c.modelTurn.parts.map((p) => ({
              audioB64Len: p.inlineData?.data?.length ?? undefined,
              text: p.text?.slice(0, 60),
            })),
          }
        }
        out.serverContent = c
      } else out[k] = v
    }
    return out
  } catch {
    return { raw: String(payload).slice(0, 120) }
  }
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------
let cdp
async function evalJs(expr, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

async function clickSelector(sel) {
  const box = await evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; })()`,
  )
  if (!box) throw new Error(`no element for ${sel}`)
  const p = { x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, buttons: 0 })
}

async function pttDown() {
  if (pttHeld) return
  const box = await evalJs(
    `(() => { const el = document.querySelector('.ptt-button'); const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
    buttons: 1,
  })
  pttHeld = true
  say(`PTT DOWN (${(Date.now() - startedAt) / 1000}s)`)
}

async function pttUp() {
  if (!pttHeld) return
  const box = await evalJs(
    `(() => { const el = document.querySelector('.ptt-button'); const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
    buttons: 0,
  })
  pttHeld = false
  say(`PTT UP   (${(Date.now() - startedAt) / 1000}s)`)
}
let pttHeld = false

async function status() {
  return evalJs(`document.querySelector('.status-label')?.textContent ?? null`)
}
async function ui() {
  return evalJs(`(() => ({
    status: document.querySelector('.status-label')?.textContent ?? null,
    entries: document.querySelectorAll('.transcript-entry').length,
    assistant: Array.from(document.querySelectorAll('.transcript-entry.assistant .transcript-text')).map(e=>e.textContent),
    user: Array.from(document.querySelectorAll('.transcript-entry.user .transcript-text')).map(e=>e.textContent),
    error: document.querySelector('.error-toast')?.textContent ?? null,
    startLabel: document.querySelector('.session-toggle')?.textContent ?? null,
  }))()`)
}

let lastStatus = null
async function watch(ms, tag) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    let s = null
    try {
      s = await status()
    } catch {}
    if (s !== lastStatus) {
      say(`   status: ${lastStatus} -> ${s}  (${tag}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
      lastStatus = s
    }
    await sleep(120)
  }
}

async function waitStatus(target, timeoutMs, tag) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const u = await ui()
    if (u.status === target) return true
    if (u.error) {
      say(`   ERROR TOAST (${tag}): ${u.error}`)
      return false
    }
    await sleep(150)
  }
  say(`   TIMEOUT waiting for status "${target}" (${tag})`)
  return false
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const assetSrv = await serveAssets()
const chrome = await launchChrome()
cdp = await newPage()

const consoleLines = []
const wsFrames = []

cdp.on(async (msg) => {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
      .join(' ')
    const lvl = msg.params.type
    consoleLines.push(`${lvl}: ${text}`)
    if (/\[Live\]|\[shim\]/.test(text) || lvl === 'error' || lvl === 'warning') {
      say(`   console.${lvl}: ${text}`)
    }
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    say(`   EXCEPTION: ${d.text} ${d.exception?.description?.split('\n')[0] ?? ''}`)
    consoleLines.push(`exception: ${d.text} ${d.exception?.description ?? ''}`)
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    if (e.level === 'error' || e.level === 'warning') {
      say(`   log.${e.level}: ${e.text} ${e.url ?? ''}`)
      consoleLines.push(`log.${e.level}: ${e.text}`)
    }
  } else if (msg.method === 'Network.webSocketCreated') {
    say(`   WS created: ${msg.params.url.split('?')[0]}`)
  } else if (msg.method === 'Network.webSocketClosed') {
    say(`   WS closed`)
  } else if (msg.method === 'Network.webSocketFrameSent') {
    const s = summarizeFrame(msg.params.response.payloadData)
    wsFrames.push({ dir: 'sent', t: Date.now() - startedAt, s })
    const ri = s.realtimeInput
    if (ri?.audio) {
      wsAudioSent += 1
      if (wsAudioSent % 25 === 1) say(`   -> audio frame #${wsAudioSent} (${ri.audio[0].b64len}B)`)
    } else {
      say(`   -> ${JSON.stringify(s).slice(0, 300)}`)
    }
  } else if (msg.method === 'Network.webSocketFrameReceived') {
    const s = summarizeServerFrame(msg.params.response.payloadData)
    wsFrames.push({ dir: 'recv', t: Date.now() - startedAt, s })
    const c = s.serverContent
    if (c?.modelTurn?.parts?.some((p) => p.audioB64Len)) {
      wsAudioRecv += 1
      if (wsAudioRecv % 25 === 1) say(`   <- audio frame #${wsAudioRecv}`)
    } else {
      say(`   <- ${JSON.stringify(s).slice(0, 400)}`)
    }
  }
})
let wsAudioSent = 0
let wsAudioRecv = 0

await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Log.enable')
await cdp.send('Network.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MIC_SHIM })
await cdp.send('Page.navigate', { url: 'http://localhost:5173/' })
await sleep(2500)
say(`page title: ${await evalJs('document.title')}`)
say(`mic shim: ${JSON.stringify(await evalJs('({ secure: isSecureContext, shim: !!window.__bh, state: window.__bh && window.__bh.state() })'))}`)

// preflight: does WebAudio actually advance in this mode?
const preflight = await evalJs(
  `(async () => { const c = new AudioContext(); await c.resume(); await new Promise(r => setTimeout(r, 400));
     return { state: c.state, t: c.currentTime, sr: c.sampleRate }; })()`,
  true,
)
say(`audio preflight: ${JSON.stringify(preflight)}`)

// load question audio
for (const q of ['q1', 'q2', 'q3']) {
  const d = await evalJs(`window.__bh.load('${q}')`, true)
  say(`loaded ${q}: ${d}s`)
}

// upload the PDF via the hidden file input
const doc = await cdp.send('DOM.getDocument', { depth: -1 })
const inputNode = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
await cdp.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [BH_DIR + '/test.pdf'] })
say('uploaded test.pdf')
for (let i = 0; i < 100; i++) {
  const u = await ui()
  if (u.status !== null) break
  await sleep(200)
}
say(`after upload: ${JSON.stringify(await ui())}`)

// start the Live session
await clickSelector('.session-toggle')
say('clicked Start')
if (!(await waitStatus('Ready', 30000, 'start'))) {
  say(`start failed: ${JSON.stringify(await ui())}`)
}
lastStatus = await status()
say(`session status: ${lastStatus}`)

// ---------------------------------------------------------------------------
// scenario
// ---------------------------------------------------------------------------
async function ask(name, { holdExtraMs = 300 } = {}) {
  await pttDown()
  const dur = await evalJs(`window.__bh.play('${name}')`, true)
  say(`playing ${name} (${dur}s)`)
  await sleep(dur * 1000 + holdExtraMs)
  await pttUp()
  return dur
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  say(`CHECK ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`)
}

/** Wait for an assistant entry that appears after the given count. */
async function waitAssistantAfter(countBefore, timeoutMs, tag) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const u = await ui()
    // Wait until a new assistant entry exists AND has real text in it.
    if (u.assistant.length > countBefore && (u.assistant[countBefore] ?? '').length > 40) return u
    await sleep(200)
  }
  say(`   TIMEOUT waiting for an answer (${tag}); ui=${JSON.stringify(await ui())}`)
  return null
}

const results = []
try {
  // --- silent context: the page injected at session start must not speak ---
  say('--- check: page context stays silent for 12s after Start ---')
  let unprompted = false
  for (let i = 0; i < 60; i++) {
    const s = await status()
    if (s === 'Speaking…' || s === 'Thinking…') unprompted = true
    await sleep(200)
  }
  check('page context does not trigger speech', !unprompted, `status=${await status()}`)

  // --- turn 1: plain question, full answer ---
  say('--- turn 1: q1 ---')
  const u0 = await ui()
  await ask('q1')
  say(`   after release: ${JSON.stringify(await ui())}`)
  const a1 = await waitAssistantAfter(u0.assistant.length, 60000, 'turn1')
  check('turn 1 answered', !!a1)
  results.push({ turn: 1, ok: !!a1 })
  const r1 = await waitStatus('Ready', 90000, 'turn1-done')
  check('turn 1 returns to Ready', r1, `status=${await status()}`)

  // --- turn 2: interrupt while the model speaks ---
  say('--- turn 2: q2, then interrupt with q3 while it speaks ---')
  const u2 = await ui()
  await ask('q2')
  const speaking = await waitStatus('Speaking…', 60000, 'turn2-speaking')
  check('turn 2 starts speaking', speaking)
  await sleep(1500)
  const beforeInterrupt = await ui()
  await ask('q3')
  say(`   interrupted at ${beforeInterrupt.assistant.map((a) => a.length)} chars`)
  // The interrupted turn's tail can land in its own entry, so accept the first
  // assistant entry at or after the interrupt that actually carries an answer.
  const a2 = await (async () => {
    const end = Date.now() + 60000
    while (Date.now() < end) {
      const u = await ui()
      const fresh = u.assistant.slice(beforeInterrupt.assistant.length).find((t) => t.length > 80)
      if (fresh) return u
      await sleep(250)
    }
    say(`   TIMEOUT waiting for an answer after the interrupt; ui=${JSON.stringify(await ui())}`)
    return null
  })()
  check('answering continues after the interrupt', !!a2)
  results.push({ turn: 2, interrupted: true, ok: !!a2 })
  const r2 = await waitStatus('Ready', 90000, 'turn2-done')
  check('turn 2 (after interrupt) returns to Ready', r2, `status=${await status()}`)

  // --- turn 3: another plain question ---
  say('--- turn 3: q1 again ---')
  const u3 = await ui()
  await ask('q1')
  const a3 = await waitAssistantAfter(u3.assistant.length, 60000, 'turn3')
  check('turn 3 answered', !!a3)
  results.push({ turn: 3, ok: !!a3 })
  const r3 = await waitStatus('Ready', 90000, 'turn3-done')
  check('turn 3 returns to Ready', r3, `status=${await status()}`)

  // --- network drop: the old build flickered Connecting…/Ready forever here ---
  say('--- network drop: offline for 6s, then back ---')
  const reconnectsBefore = consoleLines.filter((l) => /scheduling reconnect/.test(l)).length
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await sleep(6000)
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await sleep(1500)
  const recovered = await waitStatus('Ready', 90000, 'after-network-drop')
  check('recovers to Ready after a network drop', recovered, `status=${await status()}`)
  const reconnects = consoleLines.filter((l) => /scheduling reconnect/.test(l)).length - reconnectsBefore
  check('no reconnect storm', reconnects <= 5, `${reconnects} reconnect schedules`)
  const exhausted = consoleLines.filter((l) => /keeps dropping|giving up after/.test(l)).length
  check('no exhausted-teardown', exhausted === 0, `${exhausted} happen`)
  const flapping = consoleLines.filter((l) => /ignoring close from superseded socket/.test(l)).length
  say(`   superseded-socket closes ignored: ${flapping}`)

  // --- still usable after the drop ---
  say('--- turn 4: q2 after the reconnect ---')
  const u4 = await ui()
  await ask('q2')
  const a4 = await waitAssistantAfter(u4.assistant.length, 60000, 'turn4')
  check('answers after the reconnect', !!a4)
  results.push({ turn: 4, afterReconnect: true, ok: !!a4 })
  await waitStatus('Ready', 90000, 'turn4-done')

  const fin = await ui()
  check('no error toast at the end', !fin.error, fin.error ?? '')
  check('user speech was transcribed', fin.user.join(' ').length > 20, `${fin.user.length} entries`)
} catch (e) {
  say(`SCENARIO ERROR: ${e.message}\n${e.stack}`)
  checks.push({ name: 'scenario completed', ok: false, detail: e.message })
}

const finalUi = await ui()
say(`FINAL UI: ${JSON.stringify(finalUi)}`)
say(`WS audio frames: sent=${wsAudioSent} recv=${wsAudioRecv}`)
say(`console lines: ${consoleLines.length}`)
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(BH_DIR + `/shot-${LABEL}.png`, Buffer.from(shot.data, 'base64'))
say(`screenshot: ${BH_DIR}/shot-${LABEL}.png`)
say(`results: ${JSON.stringify(results)}`)
const failed = checks.filter((c) => !c.ok)
say(`E2E VERDICT: ${checks.length - failed.length}/${checks.length} checks passed`)
for (const c of checks) say(`   ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)

fs.writeFileSync(OUT, lines.join('\n'))
fs.writeFileSync(BH_DIR + `/console-${LABEL}.log`, consoleLines.join('\n'))
fs.writeFileSync(
  BH_DIR + `/frames-${LABEL}.log`,
  wsFrames.map((f) => `${f.t}ms ${f.dir} ${JSON.stringify(f.s)}`).join('\n'),
)
console.log(`\nlogs: ${OUT}`)

try {
  chrome.kill('SIGKILL')
} catch {}
assetSrv.close()
process.exit(0)
