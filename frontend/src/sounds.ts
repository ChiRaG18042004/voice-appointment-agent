// Call sounds, synthesised with WebAudio so there are no audio files to ship.

let ctx: AudioContext | null = null
const ac = () => (ctx ??= new AudioContext())

function tone(freqs: number[], start: number, dur: number, gain = 0.06) {
  const a = ac()
  const g = a.createGain()
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.02)
  g.gain.setValueAtTime(gain, start + dur - 0.03)
  g.gain.linearRampToValueAtTime(0, start + dur)
  g.connect(a.destination)
  for (const f of freqs) {
    const o = a.createOscillator()
    o.frequency.value = f
    o.connect(g)
    o.start(start)
    o.stop(start + dur)
  }
}

/** Indian ringback: 400 + 450 Hz, on 0.4 s, off 0.2 s, on 0.4 s, off 2 s. Returns a stop fn. */
export function startRingback(): () => void {
  const a = ac()
  void a.resume()
  let stopped = false
  let timer = 0
  const cycle = () => {
    if (stopped) return
    const t = a.currentTime + 0.05
    tone([400, 450], t, 0.4)
    tone([400, 450], t + 0.6, 0.4)
    timer = window.setTimeout(cycle, 3000)
  }
  cycle()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** Three falling pips when the line drops. */
export function playHangup() {
  const a = ac()
  void a.resume()
  const t = a.currentTime + 0.02
  ;[620, 520, 420].forEach((f, i) => tone([f], t + i * 0.16, 0.12, 0.05))
}

/** Soft two-note chime for a confirmed booking. */
export function playConfirm() {
  const a = ac()
  void a.resume()
  const t = a.currentTime + 0.02
  tone([660], t, 0.12, 0.04)
  tone([990], t + 0.12, 0.22, 0.04)
}
