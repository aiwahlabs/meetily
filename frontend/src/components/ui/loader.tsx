"use client";

import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

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

export type LoaderVariant = "ring" | "orbit" | "dots" | "bars" | "pulse" | "square" | "shimmer";

export interface LoaderProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: LoaderVariant;
  /** Size in pixels for the shapes; the shimmer follows the text size. Default 20. */
  size?: number;
  /** What is happening, for screen readers and, with `shimmer`, on screen. Default "Loading". */
  label?: string;
  /** Show the label next to the shape. Default false (shimmer always shows it). */
  showLabel?: boolean;
}

const CSS = `
@keyframes ly-spin{to{transform:rotate(360deg)}}
@keyframes ly-dot{0%,80%,100%{transform:scale(.55);opacity:.35}40%{transform:scale(1);opacity:1}}
@keyframes ly-bar{0%,100%{transform:scaleY(.35);opacity:.45}50%{transform:scaleY(1);opacity:1}}
@keyframes ly-pulse{0%{transform:scale(.35);opacity:.9}100%{transform:scale(1.25);opacity:0}}
@keyframes ly-square{0%{transform:rotate(0) scale(1)}50%{transform:rotate(180deg) scale(.7)}100%{transform:rotate(360deg) scale(1)}}
@keyframes ly-shimmer{from{background-position:150% 0}to{background-position:-50% 0}}
@keyframes ly-breathe{0%,100%{opacity:.45}50%{opacity:1}}
.ly-loader *{animation-play-state:running}
@media (prefers-reduced-motion: reduce){.ly-loader [data-move]{animation:ly-breathe 1.6s ease-in-out infinite!important;transform:none!important}}
`;

let injected = false;
function useLoaderCss() {
  React.useInsertionEffect(() => {
    if (injected || typeof document === "undefined") return;
    injected = true;
    const s = document.createElement("style");
    s.setAttribute("data-liro", "loader");
    s.textContent = CSS;
    document.head.appendChild(s);
  }, []);
}

export function useDelayedLoading(busy: boolean, { delay = 300, minimum = 500 }: { delay?: number; minimum?: number } = {}) {
  const [show, setShow] = React.useState(false);
  const since = React.useRef(0);
  React.useEffect(() => {
    if (busy && !show) {
      const t = setTimeout(() => {
        since.current = Date.now();
        setShow(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!busy && show) {
      const left = Math.max(0, minimum - (Date.now() - since.current));
      const t = setTimeout(() => setShow(false), left);
      return () => clearTimeout(t);
    }
  }, [busy, show, delay, minimum]);
  return show;
}

export const Loader = React.forwardRef<HTMLSpanElement, LoaderProps>(function Loader(
  { variant = "ring", size = 20, label = "Loading", showLabel = false, className, style, ...rest },
  ref,
) {
  useLoaderCss();
  const s = size;
  let shape: React.ReactNode = null;

  if (variant === "ring")
    shape = (
      <span data-move className="block rounded-full border-current" style={{ width: s, height: s, borderWidth: Math.max(2, s / 9), borderTopColor: "transparent", borderStyle: "solid", opacity: 0.9, animation: "ly-spin .75s linear infinite" }} />
    );
  else if (variant === "orbit")
    shape = (
      <span className="relative block" style={{ width: s, height: s }}>
        <span className="absolute inset-0 rounded-full border-current opacity-20" style={{ borderWidth: Math.max(2, s / 9), borderStyle: "solid" }} />
        <span data-move className="absolute inset-0" style={{ animation: "ly-spin 1.1s cubic-bezier(.5,.15,.5,.85) infinite" }}>
          <span className="absolute left-1/2 rounded-full bg-current" style={{ width: s / 4, height: s / 4, top: -s / 16, marginLeft: -s / 8 }} />
        </span>
      </span>
    );
  else if (variant === "dots")
    shape = (
      <span className="flex items-center" style={{ gap: s / 6, height: s }}>
        {[0, 1, 2].map((i) => (
          <span key={i} data-move className="block rounded-full bg-current" style={{ width: s / 4, height: s / 4, animation: `ly-dot 1.1s ease-in-out ${i * 0.15}s infinite both` }} />
        ))}
      </span>
    );
  else if (variant === "bars")
    shape = (
      <span className="flex items-center" style={{ gap: s / 8, height: s }}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-move className="block rounded-full bg-current" style={{ width: s / 7, height: s, animation: `ly-bar .9s ease-in-out ${i * 0.12}s infinite` }} />
        ))}
      </span>
    );
  else if (variant === "pulse")
    shape = (
      <span className="relative grid place-items-center" style={{ width: s, height: s }}>
        <span data-move className="absolute inset-0 rounded-full bg-current" style={{ animation: "ly-pulse 1.3s cubic-bezier(.2,.6,.3,1) infinite" }} />
        <span data-move className="absolute inset-0 rounded-full bg-current" style={{ animation: "ly-pulse 1.3s cubic-bezier(.2,.6,.3,1) .65s infinite" }} />
        <span className="relative block rounded-full bg-current" style={{ width: s / 3, height: s / 3 }} />
      </span>
    );
  else if (variant === "square")
    shape = <span data-move className="block rounded-[28%] bg-current [corner-shape:squircle]" style={{ width: s * 0.7, height: s * 0.7, margin: s * 0.15, animation: "ly-square 1.4s cubic-bezier(.6,.05,.4,.95) infinite" }} />;

  if (variant === "shimmer")
    return (
      <span ref={ref} role="status" className={cn("ly-loader inline-flex", className)} style={style} {...rest}>
        <span
          data-move
          className="bg-clip-text font-medium [-webkit-text-fill-color:transparent]"
          style={{
            backgroundImage: "linear-gradient(90deg, color-mix(in oklab, currentColor 45%, transparent) 0%, color-mix(in oklab, currentColor 45%, transparent) 40%, currentColor 50%, color-mix(in oklab, currentColor 45%, transparent) 60%, color-mix(in oklab, currentColor 45%, transparent) 100%)",
            backgroundSize: "200% 100%",
            animation: "ly-shimmer 1.8s linear infinite",
          }}
        >
          {label}…
        </span>
      </span>
    );

  return (
    <span ref={ref} role="status" className={cn("ly-loader inline-flex items-center gap-2", className)} style={style} {...rest}>
      <span aria-hidden className="inline-grid shrink-0 place-items-center">
        {shape}
      </span>
      {showLabel ? <span className="text-[13px]">{label}…</span> : <span className="sr-only">{label}…</span>}
    </span>
  );
});

export default Loader;
