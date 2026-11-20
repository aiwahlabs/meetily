"use client";

import * as React from "react";
import { useReducedMotion } from "framer-motion";
import { AudioLines, Ellipsis, Mic, MicOff } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["figure", "title", "body", "sub", "dense", "meta", "chip", "micro"] }],
      shadow: [{ shadow: ["float", "overlay"] }],
    },
  },
});

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type VoiceOrbState = "idle" | "listening" | "thinking" | "speaking" | "muted";

export interface VoiceOrbProps extends Omit<React.HTMLAttributes<HTMLElement>, "onClick"> {
  /** What the assistant is doing. */
  state: VoiceOrbState;
  /** 0–1. Drives the bars while listening and the swell while speaking. */
  level?: number;
  /** Diameter in pixels, ring included. Default 160. */
  size?: number;
  /** The disc's gradient and the bars, any CSS colours. Default the theme's info hue, deepened toward its ink. */
  colors?: [string, string];
  /** The icon in the disc. Default the theme's info foreground. */
  iconColor?: string;
  /** Tap to talk or to interrupt. Makes the orb a button. */
  onClick?: () => void;
  /** The accessible name. Default describes the state, or the action when clickable. */
  label?: string;
}

const BARS = 56;
const DISC = 27;
const IN = 33;
const MAX = 15;

const ACTION: Record<VoiceOrbState, string> = {
  idle: "Start talking",
  listening: "Stop listening",
  thinking: "Interrupt",
  speaking: "Interrupt",
  muted: "Unmute",
};
const SAID: Record<VoiceOrbState, string> = {
  idle: "Voice assistant, idle",
  listening: "Voice assistant, listening",
  thinking: "Voice assistant, thinking",
  speaking: "Voice assistant, speaking",
  muted: "Voice assistant, muted",
};

