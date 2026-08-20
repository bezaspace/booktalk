/** Client-side PDF reader using pdfjs-dist.

Renders the current page to a canvas, supports prev/next + jump-to-page, and
notifies the parent on every page change so the context bridge can inject the
new page's content into the Live session.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
// Vite bundles the worker as an asset URL.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import type { PageResponse } from '../types'

// Configure the worker once.
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker

interface PdfViewerProps {
  /** Raw PDF bytes from the upload. */
  data: ArrayBuffer
  pageCount: number
  currentPage: number
  onPageChange: (page: number) => void
  /** Called when the rendered canvas for the current page is available.
   * Used by the context bridge to grab a JPEG for scanned/image pages. */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void
}

export function PdfViewer({
  data,
  pageCount,
  currentPage,
  onPageChange,
  onCanvasReady,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  const [scale, setScale] = useState(1.2)
  const [inverted, setInverted] = useState(false)
  const [jumpInput, setJumpInput] = useState(String(currentPage))
  // Flips true once the PDFDocumentProxy is available. The render effect
  // depends on this so it re-runs after the doc loads even when currentPage
  // hasn't changed (e.g. initial load where currentPage is already 1).
  const [docReady, setDocReady] = useState(false)

  // Load the PDF document once.
  useEffect(() => {
    let cancelled = false
    setDocReady(false)
    // Copy the ArrayBuffer — pdfjs transfers/detaches the underlying buffer,
    // which would corrupt the React-held reference on re-renders.
    const bytes = new Uint8Array(data.slice(0))
    const task = pdfjsLib.getDocument({ data: bytes })
    loadingTaskRef.current = task
    task.promise.then((doc) => {
      if (cancelled) {
        void task.destroy()
        return
      }
      pdfDocRef.current = doc
      setDocReady(true)
    })
    return () => {
      cancelled = true
      void loadingTaskRef.current?.destroy()
      loadingTaskRef.current = null
      pdfDocRef.current = null
      setDocReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Render the current page whenever the page, scale, or doc readiness changes.
  useEffect(() => {
    const doc = pdfDocRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || !docReady) return

    let active = true
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Cancel any in-flight render before starting a new one.
    renderTaskRef.current?.cancel()

    doc.getPage(currentPage)
      .then((page) => {
        if (!active) return
        const viewport = page.getViewport({ scale })
        // Render at native device resolution to avoid blur on HiDPI/fractional-
        // scaling displays. Ceiling the ratio fixes blur on non-Firefox
        // browsers with fractional ratios (e.g. 1.1, 1.15) — see pdf.js PR
        // #19374. CSS size stays at viewport dims; the bitmap is scaled up by
        // the browser at crisp device-pixel resolution.
        const outputScale = Math.ceil(window.devicePixelRatio || 1)
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        })
        renderTaskRef.current = task
        return task.promise
      })
      .then(() => {
        if (active && canvasRef.current) {
          onCanvasReady?.(canvasRef.current)
        }
      })
      .catch((err: unknown) => {
        // Rendering cancellation throws — ignore those.
        if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException') {
          return
        }
        console.error('PDF render error:', err)
      })

    return () => {
      active = false
    }
  }, [currentPage, scale, docReady, onCanvasReady])

  useEffect(() => {
    setJumpInput(String(currentPage))
  }, [currentPage])

  const goPrev = useCallback(() => onPageChange(Math.max(1, currentPage - 1)), [currentPage, onPageChange])
  const goNext = useCallback(() => onPageChange(Math.min(pageCount, currentPage + 1)), [currentPage, pageCount, onPageChange])

  const commitJump = useCallback(() => {
    const n = parseInt(jumpInput, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= pageCount) {
      onPageChange(n)
    } else {
      setJumpInput(String(currentPage))
    }
  }, [jumpInput, pageCount, currentPage, onPageChange])

  // -----------------------------------------------------------------
  // Keyboard: Left/Right arrows flip pages (ignored while typing).
  // -----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') goPrev()
      else goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext])

  // -----------------------------------------------------------------
  // Page scrubber: a vertical track whose thumb represents the current
  // page position. Click or drag anywhere on the track to jump.
  // -----------------------------------------------------------------
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const pageFromY = useCallback(
    (clientY: number) => {
      const track = trackRef.current
      if (!track) return null
      const rect = track.getBoundingClientRect()
      if (rect.height === 0) return null
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
      // Align the thumb center with the cursor: map ratio across the
      // (pageCount - 1) interval, then +1 to get a 1-based page number.
      const n = Math.round(ratio * (pageCount - 1)) + 1
      return Math.min(pageCount, Math.max(1, n))
    },
    [pageCount],
  )

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const n = pageFromY(e.clientY)
      if (!n) return
      onPageChange(n)
      draggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [pageFromY, onPageChange],
  )

  const onTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      const n = pageFromY(e.clientY)
      if (n) onPageChange(n)
    },
    [pageFromY, onPageChange],
  )

  const onTrackPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* no-op */
    }
  }, [])

  // Thumb covers a single page's worth of the track (min 18px so it stays grabbable).
  const thumbRatio = pageCount > 0 ? 1 / pageCount : 1
  const thumbTopPct = pageCount > 1 ? ((currentPage - 1) / (pageCount - 1)) * (1 - thumbRatio) * 100 : 0
  const thumbHeightPct = thumbRatio * 100

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button onClick={goPrev} disabled={currentPage <= 1} aria-label="Previous page">
          ‹
        </button>
        <span className="page-indicator">
          <input
            className="page-jump"
            value={jumpInput}
            inputMode="numeric"
            onChange={(e) => setJumpInput(e.target.value)}
            onBlur={commitJump}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitJump()
            }}
            aria-label="Jump to page"
          />
          <span className="page-count">/ {pageCount}</span>
        </span>
        <button onClick={goNext} disabled={currentPage >= pageCount} aria-label="Next page">
          ›
        </button>
        <span className="spacer" />
        <button className="zoom" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} aria-label="Zoom out">
          −
        </button>
        <button className="zoom" onClick={() => setScale((s) => Math.min(3, s + 0.2))} aria-label="Zoom in">
          +
        </button>
        <button
          className={`invert-toggle ${inverted ? 'active' : ''}`}
          onClick={() => setInverted((v) => !v)}
          aria-pressed={inverted}
          aria-label="Invert colors"
          title="Invert colors (dark mode)"
        >
          {inverted ? '◐' : '◑'}
        </button>
      </div>
      <div className="pdf-canvas-wrap">
        <canvas ref={canvasRef} className={inverted ? 'inverted' : ''} />
        {pageCount > 1 && (
          <div
            className="pdf-scrubber"
            ref={trackRef}
            role="slider"
            aria-label="Page scrubber"
            aria-valuemin={1}
            aria-valuemax={pageCount}
            aria-valuenow={currentPage}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
          >
            <div
              className="pdf-scrubber-thumb"
              style={{
                top: `${thumbTopPct}%`,
                height: `max(${thumbHeightPct}%, 18px)`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** Helper exported for the context bridge: turn a canvas into a JPEG blob. */
export async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.7): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      quality,
    )
  })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Re-export for type-only use by callers. */
export type { PageResponse }
