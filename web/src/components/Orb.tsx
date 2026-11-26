import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { createOrb, type OrbColors, type OrbHandle } from "@/lib/orb";

function readColors(): OrbColors {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return { light: get("--orb-light"), mid: get("--orb"), deep: get("--orb-deep"), warm: get("--orb-warm") };
}

/** The canvas the shape is drawn on. `dark` is passed so the colours follow the theme. */
export function Orb({ ref, dark }: { ref: Ref<OrbHandle | null>; dark: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const orb = useRef<OrbHandle | null>(null);
  useImperativeHandle(ref, () => orb.current as OrbHandle, []);

  useEffect(() => {
    const handle = createOrb(canvas.current!, {
      colors: readColors(),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      pixelRatio: window.devicePixelRatio,
      requestFrame: (draw) => requestAnimationFrame(draw),
      cancelFrame: (id) => cancelAnimationFrame(id),
    });
    orb.current = handle;
    const onResize = () => handle.resize();
    addEventListener("resize", onResize);
    // Also when the canvas itself changes size, such as when its tab is shown.
    const watcher = new ResizeObserver(onResize);
    watcher.observe(canvas.current!);
    return () => {
      watcher.disconnect();
      removeEventListener("resize", onResize);
      handle.stop();
    };
  }, []);

  useEffect(() => {
    orb.current?.setColors(readColors());
  }, [dark]);

  return <canvas ref={canvas} aria-hidden="true" className="block size-full" />;
}