function shape(s: VoiceOrbState, i: number, t: number, level: number, noise: number[]) {
  const a = (i / BARS) * Math.PI * 2;
  if (s === "muted") return { len: 0, op: 0.35 };
  if (s === "idle") {
    const w = (Math.sin(a * 2 - t * 1.6) + 1) / 2;
    return { len: 0.04 + w * 0.1, op: 0.3 + w * 0.35 };
  }
  if (s === "thinking") {
    const head = (t * 1.9) % (Math.PI * 2);
    const behind = (((head - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const tail = Math.max(0, 1 - behind / (Math.PI * 0.75));
    return { len: 0.08 + tail * tail * 0.3, op: 0.22 + tail * 0.78 };
  }
  if (s === "listening") {
    const jitter = noise[i];
    const dance = (Math.sin(t * 11 + i * 1.7) + Math.sin(t * 7.3 - i * 0.9)) / 4 + 0.5;
    const len = 0.08 + level * (0.25 + 0.9 * jitter * dance + 0.25 * dance);
    return { len: Math.min(1, len), op: 0.55 + Math.min(1, len) * 0.45 };
  }
  const lobe = (Math.sin(a * 4 + t * 1.4) + 1) / 2;
  const breath = (Math.sin(a * 2 - t * 2.3) + 1) / 2;
  const len = 0.1 + level * (0.3 + lobe * 0.55 + breath * 0.15);
  return { len: Math.min(1, len), op: 0.6 + Math.min(1, len) * 0.4 };
}

const ICON: Record<VoiceOrbState, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  idle: Mic,
  listening: Mic,
  thinking: Ellipsis,
  speaking: AudioLines,
  muted: MicOff,
};

export const VoiceOrb = React.forwardRef<HTMLElement, VoiceOrbProps>(function VoiceOrb(
  { state, level = 0, size = 160, colors, iconColor, onClick, label, className, style, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const id = React.useId().replace(/:/g, "");
  const bars = React.useRef<(SVGLineElement | null)[]>([]);
  const glow = React.useRef<SVGCircleElement>(null);
  const host = React.useRef<HTMLElement | null>(null);
  const live = React.useRef({ state, level });
  live.current = { state, level };
  const [c1, c2] = colors ?? ["var(--color-info)", "color-mix(in oklab, var(--color-info) 62%, var(--color-foreground))"];
  const muted = state === "muted";

  const noise = React.useMemo(() => Array.from({ length: BARS }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1).map((n) => Math.abs(n)), []);

  const place = (el: SVGLineElement | null, i: number, len: number, op: number) => {
    if (!el) return;
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
    const r2 = IN + 0.01 + len * MAX;
    el.setAttribute("x2", (50 + Math.cos(a) * r2).toFixed(2));
    el.setAttribute("y2", (50 + Math.sin(a) * r2).toFixed(2));
    el.setAttribute("opacity", op.toFixed(3));
  };

  React.useEffect(() => {
    if (reduce) return;
    const el = host.current;
    let raf = 0;
    let visible = true;
    let smooth = 0;
    const lens = new Array(BARS).fill(0.08);
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const { state: s, level: l } = live.current;
      smooth += ((s === "listening" || s === "speaking" ? l : 0) - smooth) * Math.min(1, dt * (s === "listening" ? 16 : 7));
      const t = now / 1000;
      for (let i = 0; i < BARS; i++) {
        const { len, op } = shape(s, i, t, smooth, noise);
        lens[i] += (len - lens[i]) * Math.min(1, dt * 12);
        place(bars.current[i], i, lens[i], op);
      }
      glow.current?.setAttribute("r", (DISC + 2 + smooth * 5).toFixed(2));
      if (visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      if (visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const io =
      el && "IntersectionObserver" in window
        ? new IntersectionObserver(([e]) => {
            visible = e.isIntersecting;
            resume();
          })
        : null;
    if (el) io?.observe(el);
    document.addEventListener("visibilitychange", resume);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [reduce, noise]);

  const still = Array.from({ length: BARS }, (_, i) => shape(state, i, 0.6, state === "listening" || state === "speaking" ? 0.55 : 0, noise));
  const Icon = ICON[state];

  const svg = (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden className="block overflow-visible">
      <defs>
        <radialGradient id={`${id}-disc`} cx="38%" cy="30%" r="85%">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </radialGradient>
        <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <g stroke={muted ? "var(--color-muted-foreground)" : c1} strokeWidth="1.9" strokeLinecap="round">
        {still.map(({ len, op }, i) => {
          const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
          const r2 = IN + 0.01 + len * MAX;
          return (
            <line
              key={i}
              ref={(el) => {
                bars.current[i] = el;
              }}
              x1={(50 + Math.cos(a) * IN).toFixed(2)}
              y1={(50 + Math.sin(a) * IN).toFixed(2)}
              x2={(50 + Math.cos(a) * r2).toFixed(2)}
              y2={(50 + Math.sin(a) * r2).toFixed(2)}
              opacity={op}
            />
          );
        })}
      </g>
      <circle ref={glow} cx="50" cy="54" r={DISC + 2} fill={c2} opacity={muted ? 0 : 0.35} filter={`url(#${id}-blur)`} />
      <circle cx="50" cy="50" r={DISC} fill={muted ? "var(--color-muted)" : `url(#${id}-disc)`} />
      <circle cx="50" cy="50" r={DISC - 0.5} fill="none" stroke="white" strokeOpacity={muted ? 0 : 0.18} strokeWidth="1" />
    </svg>
  );

  const pulse =
    reduce && (state === "listening" || state === "speaking") ? "animate-[pulse_2.4s_ease-in-out_infinite]" : "";
  const name = label ?? (onClick ? ACTION[state] : SAID[state]);
  const body = (
    <>
      <span className={cn("relative block", pulse)}>{svg}</span>
      <span
        aria-hidden
        className={cn("absolute inset-0 grid place-items-center", muted ? "text-muted-foreground" : !iconColor && "text-info-foreground")}
        style={!muted && iconColor ? { color: iconColor } : undefined}
      >
        <Icon style={{ width: size * 0.17, height: size * 0.17 }} />
      </span>
      <span className="sr-only" aria-live="polite">
        {SAID[state]}
      </span>
    </>
  );

  const setRef = (el: HTMLElement | null) => {
    host.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLElement | null>).current = el;
  };

  if (onClick) {
    return (
      <button
        ref={setRef as React.Ref<HTMLButtonElement>}
        type="button"
        onClick={onClick}
        aria-label={name}
        aria-pressed={state === "listening"}
        {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        style={{ width: size, height: size, ...style }}
        className={cn(FOCUS, "relative inline-grid shrink-0 cursor-pointer place-items-center rounded-full focus-visible:ring-offset-4 focus-visible:ring-offset-background", className)}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      ref={setRef as React.Ref<HTMLSpanElement>}
      role="img"
      aria-label={name}
      {...rest}
      style={{ width: size, height: size, ...style }}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
    >
      {body}
    </span>
  );
});

export default VoiceOrb;
