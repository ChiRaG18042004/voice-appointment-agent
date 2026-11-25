// Everything about one voice call: connect over WebRTC, collect the transcript,
// expose audio tracks for the waveform, and the ring/end sounds.

import { PipecatClient, type BotOutputData, type UserInputData } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'
import { useCallback, useEffect, useRef, useState } from 'react'
import { playHangup, startRingback } from './sounds'

export type CallStatus = 'idle' | 'ringing' | 'connected' | 'ended' | 'error'

/** A bot sentence, with how much of it has been spoken so far. */
type Segment = { id: number; text: string; spoken: string }
export type Turn =
  | { role: 'user'; text: string; interim: string; at: number }
  | { role: 'bot'; segments: Segment[]; at: number }

const TOOL_LABELS: Record<string, string> = {
  check_doctor_availability: 'Checking the diary',
  book_appointment: 'Booking',
  cancel_appointment: 'Cancelling',
  end_call: 'Hanging up',
}

const MIN_RING_MS = 1600 // let it ring at least once, like a real line

export function useCall() {
  const [status, setStatus] = useState<CallStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [muted, setMuted] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [activity, setActivity] = useState<string | null>(null)
  const [botTrack, setBotTrack] = useState<MediaStreamTrack | null>(null)
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null)
  /** Response time for each reply: caller stops talking -> Mira starts talking, in ms. */
  const [latencies, setLatencies] = useState<number[]>([])
  const userStoppedAt = useRef<number | null>(null)

  const client = useRef<PipecatClient | null>(null)
  const audioEl = useRef<HTMLAudioElement | null>(null)
  const stopRing = useRef<(() => void) | null>(null)
  const statusRef = useRef<CallStatus>('idle')
  statusRef.current = status

  const silenceRing = () => {
    stopRing.current?.()
    stopRing.current = null
  }

  const finish = useCallback((why: 'ended' | 'error') => {
    silenceRing()
    if (statusRef.current === 'connected') playHangup()
    setEndedAt(Date.now())
    setActivity(null)
    setStatus(why)
    setBotTrack(null)
    setMicTrack(null)
    client.current = null
  }, [])

  // ---- transcript reducers

  const onUserInput = (d: UserInputData) => {
    if (d.input_type && d.input_type !== 'transcription') return
    setTurns((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      const turn = last?.role === 'user' ? { ...last } : { role: 'user' as const, text: '', interim: '', at: Date.now() }
      if (d.final) {
        turn.text = (turn.text + ' ' + d.text).trim()
        turn.interim = ''
      } else {
        turn.interim = d.text
      }
      if (last?.role === 'user') next[next.length - 1] = turn
      else next.push(turn)
      return next
    })
  }

  const onBotOutput = (d: BotOutputData) => {
    const type = d.output_type ?? d.aggregated_by
    if (type && type !== 'sentence') return
    if (d.will_be_spoken === false) return
    const id = d.segment_id ?? Math.random()
    const progress = d.spoken_progress
    setTurns((prev) => {
      const next = [...prev]
      let last = next[next.length - 1]
      if (last?.role !== 'bot') {
        last = { role: 'bot', segments: [], at: Date.now() }
        next.push(last)
      } else {
        last = { ...last, segments: [...last.segments] }
        next[next.length - 1] = last
      }
      const i = last.segments.findIndex((s) => s.id === id)
      const spoken =
        d.spoken_status === 'completed' ? (progress?.accumulated_text ?? d.text) : (progress?.accumulated_text ?? '')
      if (i === -1) {
        const text = d.spoken_status === 'new' ? d.text : (progress ? progress.accumulated_text + progress.remaining_text : d.text)
        last.segments.push({ id, text: text || d.text, spoken })
      } else {
        last.segments[i] = { ...last.segments[i], spoken: spoken || last.segments[i].spoken }
      }
      return next
    })
  }

  // When the caller barges in, drop whatever Mira never got to say.
  const onBotInterrupted = () =>
    setTurns((prev) =>
      prev.map((t) =>
        t.role === 'bot' ? { ...t, segments: t.segments.filter((s) => s.spoken).map((s) => ({ ...s, text: s.spoken })) } : t,
      ),
    )

  // ---- controls

  const start = useCallback(async () => {
    if (client.current) return
    setTurns([])
    setError(null)
    setMuted(false)
    setStartedAt(null)
    setEndedAt(null)
    setActivity(null)
    setLatencies([])
    userStoppedAt.current = null
    setStatus('ringing')
    stopRing.current = startRingback()
    const ringUntil = Date.now() + MIN_RING_MS

    const pc = new PipecatClient({
      transport: new SmallWebRTCTransport({ webrtcRequestParams: { endpoint: '/api/offer' } }),
      enableMic: true,
      enableCam: false,
      callbacks: {
        onBotReady: () => {
          const pickUp = () => {
            if (client.current !== pc) return
            silenceRing()
            setStartedAt(Date.now())
            setStatus('connected')
          }
          setTimeout(pickUp, Math.max(0, ringUntil - Date.now()))
        },
        onTrackStarted: (track, participant) => {
          if (track.kind !== 'audio') return
          if (participant?.local) {
            setMicTrack(track)
          } else {
            setBotTrack(track)
            if (audioEl.current) {
              audioEl.current.srcObject = new MediaStream([track])
              void audioEl.current.play().catch(() => {})
            }
          }
        },
        onUserInput,
        onBotOutput,
        onBotInterrupted,
        onUserStartedSpeaking: () => (userStoppedAt.current = null),
        onUserStoppedSpeaking: () => (userStoppedAt.current = performance.now()),
        onBotStartedSpeaking: () => {
          const t = userStoppedAt.current
          userStoppedAt.current = null
          if (t !== null) setLatencies((l) => [...l, performance.now() - t])
        },
        onLLMFunctionCallStarted: (d) => setActivity(TOOL_LABELS[d.function_name ?? ''] ?? 'Working'),
        onLLMFunctionCallStopped: () => setActivity(null),
        onDisconnected: () => {
          if (client.current === pc) finish('ended')
        },
        onError: (m) => {
          const data = m.data as { message?: string; error?: string } | undefined
          setError(data?.message ?? data?.error ?? 'The call dropped.')
        },
      },
    })
    client.current = pc

    try {
      await pc.connect()
    } catch (e) {
      if (client.current !== pc) return
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        /permission|denied|NotAllowed/i.test(msg)
          ? 'Microphone access is blocked. Allow it in the address bar and try again.'
          : 'Could not reach the voice server. Is backend/server.py running?',
      )
      finish('error')
      void pc.disconnect().catch(() => {})
    }
  }, [finish])

  const hangUp = useCallback(async () => {
    const pc = client.current
    if (!pc) return
    finish('ended')
    await pc.disconnect().catch(() => {})
  }, [finish])

  const toggleMute = useCallback(() => {
    const pc = client.current
    if (!pc) return
    const next = !muted
    pc.enableMic(!next)
    setMuted(next)
  }, [muted])

  const reset = useCallback(() => setStatus('idle'), [])

  useEffect(() => () => void client.current?.disconnect(), [])

  return {
    status, error, turns, muted, startedAt, endedAt, activity, botTrack, micTrack, latencies,
    start, hangUp, toggleMute, reset, audioEl,
  }
}

export type CallState = ReturnType<typeof useCall>
