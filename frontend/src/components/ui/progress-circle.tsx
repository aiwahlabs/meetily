"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.8,
} as const;

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

export type ProgressTone = "default" | "success" | "warning" | "destructive";

const STROKE: Record<ProgressTone, string> = {
  default: "stroke-foreground",
  success: "stroke-success",
  warning: "stroke-warning-fill",
  destructive: "stroke-destructive",
};

interface Shared {
  /** Done so far. Leave out, or pass null, while it is not known. */
  value?: number | null;
  /** Default 100. */
  max?: number;
  /** What is progressing: "Uploading contract.pdf". Shown and used as the accessible name. */
  label?: React.ReactNode;
  /** Show the value as text. */
  showValue?: boolean;
  /** Words for the value: `(v, max) => \`${v} of ${max} seats\``. Default a percentage. */
  formatValue?: (value: number, max: number) => string;
  /** Default grey; colour only when it means something. */
  tone?: ProgressTone;
}

const pct = (v: number, max: number) =>
  Math.round((Math.min(Math.max(v, 0), max) / max) * 100);
function words(
  value: number | null | undefined,
  max: number,
  formatValue?: Shared["formatValue"],
) {
  if (value == null) return "In progress";
  const text = formatValue ? formatValue(value, max) : `${pct(value, max)}%`;
  return value > max ? `${text} (over the limit)` : text;
}

export interface ProgressCircleProps
  extends Shared, Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Diameter in px. Default 48. */
  size?: number;
  /** Ring thickness in px. Default size / 10. */
  thickness?: number;
  /** Something in the middle instead of the value, an icon say. */
  children?: React.ReactNode;
}

export const ProgressCircle = React.forwardRef<
  HTMLDivElement,
  ProgressCircleProps
>(function ProgressCircle(
  {
    value,
    max = 100,
    label,
    showValue = false,
    formatValue,
    tone = "default",
    size = 48,
    thickness,
    children,
    className,
    ...props
  },
  ref,
) {
  const reduce = useReducedMotion();
  const id = React.useId();
  const known = value != null;
  const stroke = thickness ?? Math.max(3, Math.round(size / 10));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const text = words(value, max, formatValue);
  const center =
    children ??
    (showValue && known ? (
      <span className="tabular-nums">
        {formatValue ? formatValue(value, max) : `${pct(value, max)}%`}
      </span>
    ) : null);

  return (
    <div
      ref={ref}
      className={cn("inline-flex items-center gap-2.5", className)}
      {...props}
    >
      <div
        role="progressbar"
        aria-labelledby={label ? `${id}-l` : undefined}
        aria-label={label ? undefined : "Progress"}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={known ? Math.min(Math.max(value, 0), max) : undefined}
        aria-valuetext={text}
        aria-busy={!known || undefined}
        className="relative grid shrink-0 place-items-center"
        style={{ width: size, height: size }}
      >
        <motion.svg
          aria-hidden
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="absolute inset-0"
          animate={!known && !reduce ? { rotate: [0, 360] } : undefined}
          transition={
            !known && !reduce
              ? { duration: 1.1, repeat: Infinity, ease: "linear" }
              : undefined
          }
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            className="stroke-foreground/10"
          />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <motion.circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={c}
              className={STROKE[tone]}
              initial={false}
              animate={{
                strokeDashoffset: known
                  ? c * (1 - pct(value, max) / 100)
                  : c * 0.72,
              }}
              transition={reduce ? { duration: 0 } : SPRING}
            />
          </g>
        </motion.svg>
        {center && (
          <span
            aria-hidden
            className="relative font-medium"
            style={{ fontSize: Math.max(10, Math.round(size * 0.24)) }}
          >
            {center}
          </span>
        )}
      </div>
      {label && (
        <span id={`${id}-l`} className="text-[13px] leading-tight font-medium">
          {label}
        </span>
      )}
    </div>
  );
});

export default ProgressCircle;
