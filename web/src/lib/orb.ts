// The shape in the middle of the page: a soft sphere that breathes.
//
// At rest its outline flows slowly, like liquid, and it breathes. While the
// assistant speaks it flows faster, swells with the voice and sends out rings.
// Every value is eased, so it moves a lot but never jumps or jitters. `level` (0 to 1) is how loud the voice is.

export type Mood = "idle" | "listening" | "thinking" | "speaking";

export interface OrbColors {
  light: string;
  mid: string;
  deep: string;
  warm: string;
}

export interface OrbHandle {
  setMood(mood: Mood): void;
  setLevel(level: number): void;
  setColors(colors: OrbColors): void;
  resize(): void;
  stop(): void;
}

/** What the orb needs from the page. Tests pass fakes and step frames by hand. */
export interface OrbEnv {
  colors: OrbColors;
  reducedMotion: boolean;
  pixelRatio: number;
  requestFrame: (draw: (ms: number) => void) => number;
  cancelFrame: (id: number) => void;
}

const STEPS = 72;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The few canvas members the orb uses. Described here instead of using the
 * browser's own type so this file also runs in the tests, outside a browser.
 */
export interface OrbCanvas {
  width: number;
  height: number;
  getBoundingClientRect(): { width: number; height: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContext(kind: "2d"): any;
}

export function createOrb(canvas: OrbCanvas, env: OrbEnv): OrbHandle {
  const ctx = canvas.getContext("2d");
  const calm = env.reducedMotion;
  let colors = env.colors;
  let mood: Mood = "idle";
  let target = 0; // loudness asked for
  let level = 0; // loudness shown, eased
  let wobble = 0.006; // how far the outline leaves a circle, eased
  let ringGain = 0; // how visible the rings are, eased
  let flow = 0; // the clock the surface moves by. It runs faster while speaking or thinking.
  let pace = 1; // how fast that clock runs, eased so a change of state never jumps
  let size = 0;
  let last = 0;
  let frameId = 0;
  let running = true;

  function resize() {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    const ratio = Math.min(env.pixelRatio || 1, 2);
    size = box.width;
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  // A circle whose edge drifts by a few percent in two or three slow, wide waves.
  function outline(t: number, radius: number, amount: number) {
    const c = size / 2;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      const r = radius * (1 + amount * (0.55 * Math.sin(2 * a + t) + 0.3 * Math.sin(3 * a - t * 0.8 + 1.3) + 0.15 * Math.sin(4 * a + t * 1.3 + 2.1)));
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function frame(ms: number) {
    if (!running) return;
    frameId = env.requestFrame(frame);
    if (!size) return;
    const t = ms / 1000;
    // Ease per second, not per frame, so it moves the same on any screen.
    const dt = Math.min((ms - last) / 1000 || 0.016, 0.05);
    last = ms;
    const ease = (from: number, to: number, speed: number) => from + (to - from) * (1 - Math.exp(-speed * dt));

    const speaking = mood === "speaking";
    level = ease(level, speaking ? target : 0, 5);
    // How far the outline flows away from a circle. Enough to look alive at rest,
    // more with the voice, and always changing smoothly.
    const wantWobble = calm ? 0.004 : speaking ? 0.09 + level * 0.09 : mood === "thinking" ? 0.06 : mood === "listening" ? 0.05 : 0.045;
    wobble = ease(wobble, wantWobble, 2.5);
    ringGain = ease(ringGain, calm ? 0 : speaking ? 0.45 + level * 0.55 : mood === "listening" ? 0.5 : 0, 3);
    pace = ease(pace, calm ? 0.3 : speaking ? 1.8 + level * 1.4 : mood === "thinking" ? 2.2 : mood === "listening" ? 1.3 : 1, 2);
    flow += dt * pace;

    const c = size / 2;
    const breath = calm ? 0 : 0.03 * Math.sin(flow * 1.2);
    const radius = size * 0.255 * (1 + breath + level * 0.14);

    ctx.clearRect(0, 0, size, size);

    // Soft halo.
    const halo = ctx.createRadialGradient(c, c, radius * 0.7, c, c, size * 0.5);
    halo.addColorStop(0, rgba(colors.mid, 0.28 + level * 0.12));
    halo.addColorStop(1, rgba(colors.mid, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Rings that drift outward while there is sound.
    if (ringGain > 0.01) {
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.36 + i / 3) % 1;
        ctx.beginPath();
        ctx.arc(c, c, radius * (1.04 + phase * 0.62), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colors.mid, ringGain * 0.5 * (1 - phase) * (1 - phase));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // The sphere.
    outline(flow, radius, wobble);
    // The highlight wanders across the upper half, so the surface looks liquid.
    const hx = c - radius * 0.38 * Math.cos(flow * 0.5);
    const hy = c - radius * 0.34 + radius * 0.16 * Math.sin(flow * 0.8);
    const body = ctx.createRadialGradient(hx, hy, radius * 0.05, c, c, radius * 1.08);
    body.addColorStop(0, colors.light);
    body.addColorStop(0.55, colors.mid);
    body.addColorStop(1, colors.deep);
    ctx.fillStyle = body;
    ctx.fill();

    // A warm pastel blush on the lower right, clipped to the sphere.
    ctx.save();
    ctx.clip();
    // It circles slowly, opposite the highlight.
    const bx = c + radius * 0.55 * Math.cos(flow * 0.4 + 0.6);
    const by = c + radius * 0.5 * Math.sin(flow * 0.4 + 0.9);
    const blush = ctx.createRadialGradient(bx, by, 0, bx, by, radius * 0.95);
    blush.addColorStop(0, rgba(colors.warm, 0.55 + level * 0.2));
    blush.addColorStop(1, rgba(colors.warm, 0));
    ctx.fillStyle = blush;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  resize();
  frameId = env.requestFrame(frame);

  return {
    resize,
    setMood(next) {
      mood = next;
      if (next !== "speaking") target = 0;
    },
    setLevel(value) {
      target = Math.max(0, Math.min(1, value));
    },
    setColors(next) {
      colors = next;
    },
    stop() {
      running = false;
      env.cancelFrame(frameId);
    },
  };
}
