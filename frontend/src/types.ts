/** Shared types for the BookTalk frontend. */

export interface UploadResponse {
  session_id: string
  page_count: number
}

export interface PageResponse {
  page: number
  page_count: number
  text: string
  is_scanned: boolean
}

export interface TokenResponse {
  token: string
  model: string
  expires_at: string
}

/** Connection state surfaced to the UI. */
export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking' | 'error'

/** A single line in the transcript panel. */
export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Partial transcript still being filled in. */
  partial?: boolean
}
