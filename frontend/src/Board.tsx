import { useMemo } from 'react'
import type { Scan } from './App'
import type { Doctor } from './api'
import { dayKey, fmtDay, fmtTime, isToday, timeKey } from './api'

type Props = {
  doctors: Doctor[]
  day: string
  days: string[]
  onDay: (d: string) => void
  voiceSlots: Set<string>
  patients: Map<string, string>
  flash: Map<string, 'booked' | 'freed'>
  scan: Scan | null
  caption: string | null
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')

/** Doctors down the side, the day's slots across: the clinic's diary at a glance. */
export function Board({ doctors, day, days, onDay, voiceSlots, patients, flash, scan, caption }: Props) {
  const { morning, evening } = useMemo(() => {
    const times = new Set<string>()
    doctors.forEach((d) => d.slots.forEach((s) => times.add(timeKey(s.starts_at))))
    // include the whole schedule even if today's early slots have passed
    ;['10:00', '10:30', '11:00', '11:30', '12:00', '16:00', '16:30', '17:00', '17:30', '18:00'].forEach((t) => times.add(t))
    const all = [...times].sort()
    return { morning: all.filter((t) => t < '14:00'), evening: all.filter((t) => t >= '14:00') }
  }, [doctors])

  const openByDay = useMemo(() => {
    const m = new Map<string, number>()
    doctors.forEach((d) => d.slots.forEach((s) => !s.is_booked && m.set(dayKey(s.starts_at), (m.get(dayKey(s.starts_at)) ?? 0) + 1)))
    return m
  }, [doctors])

  const cols = [...morning, null, ...evening]

  return (
    <section className="board" aria-labelledby="board-title">
      <div className="board-top">
        <div>
          <h1 id="board-title">{isToday(day) ? 'Today' : fmtDay(day, 'long')}</h1>
          <p className={`narration ${caption ? 'is-on' : ''}`} aria-live="polite">
            {caption && (
              <>
                <span className="narration-dot" aria-hidden="true" />
                {caption}
              </>
            )}
          </p>
        </div>
        <div className="days" role="tablist" aria-label="Choose a day">
          {days.map((d) => (
            <button
              key={d}
              role="tab"
              aria-selected={d === day}
              className={`day ${d === day ? 'is-on' : ''}`}
              onClick={() => onDay(d)}
            >
              <span className="day-name">{isToday(d) ? 'Today' : fmtDay(d)}</span>
              <span className="day-open">{openByDay.get(d) ?? 0} open</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid-scroll">
        <div className={`grid ${scan ? 'is-scanning' : ''}`} style={{ '--cols': cols.length } as React.CSSProperties}>
          <div className="grid-corner" />
          {cols.map((t, i) =>
            t ? (
              <div key={t} className={`grid-time ${t.endsWith(':00') ? 'is-hour' : ''}`}>
                {t.endsWith(':00') ? fmtTime(t) : ''}
              </div>
            ) : (
              <div key={`gap${i}`} className="grid-gap-head">Lunch</div>
            ),
          )}

          {doctors.map((doc) => {
            const today = new Map(doc.slots.filter((s) => dayKey(s.starts_at) === day).map((s) => [timeKey(s.starts_at), s]))
            const open = [...today.values()].filter((s) => !s.is_booked).length
            const read = scan?.doctorIds.has(doc.id) ?? false
            const dim = scan !== null && !read ? 'is-dim' : ''
            let offerIndex = 0
            return (
              <div className="grid-row" key={doc.id} role="row">
                <div className={`doc ${dim} ${read ? 'is-read' : ''}`}>
                  <span className="doc-name">{doc.name}</span>
                  <span className="doc-spec">
                    {doc.speciality}
                    <span className="doc-open">{open ? `${open} open` : 'Full'}</span>
                  </span>
                </div>
                {cols.map((t, i) => {
                  if (!t) return <div key={`g${i}`} className={`grid-gap ${dim}`} />
                  const s = today.get(t)
                  if (!s) return <div key={t} className={`cell cell-off ${dim}`} aria-hidden="true" />
                  const offered = scan?.slotIds.has(s.id) && !s.is_booked
                  const state = offered ? 'offer' : !s.is_booked ? 'open' : voiceSlots.has(s.id) ? 'voice' : 'taken'
                  const f = flash.get(s.id)
                  const who = patients.get(s.id)
                  const label = { open: 'open', offer: 'being offered', taken: 'taken', voice: 'booked by Mira' }[state]
                  return (
                    <div
                      key={t}
                      className={`cell cell-${state} ${f ? `flash-${f}` : ''} ${dim}`}
                      style={offered ? ({ '--i': offerIndex++ } as React.CSSProperties) : undefined}
                      title={`${doc.name}, ${fmtTime(t)}: ${who ? who : label}`}
                      aria-label={`${doc.name}, ${fmtTime(t)}, ${label}${who ? `, ${who}` : ''}`}
                    >
                      {who && <span className="cell-who">{initials(who)}</span>}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <div className="legend" aria-hidden="true">
        <span><i className="cell cell-open" /> Open</span>
        <span><i className="cell cell-taken" /> Taken</span>
        <span><i className="cell cell-voice" /> Booked by Mira</span>
        <span><i className="cell cell-offer" /> Mira is offering</span>
      </div>
    </section>
  )
}
