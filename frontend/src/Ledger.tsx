import type { Appointment } from './api'
import { dayKey, fmtDay, fmtPhone, fmtTime, timeKey } from './api'

/** Every appointment, newest first. Rows the agent just touched light up. */
export function Ledger({ items, flash }: { items: Appointment[]; flash: Map<string, 'booked' | 'freed'> }) {
  const live = items.filter((a) => a.status === 'booked').length

  return (
    <section className="ledger" aria-labelledby="ledger-title">
      <div className="ledger-top">
        <h2 id="ledger-title">Appointments</h2>
        <span className="ledger-count">{live} upcoming</span>
      </div>

      {items.length === 0 ? (
        <p className="empty">No appointments yet. Start a call and ask Mira to book one.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Patient</th>
              <th scope="col">Mobile</th>
              <th scope="col">Doctor</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const f = flash.get(a.id)
              return (
                <tr key={a.id} className={`${a.status === 'cancelled' ? 'is-cancelled' : ''} ${f ? `row-flash-${f}` : ''}`}>
                  <td className="when">
                    <span className="when-time">{fmtTime(timeKey(a.starts_at))}</span>
                    <span className="when-day">{fmtDay(dayKey(a.starts_at))}</span>
                  </td>
                  <td>
                    {a.patient_name}
                    <span className="ref">{a.id}</span>
                  </td>
                  <td className="num">{fmtPhone(a.phone)}</td>
                  <td>
                    {a.doctor_name}
                    <span className="spec">{a.speciality}</span>
                  </td>
                  <td>
                    <span className={`status status-${a.status}`}>
                      {a.status === 'booked' ? 'Booked' : 'Cancelled'}
                    </span>
                    <span className="via">{a.source === 'voice' ? 'by Mira' : 'at the desk'}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
