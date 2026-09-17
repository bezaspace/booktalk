/** BookTalk — read a PDF alongside a real-time voice assistant. */

import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

import { fetchOutline, fetchPage, fetchToken, uploadPdf } from './api'
import { PdfViewer, canvasToJpegBytes } from './pdf/PdfViewer'
import { Sidebar } from './pdf/Sidebar'
import { VoicePanel } from './voice/VoicePanel'
import { LiveSession } from './voice/LiveSession'
import type { OutlineItem, TranscriptEntry, VoiceStatus } from './types'

type Phase = 'upload' | 'reading'

export default function App() {
  const [phase, setPhase] = useState<Phase>('upload')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PDF state
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // Outline / thumbnails sidebar
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [hasOutline, setHasOutline] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const isResizingRef = useRef(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(280)

  // Voice state
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [sessionActive, setSessionActive] = useState(false)
  // Mic level 0..1 for the meter, sampled while listening.
  const [micLevel, setMicLevel] = useState(0)

  const liveRef = useRef<LiveSession | null>(null)
  const lastInjectedPageRef = useRef<number>(-1)
  const currentCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // ---------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const resp = await uploadPdf(file)
      setPdfData(buf)
      setSessionId(resp.session_id)
      setPageCount(resp.page_count)
      setCurrentPage(1)
      lastInjectedPageRef.current = -1
      // Fetch outline for the sidebar — non-fatal if it fails.
      setOutline([])
      setHasOutline(false)
      setSidebarCollapsed(false)
      fetchOutline(resp.session_id)
        .then((o) => {
          setOutline(o.items)
          setHasOutline(o.has_outline)
          if (!o.has_outline) setSidebarCollapsed(false)
        })
        .catch(() => {
          /* leave empty */
        })
      setPhase('reading')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }, [])

  // ---------------------------------------------------------------------
  // Context bridge: inject current page into the Live session on page change
  // ---------------------------------------------------------------------
  const injectCurrentPage = useCallback(
    async (page: number) => {
      const session = liveRef.current
      const sid = sessionId
      if (!session || !sid) return
      if (page === lastInjectedPageRef.current) return
      lastInjectedPageRef.current = page

      try {
        const pageResp = await fetchPage(sid, page)
        if (pageResp.is_scanned) {
          // Scanned/image page — send the rendered canvas as a JPEG frame.
          const canvas = currentCanvasRef.current
          if (canvas) {
            const jpeg = await canvasToJpegBytes(canvas, 0.7)
            session.injectImagePage(jpeg, page, pageResp.page_count)
          }
        } else if (pageResp.text) {
          session.injectTextPage(page, pageResp.page_count, pageResp.text)
        }
      } catch (e) {
        // Non-fatal: context injection is best-effort.
        console.warn('Context injection failed:', e)
      }
    },
    [sessionId],
  )

  // ---------------------------------------------------------------------
  // Live session lifecycle (explicit start / stop)
  // ---------------------------------------------------------------------
  const startSession = useCallback(async () => {
    if (liveRef.current) return
    setError(null)
    try {
      const { token, model } = await fetchToken()
      const session = new LiveSession(token, model, {
        onStatus: setStatus,
        onTranscript: (entry) =>
          setTranscript((prev) => [...prev, entry]),
        onTranscriptUpdate: (id, text, partial) =>
          setTranscript((prev) =>
            prev.map((e) => (e.id === id ? { ...e, text, partial } : e)),
          ),
        onError: (msg) => {
          setError(msg)
          setStatus('error')
        },
        onNotice: (msg) => setError(msg),
        onExhausted: (msg) => {
          // Reconnects gave up: session already torn down to idle inside.
          // Drop the ref so one Start press cleanly restarts (page stays).
          liveRef.current = null
          setSessionActive(false)
          setStatus('idle')
          setError(msg)
          lastInjectedPageRef.current = -1
        },
        refreshToken: fetchToken,
      })
      await session.connect()
      liveRef.current = session
      setSessionActive(true)
      // Re-inject the current page so a freshly started session has context.
      lastInjectedPageRef.current = -1
      void injectCurrentPage(currentPage)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
      setSessionActive(false)
    }
  }, [injectCurrentPage, currentPage])

  const stopSession = useCallback(() => {
    liveRef.current?.close()
    liveRef.current = null
    setSessionActive(false)
    setStatus('idle')
    // Force re-injection of the current page on next start.
    lastInjectedPageRef.current = -1
  }, [])

  // Refresh the Gemini Live session: tear down the current connection,
  // clear the transcript, and start a brand-new session with fresh context
  // (new ephemeral token, no resumption handle). The PDF stays put.
  const refreshSession = useCallback(async () => {
    liveRef.current?.close()
    liveRef.current = null
    setSessionActive(false)
    setStatus('idle')
    setTranscript([])
    lastInjectedPageRef.current = -1
    setError(null)
    // Start a fresh session and re-inject the current page context.
    try {
      const { token, model } = await fetchToken()
      const session = new LiveSession(token, model, {
        onStatus: setStatus,
        onTranscript: (entry) =>
          setTranscript((prev) => [...prev, entry]),
        onTranscriptUpdate: (id, text, partial) =>
          setTranscript((prev) =>
            prev.map((e) => (e.id === id ? { ...e, text, partial } : e)),
          ),
        onError: (msg) => {
          setError(msg)
          setStatus('error')
        },
        onNotice: (msg) => setError(msg),
        onExhausted: (msg) => {
          liveRef.current = null
          setSessionActive(false)
          setStatus('idle')
          setError(msg)
          lastInjectedPageRef.current = -1
        },
        refreshToken: fetchToken,
      })
      await session.connect()
      liveRef.current = session
      setSessionActive(true)
      lastInjectedPageRef.current = -1
      void injectCurrentPage(currentPage)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
      setSessionActive(false)
    }
  }, [currentPage, injectCurrentPage])

  // When the page changes, render happens in PdfViewer; once the canvas is
  // ready it calls onCanvasReady, which triggers injection (so the JPEG for
  // scanned pages reflects the freshly-rendered page).
  const handleCanvasReady = useCallback(
    (canvas: HTMLCanvasElement) => {
      currentCanvasRef.current = canvas
      void injectCurrentPage(currentPage)
    },
    [currentPage, injectCurrentPage],
  )

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
  }, [])

  // ---------------------------------------------------------------------
  // Push to talk (only while the session is active)
  // ---------------------------------------------------------------------
  const onPTTStart = useCallback(() => {
    if (!liveRef.current) return
    setError(null)
    liveRef.current.startPushToTalk()
  }, [])

  const onPTTEnd = useCallback(() => {
    liveRef.current?.endPushToTalk()
  }, [])

  // PTT is disabled until the session is started (and during reconnects).
  const pttDisabled = !sessionActive || status === 'connecting'

  // Mic meter: sample input peak while listening, otherwise show 0.
  useEffect(() => {
    if (status !== 'listening') {
      setMicLevel(0)
      return
    }
    const id = window.setInterval(() => {
      setMicLevel(liveRef.current?.getMicLevel() ?? 0)
    }, 100)
    return () => window.clearInterval(id)
  }, [status])

  // Safety net: the button's own pointerup can go missing (capture lost,
  // pointer leaves the window, alert steals focus). A window-level release
  // ends the burst through the same idempotent path, so the mic can never
  // stream forever and thinking can never hang on a lost release.
  useEffect(() => {
    const end = () => {
      liveRef.current?.endPushToTalk()
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
    }
  }, [])
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (phase !== 'reading' || pttDisabled) return
      e.preventDefault()
      if (!e.repeat) onPTTStart()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (phase !== 'reading' || !sessionActive) return
      e.preventDefault()
      onPTTEnd()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [phase, pttDisabled, sessionActive, onPTTStart, onPTTEnd])

  // Resizable sidebar divider — drag to adjust width.
  // Must be before any early return to keep hook order stable.
  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX = 480
  const SIDEBAR_DEFAULT = 280

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (sidebarCollapsed) return
      isResizingRef.current = true
      resizeStartXRef.current = e.clientX
      resizeStartWidthRef.current = sidebarWidth
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    },
    [sidebarCollapsed, sidebarWidth],
  )

  const onResizePointerMove = useCallback((e: PointerEvent) => {
    if (!isResizingRef.current) return
    const dx = e.clientX - resizeStartXRef.current
    const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, resizeStartWidthRef.current + dx))
    setSidebarWidth(next)
  }, [])

  const onResizePointerUp = useCallback(() => {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onResizePointerMove)
    window.addEventListener('pointerup', onResizePointerUp)
    return () => {
      window.removeEventListener('pointermove', onResizePointerMove)
      window.removeEventListener('pointerup', onResizePointerUp)
    }
  }, [onResizePointerMove, onResizePointerUp])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      liveRef.current?.close()
      liveRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (phase === 'upload') {
    return (
      <UploadScreen
        uploading={uploading}
        error={error}
        onFile={handleFile}
      />
    )
  }

  // Inline grid template so width is dynamic. Resizer gets a fixed 6px column when open.
  const mainStyle: React.CSSProperties = sidebarCollapsed
    ? { gridTemplateColumns: `48px 1fr 380px` }
    : { gridTemplateColumns: `${sidebarWidth}px 6px 1fr 380px` }

  const mainClass = `app-main ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-open'}`

  return (
    <div className="app-shell">
      <main className={mainClass} style={mainStyle}>
        <Sidebar
          outline={outline}
          hasOutline={hasOutline}
          pdfData={pdfData}
          pageCount={pageCount}
          currentPage={currentPage}
          onPageChange={handlePageChange}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        />
        {!sidebarCollapsed && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize outline panel"
            title="Drag to resize — double-click to reset"
            onPointerDown={onResizePointerDown}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          />
        )}
        <section className="pdf-pane">
          {pdfData && (
            <PdfViewer
              data={pdfData}
              pageCount={pageCount}
              currentPage={currentPage}
              onPageChange={handlePageChange}
              onCanvasReady={handleCanvasReady}
            />
          )}
        </section>
        <section className="voice-pane">
          <VoicePanel
            status={status}
            transcript={transcript}
            sessionActive={sessionActive}
            pttDisabled={pttDisabled}
            micLevel={micLevel}
            onStartSession={startSession}
            onStopSession={stopSession}
            onRefreshSession={refreshSession}
            onPushToTalkStart={onPTTStart}
            onPushToTalkEnd={onPTTEnd}
          />
        </section>
      </main>
      {error && <div className="error-toast">{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------
// Upload screen
// ---------------------------------------------------------------------
function UploadScreen({
  uploading,
  error,
  onFile,
}: {
  uploading: boolean
  error: string | null
  onFile: (f: File) => void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const pick = (files: FileList | null) => {
    if (files && files[0]) onFile(files[0])
  }

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <h1>BookTalk</h1>
        <p className="upload-sub">Read a PDF with a voice assistant that always knows what page you're on.</p>
        <div
          className={`dropzone ${dragging ? 'drag' : ''} ${uploading ? 'busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            pick(e.dataTransfer.files)
          }}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => pick(e.target.files)}
          />
          {uploading ? (
            <div className="dropzone-busy">Loading PDF…</div>
          ) : (
            <div className="dropzone-idle">
              <div className="dropzone-icon">⌃</div>
              <div>Drag a PDF here, or click to browse</div>
            </div>
          )}
        </div>
        {error && <div className="upload-error">{error}</div>}
      </div>
    </div>
  )
}
