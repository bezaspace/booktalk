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
        canvas.width = viewport.width
        canvas.height = viewport.height
        const task = page.render({ canvas, canvasContext: ctx, viewport })
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
      </div>
      <div className="pdf-canvas-wrap">
        <canvas ref={canvasRef} />
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
