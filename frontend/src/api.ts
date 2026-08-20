/** Thin client for the BookTalk backend. All calls go through /api (proxied). */

import type { OutlineResponse, PageResponse, TokenResponse, UploadResponse } from './types'

const BASE = '/api'

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${input}`, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  return jsonFetch<UploadResponse>('/upload', { method: 'POST', body: form })
}

export function fetchPage(sessionId: string, page: number): Promise<PageResponse> {
  const qs = new URLSearchParams({ session: sessionId, page: String(page) })
  return jsonFetch<PageResponse>(`/page?${qs.toString()}`)
}

export function fetchToken(): Promise<TokenResponse> {
  return jsonFetch<TokenResponse>('/token')
}

export function fetchOutline(sessionId: string): Promise<OutlineResponse> {
  const qs = new URLSearchParams({ session: sessionId })
  return jsonFetch<OutlineResponse>(`/outline?${qs.toString()}`)
}
