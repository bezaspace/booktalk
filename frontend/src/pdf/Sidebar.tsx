/** Left sidebar: Table of Contents + Thumbnail strip. */

import { useEffect, useRef, useState, useMemo } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { OutlineItem } from '../types'

// Ensure worker is configured even if PdfViewer hasn't mounted yet.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker
}

type Tab = 'outline' | 'thumbnails'

interface SidebarProps {
  /** Outline items from GET /outline (empty if no TOC). */
  outline: OutlineItem[]
  hasOutline: boolean
  /** Raw PDF bytes — needed to render thumbnails client-side. */
  pdfData: ArrayBuffer | null
  pageCount: number
  currentPage: number
  onPageChange: (page: number) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

// ---------------------------------------------------------------------------
// Small helper: highlight outline entry that contains currentPage
// ---------------------------------------------------------------------------
function activeOutlineIndex(outline: OutlineItem[], currentPage: number): number {
  // Pick the last entry whose page <= currentPage.
  let idx = -1
  for (let i = 0; i < outline.length; i++) {
    if (outline[i]!.page <= currentPage) idx = i
    else if (outline[i]!.page > currentPage) break
  }
  // If TOC pages are not sorted, fallback to exact match.
  if (idx === -1) {
    for (let i = 0; i < outline.length; i++) if (outline[i]!.page === currentPage) return i
  }
  return idx
}

// ---------------------------------------------------------------------------
// Thumbnail item — renders one page at low scale to a canvas
// ---------------------------------------------------------------------------
function ThumbnailItem({
  pdfDoc,
  pageNum,
  isActive,
  onClick,
}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null
  pageNum: number
  isActive: boolean
  onClick: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return
    let cancelled = false
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    pdfDoc
      .getPage(pageNum)
      .then((page) => {
        if (cancelled) return
        const viewport = page.getViewport({ scale: 0.22 })
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        return page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        }).promise
      })
      .then(() => {
        if (!cancelled) setLoaded(true)
      })
      .catch((err: unknown) => {
        if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException') return
        console.warn('Thumbnail render failed for page', pageNum, err)
      })

    return () => {
      cancelled = true
    }
  }, [pdfDoc, pageNum])

  return (
    <button
      className={`thumb-item ${isActive ? 'active' : ''} ${loaded ? 'loaded' : ''}`}
      onClick={onClick}
      aria-label={`Go to page ${pageNum}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <canvas ref={canvasRef} />
      <span className="thumb-label">{pageNum}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main Sidebar
// ---------------------------------------------------------------------------
export function Sidebar({
  outline,
  hasOutline,
  pdfData,
  pageCount,
  currentPage,
  onPageChange,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const [tab, setTab] = useState<Tab>(hasOutline ? 'outline' : 'thumbnails')
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)

  // Keep tab in sync if outline availability changes (e.g. after first load).
  useEffect(() => {
    if (hasOutline && outline.length > 0) setTab('outline')
    else if (!hasOutline) setTab('thumbnails')
  }, [hasOutline, outline.length])

  // Load pdf.js doc for thumbnails when needed.
  useEffect(() => {
    if (tab !== 'thumbnails' || !pdfData) return
    if (pdfDoc) return // already loaded
    let cancelled = false
    const bytes = new Uint8Array(pdfData.slice(0))
    const task = pdfjsLib.getDocument({ data: bytes })
    task.promise.then((doc) => {
      if (cancelled) {
        void task.destroy()
        return
      }
      setPdfDoc(doc)
    })
    return () => {
      cancelled = true
      void task.destroy()
    }
    // pdfData identity changes on each upload — reload doc then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pdfData])

  // When pdfData changes (new PDF), reset doc so thumbnails re-render.
  useEffect(() => {
    setPdfDoc(null)
  }, [pdfData])

  const activeIdx = useMemo(() => activeOutlineIndex(outline, currentPage), [outline, currentPage])

  if (collapsed) {
    return (
      <aside className="sidebar collapsed" aria-label="Navigation sidebar collapsed">
        <button className="sidebar-expand" onClick={onToggleCollapsed} aria-label="Expand sidebar" title="Show outline & thumbnails">
          ☰
        </button>
        <div className="sidebar-collapsed-pages">
          {Array.from({ length: Math.min(pageCount, 6) }, (_, i) => (
            <div key={i} className={`collapsed-dot ${i + 1 === currentPage ? 'active' : ''}`} />
          ))}
          {pageCount > 6 && <span className="collapsed-more">+{pageCount - 6}</span>}
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar" aria-label="PDF navigation sidebar">
      <div className="sidebar-header">
        <div className="sidebar-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'outline'}
            className={`sidebar-tab ${tab === 'outline' ? 'active' : ''}`}
            onClick={() => setTab('outline')}
            disabled={!hasOutline}
            title={!hasOutline ? 'No table of contents in this PDF' : undefined}
          >
            Outline
          </button>
          <button
            role="tab"
            aria-selected={tab === 'thumbnails'}
            className={`sidebar-tab ${tab === 'thumbnails' ? 'active' : ''}`}
            onClick={() => setTab('thumbnails')}
          >
            Pages
          </button>
        </div>
        <button className="sidebar-collapse" onClick={onToggleCollapsed} aria-label="Collapse sidebar" title="Collapse sidebar">
          ‹
        </button>
      </div>

      <div className="sidebar-body">
        {tab === 'outline' ? (
          hasOutline && outline.length > 0 ? (
            <nav className="outline-list" aria-label="Table of contents">
              {outline.map((item, idx) => (
                <button
                  key={`${item.page}-${item.title}-${idx}`}
                  className={`outline-item level-${Math.min(item.level, 4)} ${idx === activeIdx ? 'active' : ''} ${item.page === currentPage ? 'exact' : ''}`}
                  style={{ paddingLeft: `${8 + (Math.min(item.level, 4) - 1) * 14}px` }}
                  onClick={() => onPageChange(item.page)}
                  title={`Go to page ${item.page}: ${item.title}`}
                >
                  <span className="outline-title">{item.title}</span>
                  <span className="outline-page">{item.page}</span>
                </button>
              ))}
            </nav>
          ) : (
            <div className="sidebar-empty">
              <p>No table of contents found in this PDF.</p>
              <button className="sidebar-empty-cta" onClick={() => setTab('thumbnails')}>
                Browse pages →
              </button>
            </div>
          )
        ) : (
          <div className="thumb-grid" role="list" aria-label="Page thumbnails">
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
              <ThumbnailItem key={p} pdfDoc={pdfDoc} pageNum={p} isActive={p === currentPage} onClick={() => onPageChange(p)} />
            ))}
            {!pdfDoc && <div className="thumb-loading">Loading previews…</div>}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-footer-info">
          {pageCount} pages{hasOutline ? ` · ${outline.length} sections` : ''}
        </span>
      </div>
    </aside>
  )
}
