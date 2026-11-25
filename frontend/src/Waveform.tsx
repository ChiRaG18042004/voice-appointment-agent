import { useEffect, useRef } from 'react'

const BARS = 29
const BOT = '#AEB9FF' // larkspur, lightened for the dark screen
const YOU = '#F0C53A' // pollen

function analyser(ctx: AudioContext, track: MediaStreamTrack | null) {
  if (!track) return null
  const src = ctx.createMediaStreamSource(new MediaStream([track]))
  const a = ctx.createAnalyser()
  a.fftSize = 256
  a.smoothingTimeConstant = 0.75
  src.connect(a) // analyser only; it isn't connected to the speakers
  return a
}

function level(a: AnalyserNode | null, buf: Uint8Array<ArrayBuffer>) {
  if (!a) return null
  a.getByteFrequencyData(buf)
  return buf
}

/** Voice-reactive bars: blue while Mira talks, yellow while you do. */
export function Waveform({ bot, mic, active }: { bot: MediaStreamTrack | null; mic: MediaStreamTrack | null; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const g = el.getContext('2d')!
    const ctx = new AudioContext()
    const botA = analyser(ctx, bot)
    const micA = analyser(ctx, mic)
    const bBuf = new Uint8Array(128)
    const mBuf = new Uint8Array(128)
    const heights = new Float32Array(BARS)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let t = 0

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== w * dpr) {
        el.width = w * dpr
        el.height = h * dpr
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      const b = level(botA, bBuf)
      const m = level(micA, mBuf)
      const energy = (buf: Uint8Array | null) => (buf ? buf.slice(2, 40).reduce((s, v) => s + v, 0) / 38 / 255 : 0)
      const be = energy(b)
      const me = energy(m)
      const src = be >= me ? b : m
      const color = be >= me ? BOT : YOU
      const gap = w / BARS
      const barW = Math.max(2, gap * 0.42)
      t += 0.04

      for (let i = 0; i < BARS; i++) {
        // mirror around the centre so speech grows outward
        const d = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2)
        const bin = Math.floor(2 + d * 34)
        const v = src ? src[bin] / 255 : 0
        const idle = active && !reduce ? 0.06 + 0.03 * Math.sin(t + i * 0.5) : 0.05
        const target = Math.max(idle, v * (1.15 - d * 0.55))
        heights[i] += (target - heights[i]) * 0.35
        const bh = Math.max(barW, heights[i] * h * 0.92)
        const x = i * gap + (gap - barW) / 2
        g.fillStyle = heights[i] > 0.1 ? color : 'rgba(238,241,239,0.28)'
        g.beginPath()
        g.roundRect(x, (h - bh) / 2, barW, bh, barW / 2)
        g.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      void ctx.close()
    }
  }, [bot, mic, active])

  return <canvas ref={canvas} className="wave" aria-hidden="true" />
}
