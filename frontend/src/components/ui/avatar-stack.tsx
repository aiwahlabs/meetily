"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Avatar as Face } from "@/components/ui/avatar";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const FONT_STACK =
  'var(--font-sans, "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';

const SQUIRCLE = "[corner-shape:squircle]";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const LAYER = {
  dialog: 70,
  popover: 75,
  toast: 80,
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

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 32, lg: 40, xl: 56 };

const TINTS = [
  "bg-[color-mix(in_oklab,var(--color-info)_13%,var(--color-card))] text-info",
  "bg-[color-mix(in_oklab,var(--color-success)_13%,var(--color-card))] text-success",
  "bg-[color-mix(in_oklab,var(--color-warning)_13%,var(--color-card))] text-warning",
  "bg-[color-mix(in_oklab,var(--color-foreground)_8%,var(--color-card))] text-foreground/80",
  "bg-[color-mix(in_oklab,var(--color-destructive)_11%,var(--color-card))] text-destructive",
];

const STATUS: Record<NonNullable<UserAvatarProps["status"]>, string> = {
  online: "bg-success",
  away: "bg-warning-fill",
  busy: "bg-destructive",
  offline: "bg-[color-mix(in_oklab,var(--color-muted-foreground)_70%,var(--color-card))]",
};

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function initials(name: string) {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase();
}

export interface UserAvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The person's name: the alt text, the tooltip, and the seed for the drawn face. */
  name: string;
  /** A photo. Falls back to the drawn face (or initials) if it is missing or fails to load. */
  src?: string;
  /** What to draw without a photo: the Liro face for the name, or initials on a tint. Default face. */
  fallback?: "face" | "initials";
  /** xs 20, sm 24, md 32, lg 40, xl 56 pixels. Default md. */
  size?: AvatarSize;
  /** People are circles; square suits a grid of tiles or a bot. Default circle. */
  shape?: "circle" | "square";
  /** A presence dot in the corner, also read out with the name. */
  status?: "online" | "away" | "busy" | "offline";
  /** A ring in the surface colour, for avatars that overlap or sit on a photo. */
  ring?: boolean;
}

export const UserAvatar = React.forwardRef<HTMLSpanElement, UserAvatarProps>(function UserAvatar(
  { name, src, size = "md", shape = "circle", fallback = "face", status, ring, className, style, ...rest },
  ref,
) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);
  const px = PX[size];
  const round = shape === "circle" ? "rounded-full" : cn(size === "xs" || size === "sm" ? "rounded-[7px]" : "rounded-[10px]", SQUIRCLE);
  const label = status ? `${name}, ${status}` : name;
  const dot = Math.max(6, Math.round(px * 0.26));

  return (
    <span
      ref={ref}
      role="img"
      aria-label={label}
      {...rest}
      style={{ width: px, height: px, fontFamily: FONT_STACK, ...style }}
      className={cn("relative inline-flex shrink-0", className)}
    >
      {src && !broken ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt=""
          onError={() => setBroken(true)}
          className={cn("size-full object-cover", round, ring && "shadow-[0_0_0_2px_var(--color-card)]")}
        />
      ) : fallback === "face" ? (
        <Face
          seed={name}
          size={px}
          shape={shape === "circle" ? "circle" : "squircle"}
          ring={!ring}
          className={cn("size-full", ring && "shadow-[0_0_0_2px_var(--color-card)]")}
        />
      ) : (
        <span
          aria-hidden
          style={{ fontSize: Math.max(9, Math.round(px * 0.38)) }}
          className={cn(
            "grid size-full place-items-center font-semibold tracking-[-0.01em] select-none",
            TINTS[hash(name) % TINTS.length],
            round,
            ring && "shadow-[0_0_0_2px_var(--color-card)]",
          )}
        >
          {initials(name)}
        </span>
      )}
      {status && (
        <span
          aria-hidden
          style={{ width: dot, height: dot }}
          className={cn("absolute right-0 bottom-0 rounded-full ring-2 ring-card", STATUS[status])}
        />
      )}
    </span>
  );
});

