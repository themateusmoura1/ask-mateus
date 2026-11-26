import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect } from "react";

const SOFT = [0.23, 1, 0.32, 1] as const;

/** A number that counts up to its value. */
export function Ticker({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const current = useMotionValue(reduce ? value : 0);
  const shown = useTransform(current, (n) => String(Math.round(n)));
  useEffect(() => {
    if (reduce) {
      current.set(value);
      return;
    }
    const controls = animate(current, value, { duration: 0.9, ease: SOFT });
    return () => controls.stop();
  }, [value, reduce, current]);
  return <motion.span className={className}>{shown}</motion.span>;
}

/** A ring that fills to `value` out of `max`, with the number in the middle. */
export function ScoreRing({ value, max, size = 132 }: { value: number; max: number; size?: number }) {
  const reduce = useReducedMotion();
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(1, value / max));
  return (
    <div className="relative flex-none" style={{ width: size, height: size }} role="img" aria-label={`Score ${value} of ${max}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-secondary" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={length}
          initial={{ strokeDashoffset: reduce ? length * (1 - fraction) : length }}
          animate={{ strokeDashoffset: length * (1 - fraction) }}
          transition={{ duration: 0.9, ease: SOFT }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <Ticker value={value} className="font-heading text-[34px] font-semibold tracking-[-0.04em] tabular-nums" />
          <div className="mt-1 text-[12px] text-dim">of {max}</div>
        </div>
      </div>
    </div>
  );
}

/** A bar that grows to its share. */
export function Bar({ value, max }: { value: number; max: number }) {
  const reduce = useReducedMotion();
  const width = `${(Math.max(0, value) / max) * 100}%`;
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
      <motion.div className="h-full rounded-full bg-primary" initial={{ width: reduce ? width : 0 }} animate={{ width }} transition={{ duration: 0.7, ease: SOFT }} />
    </div>
  );
}

/** Something that slides up into place when it appears. */
export function Rise({ children, className, as = "div" }: { children: React.ReactNode; className?: string; as?: "div" | "li" }) {
  const reduce = useReducedMotion();
  const Tag = as === "li" ? motion.li : motion.div;
  return (
    <Tag className={className} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: SOFT }}>
      {children}
    </Tag>
  );
}

/**
 * The line between the two agents. A dot travels along it at the hand-off,
 * from the first agent to the second.
 */
export function HandoffBeam({ active, done, reverse = false }: { active: boolean; done: boolean; reverse?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <div className={`relative mx-1 hidden h-px w-8 flex-none self-center bg-border sm:block ${reverse ? "rotate-180" : ""}`} aria-hidden="true">
      <motion.div className="absolute inset-y-0 left-0 bg-primary" initial={false} animate={{ width: done ? "100%" : "0%" }} transition={{ duration: reduce ? 0 : 0.6, ease: SOFT }} />
      {active && !reduce && (
        <motion.span
          className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_10px_var(--primary)]"
          initial={{ left: "-10%", opacity: 0 }}
          animate={{ left: "100%", opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.7, ease: "easeInOut" }}
        />
      )}
    </div>
  );
}
