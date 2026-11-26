import { describe, expect, it } from "vitest";
import { createOrb, type OrbHandle } from "../web/src/lib/orb";

const SIZE = 320;

/**
 * Runs the real shape code against a fake canvas and a clock the test steps
 * by hand, and records the outline it draws on every frame.
 */
function shape(options: { reducedMotion?: boolean } = {}) {
  let outline: [number, number][] = [];
  let rings = 0;
  let next: ((ms: number) => void) | null = null;
  let now = 0;

  const gradient = { addColorStop() {} };
  const ctx = {
    setTransform() {}, clearRect() {}, fillRect() {}, fill() {}, save() {}, restore() {}, clip() {}, closePath() {}, stroke() {},
    createRadialGradient: () => gradient,
    beginPath() { outline = []; },
    moveTo(x: number, y: number) { outline.push([x, y]); },
    lineTo(x: number, y: number) { outline.push([x, y]); },
    arc() { rings++; },
    fillStyle: "", strokeStyle: "", lineWidth: 0,
  };
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: SIZE, height: SIZE }), width: 0, height: 0 };
  const color = "#8ea8ff";
  const api: OrbHandle = createOrb(canvas, {
    colors: { light: color, mid: color, deep: color, warm: color },
    reducedMotion: Boolean(options.reducedMotion),
    pixelRatio: 1,
    requestFrame: (draw) => { next = draw; return 1; },
    cancelFrame() {},
  });

  /** Draws one frame 1/60 s later and returns the mean radius and how far the outline is from a circle. */
  const step = () => {
    now += 1000 / 60;
    rings = 0;
    next!(now);
    // The last path drawn in a frame is the sphere (rings use arc, not lineTo).
    const radii = outline.map(([x, y]) => Math.hypot(x - SIZE / 2, y - SIZE / 2));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    return { mean, lopsided: Math.max(...radii.map((r) => Math.abs(r - mean))) / mean, rings };
  };
  const run = (frames: number) => Array.from({ length: frames }, step);
  return { api, step, run };
}

const biggestJump = (frames: { mean: number }[]) => Math.max(...frames.slice(1).map((f, i) => Math.abs(f.mean - frames[i].mean) / frames[i].mean));

describe("the shape's motion", () => {
  it("moves visibly at rest, slowly and without jumps", () => {
    const frames = shape().run(600);
    const lopsided = frames.map((f) => f.lopsided);
    const sizes = frames.map((f) => f.mean);
    // It flows: the outline leaves a circle by 3 to 5.5 percent...
    expect(Math.max(...lopsided)).toBeGreaterThan(0.03);
    expect(Math.max(...lopsided)).toBeLessThan(0.055);
    // ...and it breathes: the size changes by about 6 percent over a breath...
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(1.04);
    // ...but never more than a third of a percent between two frames.
    expect(biggestJump(frames)).toBeLessThan(0.0035);
    expect(frames.every((f) => f.rings === 0)).toBe(true);
  });

  it("does not jump when you tap it and the voice starts at full volume", () => {
    const s = shape();
    s.run(120);
    s.api.setMood("speaking");
    s.api.setLevel(1);
    const frames = s.run(180);
    // Less than 1.2% change in size from one frame to the next, even in the worst case.
    expect(biggestJump(frames)).toBeLessThan(0.018);
    // The first frame after the tap looks the same as the one before it.
    expect(frames[0].lopsided).toBeLessThan(0.055);
  });

  it("moves clearly with the voice: up to 20% off round and 24% bigger, never in a jump", () => {
    const s = shape();
    const rest = s.run(60).at(-1)!.mean;
    s.api.setMood("speaking");
    const frames = [];
    for (let i = 0; i < 900; i++) {
      // A voice that swings between silence and full volume four times a second.
      s.api.setLevel(i % 15 < 7 ? 1 : 0);
      frames.push(s.step());
    }
    expect(Math.max(...frames.map((f) => f.lopsided))).toBeGreaterThan(0.09);
    expect(Math.max(...frames.map((f) => f.lopsided))).toBeLessThan(0.2);
    expect(Math.max(...frames.map((f) => f.mean)) / rest).toBeLessThan(1.24);
    expect(biggestJump(frames)).toBeLessThan(0.018);
    expect(frames.at(-1)!.rings).toBe(3);
  });

  it("settles back when the voice stops", () => {
    const s = shape();
    const rest = s.run(60).at(-1)!;
    s.api.setMood("speaking");
    s.api.setLevel(1);
    s.run(180);
    s.api.setMood("idle");
    const after = s.run(240);
    expect(biggestJump(after)).toBeLessThan(0.018);
    expect(Math.abs(after.at(-1)!.mean - rest.mean) / rest.mean).toBeLessThan(0.08);
    expect(after.at(-1)!.rings).toBe(0);
  });

  it("holds still for people who ask for reduced motion", () => {
    const s = shape({ reducedMotion: true });
    s.api.setMood("speaking");
    s.api.setLevel(1);
    const frames = s.run(300);
    expect(Math.max(...frames.map((f) => f.lopsided))).toBeLessThan(0.006);
    expect(frames.every((f) => f.rings === 0)).toBe(true);
  });
});