export interface AvatarStackProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Everyone in the group, in the order they should appear. */
  people: Array<Omit<UserAvatarProps, "size" | "ring">>;
  /** Faces shown before the rest fold into "+N". Default 4. */
  max?: number;
  /** One size for the whole stack. Default sm. */
  size?: AvatarSize;
  /** How far the faces overlap. Default normal. */
  spacing?: "tight" | "normal";
  /** Each name in a tooltip on hover and focus. Default true. */
  showTooltip?: boolean;
  /** Called when "+N" is pressed. Without it, "+N" opens the full list in a popover. */
  onOverflowClick?: () => void;
  /** Read out for the group, e.g. "Reviewers". Default "People". */
  label?: string;
}

export const AvatarStack = React.forwardRef<HTMLDivElement, AvatarStackProps>(function AvatarStack(
  { people, max = 4, size = "sm", spacing = "normal", showTooltip = true, onOverflowClick, label = "People", className, style, ...rest },
  ref,
) {
  const px = PX[size];
  const overlap = Math.round(px * (spacing === "tight" ? 0.28 : 0.18));
  const shown = people.slice(0, max);
  const rest_ = people.slice(max);

  const face = (p: AvatarStackProps["people"][number], i: number) => {
    const avatar = <UserAvatar {...p} size={size} ring />;
    return (
      <li key={`${p.name}-${i}`} style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: shown.length - i + 1 }} className="relative flex">
        {showTooltip ? (
          <Tooltip label={p.status ? `${p.name} · ${p.status}` : p.name}>
            <span tabIndex={0} className={cn(FOCUS, "inline-flex rounded-full")}>
              {avatar}
            </span>
          </Tooltip>
        ) : (
          avatar
        )}
      </li>
    );
  };

  const more = rest_.length > 0 && (
    <li style={{ marginLeft: -overlap }} className="relative z-0 flex">
      {onOverflowClick ? (
        <OverflowButton px={px} count={rest_.length} onClick={onOverflowClick} />
      ) : (
        <PopoverPrimitive.Root>
          <PopoverPrimitive.Trigger asChild>
            <OverflowButton px={px} count={rest_.length} />
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={8}
              collisionPadding={8}
              style={{ zIndex: LAYER.popover, fontFamily: FONT_STACK }}
              className={cn(
                "w-60 rounded-[16px] bg-popover p-1.5 text-popover-foreground shadow-float ring-1 ring-border outline-none",
                "motion-safe:data-[state=open]:animate-pop-in",
                SQUIRCLE,
              )}
            >
              <p className="px-2 pt-1 pb-1.5 text-[11.5px] text-muted-foreground">
                {people.length} {label.toLowerCase()}
              </p>
              <ul className="max-h-64 overflow-y-auto">
                {people.map((p, i) => (
                  <li key={`${p.name}-${i}`} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5">
                    <UserAvatar {...p} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
                    {p.status && <span className="text-[11.5px] text-muted-foreground capitalize">{p.status}</span>}
                  </li>
                ))}
              </ul>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}
    </li>
  );

  const list = (
    <div ref={ref} {...rest} style={{ fontFamily: FONT_STACK, ...style }} className={cn("inline-flex", className)}>
      <ul aria-label={`${label}: ${people.length}`} className="flex items-center">
        {shown.map(face)}
        {more}
      </ul>
    </div>
  );
  return showTooltip ? <TooltipProvider>{list}</TooltipProvider> : list;
});

const OverflowButton = React.forwardRef<
  HTMLButtonElement,
  { px: number; count: number } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function OverflowButton({ px, count, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${count} more`}
      {...props}
      style={{ width: px, height: px, fontSize: Math.max(9, Math.round(px * 0.34)) }}
      className={cn(
        FOCUS,
        "grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-foreground/80 ring-2 ring-card tabular-nums transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      +{count}
    </button>
  );
});

export default AvatarStack;
