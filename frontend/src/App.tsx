/** BookTalk — read a PDF alongside a real-time voice assistant. */

import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

import { fetchPage, fetchToken, uploadPdf } from './api'
import { PdfViewer, canvasToJpegBytes } from './pdf/PdfViewer'
import { VoicePanel } from './voice/VoicePanel'
import { LiveSession } from './voice/LiveSession'
import type { TranscriptEntry, VoiceStatus } from './types'

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

  // Voice state
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [sessionActive, setSessionActive] = useState(false)

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

  // Spacebar = push to talk (when not typing in an input and session active).
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">BookTalk</div>
        <div className="header-status">
          <span className={`status-dot ${status}`} aria-hidden />
          <span>{status}</span>
        </div>
      </header>
      <main className="app-main">
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
            onStartSession={startSession}
            onStopSession={stopSession}
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
