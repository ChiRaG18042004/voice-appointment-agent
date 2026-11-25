// Types and fetchers for the clinic data served by backend/server.py

export type Slot = { id: string; starts_at: string; is_booked: boolean }
export type Doctor = { id: string; name: string; speciality: string; slots: Slot[] }
export type Appointment = {
  id: string
  slot_id: string
  doctor_id: string
  doctor_name: string
  speciality: string
  patient_name: string
  phone: string
  status: 'booked' | 'cancelled'
  source: 'voice' | 'desk'
  starts_at: string
  created_at: string
  cancelled_at: string | null
}

export type BookingEvent = {
  appointment_id: string
  slot_id: string
  doctor: string
  when: string
  starts_at: string
  patient_name: string
  phone?: string
}

export type ServerEvent =
  | { type: 'appointment_booked'; data: BookingEvent }
  | { type: 'appointment_cancelled'; data: BookingEvent }
  | { type: 'tool'; data: { name: string } }
  | { type: 'scan'; data: ScanEvent }
  | { type: 'reset'; data: Record<string, never> }

/** What the agent is reading: diary rows, and the slots (id -> starts_at) it may offer. */
export type ScanEvent = { doctor_ids: string[]; doctors: string[]; slots: Record<string, string>; date: string | null }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${path} returned ${r.status}`)
  return r.json()
}

export const fetchDoctors = () => get<Doctor[]>('/api/doctors')
export const fetchAppointments = () => get<Appointment[]>('/api/appointments')
export const resetDemo = () => fetch('/api/reset', { method: 'POST' })

export function subscribe(onEvent: (e: ServerEvent) => void): () => void {
  const es = new EventSource('/api/events')
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data))
    } catch {
      /* ignore malformed lines */
    }
  }
  return () => es.close()
}

// ---------- formatting

export const dayKey = (iso: string) => iso.slice(0, 10)
export const timeKey = (iso: string) => iso.slice(11, 16)

export function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`
}

export function fmtDay(day: string, style: 'short' | 'long' = 'short') {
  const d = new Date(day + 'T00:00')
  return d.toLocaleDateString('en-IN', style === 'short'
    ? { weekday: 'short', day: 'numeric' }
    : { weekday: 'long', day: 'numeric', month: 'long' })
}

export function fmtPhone(p: string) {
  return p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p
}

export function isToday(day: string) {
  const t = new Date()
  const local = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  return day === local
}
