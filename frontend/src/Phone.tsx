import { useEffect, useRef, useState } from 'react'
import type { BookingEvent } from './api'
import { fmtPhone } from './api'
import type { CallState, Turn } from './useCall'
import { Waveform } from './Waveform'

export type CallEvent = { kind: 'booked' | 'cancelled'; data: BookingEvent; at: number }

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [on])
  return now
}

const Mic = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    {off && <path d="M4 4l16 16" />}
  </svg>
)
const Handset = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
    <path d="M3.6 14.6c4.6-4.4 12.2-4.4 16.8 0 .6.6.6 1.5 0 2.1l-1.6 1.5c-.5.5-1.3.5-1.8.1l-2.1-1.6c-.4-.3-.6-.8-.5-1.3l.3-1.6a10 10 0 0 0-5.4 0l.3 1.6c.1.5-.1 1-.5 1.3l-2.1 1.6c-.5.4-1.3.4-1.8-.1l-1.6-1.5c-.6-.6-.6-1.5 0-2.1z" />
  </svg>
)
const Flower = () => (
  <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="16" cy="8.5" r="3.4" /><circle cx="11" cy="14.5" r="3.2" /><circle cx="21" cy="14.5" r="3.2" />
      <circle cx="16" cy="20.5" r="3" />
    </g>
    <rect x="15.2" y="22" width="1.6" height="7" rx=".8" fill="currentColor" />
  </svg>
)

function secs(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function Ticket({ e }: { e: CallEvent }) {
  return (
    <div className={`ticket ticket-${e.kind}`}>
      <div className="ticket-head">
        <span>{e.kind === 'booked' ? 'Appointment booked' : 'Appointment cancelled'}</span>
        <span className="ticket-id">{e.data.appointment_id}</span>
      </div>
      <p className="ticket-doc">{e.data.doctor}</p>
      <p className="ticket-when">{e.data.when}</p>
      <p className="ticket-who">
        {e.data.patient_name}
        {e.data.phone && <span>{fmtPhone(e.data.phone)}</span>}
      </p>
    </div>
  )
}

type Item =
  | { kind: 'turn'; t: Turn; at: number; latency?: number }
  | { kind: 'event'; e: CallEvent; at: number }

export function Phone({ call, events, onClose }: { call: CallState; events: CallEvent[]; onClose: () => void }) {
  const { status, turns, muted, startedAt, endedAt, activity } = call
  const now = useNow(status === 'connected')
  const scroller = useRef<HTMLDivElement>(null)
  const live = status === 'ringing' || status === 'connected'

  // Merge speech and bookings into one timeline; each reply that follows the
  // caller gets the next measured response time.
  const timeline: Item[] = []
  let k = 0
  turns.forEach((t, i) => {
    const answersCaller = t.role === 'bot' && turns[i - 1]?.role === 'user'
    timeline.push({ kind: 'turn', t, at: t.at, latency: answersCaller ? call.latencies[k++] : undefined })
  })
  events.forEach((e) => timeline.push({ kind: 'event', e, at: e.at }))
  timeline.sort((a, b) => a.at - b.at)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns, activity, events, status])

  const subtitle =
    status === 'ringing' ? 'Calling…'
      : status === 'connected' ? clock(now - (startedAt ?? now))
      : status === 'error' ? 'Call failed'
      : `Call ended${startedAt && endedAt ? `, ${clock(endedAt - startedAt)}` : ''}`

  const wallClock = new Date(now).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: false })

  return (
    <div className="phone-layer" role="dialog" aria-label="Call with Larkspur Clinic">
      <div className={`phone is-${status}`}>
        <div className="phone-notch" />
        <div className="phone-screen">
          <div className="statusbar" aria-hidden="true">
            <span>{wallClock}</span>
            <span className="statusbar-icons">
              <svg width="17" height="11" viewBox="0 0 17 11"><g fill="currentColor"><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></g></svg>
              <svg width="24" height="11" viewBox="0 0 24 11"><rect x=".5" y=".5" width="20" height="10" rx="3" fill="none" stroke="currentColor" opacity=".5" /><rect x="2" y="2" width="14" height="7" rx="1.6" fill="currentColor" /><rect x="21.5" y="3.5" width="1.6" height="4" rx=".8" fill="currentColor" opacity=".5" /></svg>
            </span>
          </div>

          <header className="caller">
            <div className={`avatar ${status === 'ringing' ? 'is-ringing' : ''}`}><Flower /></div>
            <h2>Larkspur Clinic</h2>
            <p className="caller-sub" aria-live="polite">{subtitle}</p>
          </header>

          <Waveform bot={call.botTrack} mic={muted ? null : call.micTrack} active={status === 'connected'} />

          <div className="transcript" ref={scroller} aria-live="polite">
            {status === 'ringing' && <p className="transcript-hint">Mira, the clinic's AI receptionist, will pick up.</p>}
            {timeline.map((item) => {
              if (item.kind === 'event') return <Ticket key={`e${item.e.at}`} e={item.e} />
              const t = item.t
              if (t.role === 'user')
                return (
                  <p key={`u${t.at}`} className="line line-you">
                    {t.text}
                    {t.interim && <span className="interim"> {t.interim}</span>}
                  </p>
                )
              return (
                <div key={`b${t.at}`} className="line-wrap">
                  <p className="line line-bot">
                    {t.segments.map((s) => (
                      <span key={s.id}>
                        <span className="said">{s.spoken}</span>
                        <span className="unsaid">{s.text.slice(s.spoken.length)}</span>{' '}
                      </span>
                    ))}
                  </p>
                  {item.latency !== undefined && (
                    <span className="lat" title="From when you stopped talking to when Mira started">
                      {secs(item.latency)}
                    </span>
                  )}
                </div>
              )
            })}
            {activity && (
              <p className="activity">
                <span className="dots" aria-hidden="true"><i /><i /><i /></span>
                {activity}
              </p>
            )}
            {status === 'ended' && startedAt && endedAt && (
              <dl className="summary">
                <div><dt>Length</dt><dd>{clock(endedAt - startedAt)}</dd></div>
                <div>
                  <dt>Replies</dt>
                  <dd>{call.latencies.length ? `${secs(median(call.latencies))} median` : 'None'}</dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>
                    {events.length
                      ? events.map((e) => (
                          <span key={e.at}>{e.kind === 'booked' ? 'Booked' : 'Cancelled'} {e.data.doctor}</span>
                        ))
                      : 'No changes'}
                  </dd>
                </div>
              </dl>
            )}
            {status === 'error' && call.error && <p className="call-error">{call.error}</p>}
          </div>

          <footer className="controls">
            {live ? (
              <>
                <button
                  className={`ctl ${muted ? 'is-on' : ''}`}
                  onClick={call.toggleMute}
                  disabled={status !== 'connected'}
                  aria-pressed={muted}
                >
                  <Mic off={muted} />
                  <span>{muted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button className="ctl ctl-end" onClick={call.hangUp}>
                  <Handset />
                  <span>End</span>
                </button>
              </>
            ) : (
              <>
                <button className="ctl" onClick={onClose}>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  <span>Close</span>
                </button>
                <button className="ctl ctl-call" onClick={call.start}>
                  <Handset />
                  <span>Call again</span>
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </div>
  )
}
