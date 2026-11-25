import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Appointment, Doctor, ServerEvent } from './api'
import { fmtTime, timeKey } from './api'
import { dayKey, fetchAppointments, fetchDoctors, resetDemo, subscribe } from './api'
import { Board } from './Board'
import { Ledger } from './Ledger'
import { Phone, type CallEvent } from './Phone'
import { playConfirm } from './sounds'
import { useCall } from './useCall'

type Flash = Map<string, 'booked' | 'freed'>
export type Scan = { doctorIds: Set<string>; slotIds: Set<string> }
const FLASH_MS = 4500
const SCAN_MS = 15000

const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`)

export default function App() {
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [appts, setAppts] = useState<Appointment[]>([])
  const [day, setDay] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash>(new Map())
  const [callEvents, setCallEvents] = useState<CallEvent[]>([])
  const [scan, setScan] = useState<Scan | null>(null)
  const [caption, setCaption] = useState<string | null>(null)
  const scanTimer = useRef(0)
  const captionTimer = useRef(0)
  const [loadError, setLoadError] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const call = useCall()

  const refresh = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([fetchDoctors(), fetchAppointments()])
      setDoctors(d)
      setAppts(a)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  const pulse = useCallback((ids: string[], kind: 'booked' | 'freed') => {
    setFlash((m) => {
      const n = new Map(m)
      ids.forEach((id) => n.set(id, kind))
      return n
    })
    setTimeout(
      () =>
        setFlash((m) => {
          const n = new Map(m)
          ids.forEach((id) => n.delete(id))
          return n
        }),
      FLASH_MS,
    )
  }, [])

  /** One line on the board narrating what Mira is doing; null hides it. */
  const narrate = useCallback((text: string | null, ms = 0) => {
    clearTimeout(captionTimer.current)
    setCaption(text)
    if (ms) captionTimer.current = window.setTimeout(() => setCaption(null), ms)
  }, [])

  const clearScan = useCallback(() => {
    clearTimeout(scanTimer.current)
    setScan(null)
  }, [])

  useEffect(() => {
    void refresh()
    return subscribe((e: ServerEvent) => {
      if (e.type === 'scan') {
        const starts = Object.values(e.data.slots).sort()
        const target = e.data.date ?? (starts[0] ? dayKey(starts[0]) : null)
        if (target) setDay(target)
        clearTimeout(scanTimer.current)
        setScan({ doctorIds: new Set(e.data.doctor_ids), slotIds: new Set(Object.keys(e.data.slots)) })
        scanTimer.current = window.setTimeout(() => setScan(null), SCAN_MS)
        const who = e.data.doctors.length === 1 ? `${possessive(e.data.doctors[0])} diary` : `${e.data.doctors.length} diaries`
        narrate(starts.length ? `Mira is reading ${who}` : `Nothing open in ${who}`, SCAN_MS)
      } else if (e.type === 'tool' && e.data.name === 'book_appointment') {
        narrate('Mira is booking', 8000)
      } else if (e.type === 'appointment_booked' || e.type === 'appointment_cancelled') {
        const booked = e.type === 'appointment_booked'
        const d = e.data
        clearScan()
        setDay(dayKey(d.starts_at)) // jump the board to where the change happened
        pulse([d.slot_id, d.appointment_id], booked ? 'booked' : 'freed')
        setCallEvents((list) => [...list, { kind: booked ? 'booked' : 'cancelled', data: d, at: Date.now() }])
        const at = fmtTime(timeKey(d.starts_at))
        narrate(
          booked ? `${d.patient_name} booked with ${d.doctor} at ${at}` : `${possessive(d.patient_name)} ${at} visit cancelled`,
          7000,
        )
        if (booked) playConfirm()
        void refresh()
      } else if (e.type === 'reset') {
        clearScan()
        narrate(null)
        void refresh()
      }
    })
  }, [refresh, pulse, narrate, clearScan])

  // The board stops highlighting once the call is over.
  useEffect(() => {
    if (call.status === 'ended' || call.status === 'error') {
      clearScan()
      if (!caption?.includes('booked') && !caption?.includes('cancelled')) narrate(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.status])

  const days = useMemo(() => {
    const s = new Set<string>()
    doctors.forEach((d) => d.slots.forEach((x) => s.add(dayKey(x.starts_at))))
    return [...s].sort()
  }, [doctors])
  const activeDay = day && days.includes(day) ? day : days[0]

  const voiceSlots = useMemo(
    () => new Set(appts.filter((a) => a.status === 'booked' && a.source === 'voice').map((a) => a.slot_id)),
    [appts],
  )
  // slot id -> patient, so booked cells can carry initials
  const patients = useMemo(
    () => new Map(appts.filter((a) => a.status === 'booked').map((a) => [a.slot_id, a.patient_name])),
    [appts],
  )

  const openPhone = () => {
    setCallEvents([])
    setPhoneOpen(true)
    void call.start()
  }
  const closePhone = () => {
    setPhoneOpen(false)
    call.reset()
  }

  // Esc closes the phone once the call is over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phoneOpen && (call.status === 'ended' || call.status === 'error')) closePhone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onCall = call.status === 'ringing' || call.status === 'connected'

  return (
    <div className={`app ${phoneOpen ? 'has-phone' : ''}`}>
      <audio ref={call.audioEl} autoPlay />
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <g fill="var(--larkspur)">
              <circle cx="16" cy="8.5" r="3.4" /><circle cx="11" cy="14.5" r="3.2" /><circle cx="21" cy="14.5" r="3.2" />
              <circle cx="16" cy="20.5" r="3" />
            </g>
            <rect x="15.2" y="22" width="1.6" height="7" rx=".8" fill="var(--ink)" />
          </svg>
          <div>
            <p className="brand-name">Larkspur Clinic</p>
            <p className="brand-sub">Front desk</p>
          </div>
        </div>

        <div className="topbar-right">
          <p className={`line-state ${onCall ? 'is-live' : ''}`} aria-live="polite">
            <span className="led" aria-hidden="true" />
            {call.status === 'connected' ? 'Mira is on a call' : call.status === 'ringing' ? 'Ringing' : 'Mira is free'}
          </p>
          <button className="btn-quiet" onClick={() => void resetDemo()} disabled={onCall}>
            Reset demo data
          </button>
          <button className="btn-call" onClick={openPhone} disabled={onCall}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" />
            </svg>
            Try a call
          </button>
        </div>
      </header>

      <main>
        {loadError && (
          <p className="banner">
            Can't reach the clinic server on port 7860. Start it with <code>python backend/server.py</code>, then reload.
          </p>
        )}
        {activeDay && (
          <Board
            doctors={doctors}
            day={activeDay}
            days={days}
            onDay={setDay}
            voiceSlots={voiceSlots}
            patients={patients}
            flash={flash}
            scan={scan}
            caption={caption}
          />
        )}
        <Ledger items={appts} flash={flash} />
      </main>

      {phoneOpen && <Phone call={call} events={callEvents} onClose={closePhone} />}
    </div>
  )
}
