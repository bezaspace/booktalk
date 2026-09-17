/** Right panel: session controls, push-to-talk button, status, transcript. */

import { useEffect, useRef } from 'react'
import type { TranscriptEntry, VoiceStatus } from '../types'

interface VoicePanelProps {
  status: VoiceStatus
  transcript: TranscriptEntry[]
  /** Whether the Gemini Live session is currently active (connected). */
  sessionActive: boolean
  /** PTT disabled when session not active or otherwise unavailable. */
  pttDisabled: boolean
  /** Live mic input peak 0..1, sampled while listening. */
  micLevel: number
  onStartSession: () => void
  onStopSession: () => void
  onRefreshSession: () => void
  onPushToTalkStart: () => void
  onPushToTalkEnd: () => void
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Ready',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Error',
}

const STATUS_COLOR: Record<VoiceStatus, string> = {
  idle: 'var(--dot-idle)',
  connecting: 'var(--dot-thinking)',
  connected: 'var(--dot-ready)',
  listening: 'var(--dot-listening)',
  thinking: 'var(--dot-thinking)',
  speaking: 'var(--dot-speaking)',
  error: 'var(--dot-error)',
}

export function VoicePanel({
  status,
  transcript,
  sessionActive,
  pttDisabled,
  micLevel,
  onStartSession,
  onStopSession,
  onRefreshSession,
  onPushToTalkStart,
  onPushToTalkEnd,
}: VoicePanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to bottom on new transcript content.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript])

  // Hold-to-talk via pointer events. Keyboard (Space) is handled at App level.
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    if (pttDisabled) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    onPushToTalkStart()
  }
  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault()
    if (pttDisabled) return
    onPushToTalkEnd()
  }

  const listening = status === 'listening'
  const connecting = status === 'connecting'

  return (
    <div className="voice-panel">
      <div className="voice-header">
        <span
          className={`status-dot ${status}`}
          style={{ background: STATUS_COLOR[status] }}
          aria-hidden
        />
        <span className="status-label">{STATUS_LABEL[status]}</span>
        <span className="header-spacer" />
        <button
          className="session-reset"
          onClick={onRefreshSession}
          aria-label="Refresh Gemini session"
          title="Refresh Gemini session (fresh context)"
        >
          ↻
        </button>
        <button
          className={`session-toggle ${sessionActive ? 'stop' : 'start'}`}
          onClick={sessionActive ? onStopSession : onStartSession}
          disabled={connecting}
          aria-label={sessionActive ? 'Stop session' : 'Start session'}
        >
          {connecting ? '…' : sessionActive ? 'Stop' : 'Start'}
        </button>
      </div>

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && (
          <div className="transcript-empty">
            {sessionActive
              ? 'Hold the button below to ask about the page you\u2019re reading.'
              : 'Press Start to connect the voice assistant, then hold the button to talk.'}
          </div>
        )}
        {transcript.map((entry) => (
          <div key={entry.id} className={`transcript-entry ${entry.role}`}>
            <div className="transcript-role">{entry.role === 'user' ? 'You' : 'BookTalk'}</div>
            <div className="transcript-text">{entry.text || '…'}</div>
          </div>
        ))}
      </div>

      <div className="ptt-wrap">
        <button
          className={`ptt-button ${listening ? 'active' : ''}`}
          disabled={pttDisabled}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
          aria-label="Hold to talk"
        >
          <span className="ptt-icon">{listening ? '●' : '◉'}</span>
          <span className="ptt-label">
            {listening ? 'Listening — release to send' : 'Hold to talk'}
          </span>
        </button>
        <div className="ptt-hint">
          {sessionActive
            ? 'Hold and speak. Release when done. Pressing again interrupts the assistant.'
            : 'Start the session to enable the microphone.'}
        </div>
        {listening && (
          <div
            className="mic-meter"
            role="progressbar"
            aria-label="Microphone input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(micLevel * 100)}
            title="Microphone input level — bars mean your voice is reaching the app"
            style={{
              height: 6,
              borderRadius: 3,
              background: 'var(--track, rgba(255,255,255,0.12))',
              marginTop: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.round(micLevel * 100)}%`,
                borderRadius: 3,
                background: micLevel > 0.02 ? 'var(--dot-listening)' : 'transparent',
                transition: 'width 90ms linear',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
