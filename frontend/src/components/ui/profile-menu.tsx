"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Activity, ArrowLeft, Check, LayoutGrid, Loader2, LogOut, Moon, Plus, Settings } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.8,
} as const;

const SOFT = { type: "spring", stiffness: 300, damping: 30 } as const;

type ThemeSetting = "light" | "dark" | "system";

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

interface DismissOptions {
  /** Whether the surface is open and should listen. */
  active?: boolean;
  /** Close on Escape. Default true. */
  escapeKey?: boolean;
  /** Close on a pointer press outside the surface. Default true. */
  outsidePress?: boolean;
  /**
   * The trigger. Presses on it are ignored, so a click on an open toggle
   * closes it once via its own handler rather than closing and reopening.
   */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

const escapeLayers: object[] = [];

function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  {
    active = true,
    escapeKey = true,
    outsidePress = true,
    triggerRef,
  }: DismissOptions = {},
) {
  const handler = React.useRef(onDismiss);
  React.useEffect(() => {
    handler.current = onDismiss;
  });

  React.useEffect(() => {
    if (!active) return;
    const layer = {};
    if (escapeKey) escapeLayers.push(layer);

    function onKeyDown(e: KeyboardEvent) {
      if (!escapeKey || e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      if (escapeLayers[escapeLayers.length - 1] !== layer) return;
      e.preventDefault();
      handler.current();
    }

    function onPointerDown(e: PointerEvent) {
      if (!outsidePress) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      if (!document.body.contains(target)) return;
      handler.current();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      const at = escapeLayers.indexOf(layer);
      if (at !== -1) escapeLayers.splice(at, 1);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [active, escapeKey, outsidePress, ref, triggerRef]);
}

let locks = 0;
let restore: { overflow: string; paddingRight: string; rootOverflow: string } | null = null;

function useScrollLock(active = true) {
  React.useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined") return;

    if (locks === 0) {
      const body = document.body;
      restore = {
        overflow: body.style.overflow,
        paddingRight: body.style.paddingRight,
        rootOverflow: document.documentElement.style.overflow,
      };
      const gap = window.innerWidth - document.documentElement.clientWidth;
      if (gap > 0) {
        const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
        body.style.paddingRight = `${current + gap}px`;
      }
      body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    }
    locks += 1;

    return () => {
      locks -= 1;
      if (locks === 0 && restore) {
        document.body.style.overflow = restore.overflow;
        document.body.style.paddingRight = restore.paddingRight;
        document.documentElement.style.overflow = restore.rootOverflow;
        restore = null;
      }
    };
  }, [active]);
}

export interface ProfileUser {
  name: string;
  email: string;
  /** Shown after the name as "@handle". */
  handle?: string;
  /** A real photo. Without one, a drawn face from the email stands in. */
  avatarUrl?: string;
  /** Draws the verified tick on the photo. */
  verified?: boolean;
}

export interface ProfileAccount {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export type ProfileMenuItem = "activity" | "integrations" | "settings";

export interface ProfileMenuItemConfig {
  id: ProfileMenuItem | (string & {});
  label: string;
  icon?: React.ReactNode;
}

export interface ProfileMenuProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  user: ProfileUser;
  /** Replaces the avatar in the trigger and the header. */
  avatar?: React.ReactNode;
  /** The plan, as a pill in the header: "Pro". Leave out for none. */
  plan?: string;
  theme?: ThemeSetting;
  defaultTheme?: ThemeSetting;
  onThemeChange?: (theme: ThemeSetting) => void;
  /** Hide the Dark Mode row. */
  hideTheme?: boolean;
  /** The plain rows. Default Activity, Integrations, Settings. */
  items?: ProfileMenuItemConfig[];
  onNavigate?: (id: string) => void;
  /** Your other signed-in accounts, listed above Add Account. */
  accounts?: ProfileAccount[];
  /** May return a promise; the row waits for it and shows any error. */
  onSwitchAccount?: (id: string, account: ProfileAccount) => void | Promise<void>;
  /** Leave out to hide Add Account. */
  onAddAccount?: () => void;
  onSignOut?: () => void | Promise<void>;
  /** Leave out to hide "Sign out of all devices". */
  onSignOutEverywhere?: () => void | Promise<void>;
  /** What "all devices" covers, for its label and the consequence line. */
  sessions?: { count: number; devices?: number };
  /** Footer: "v.1.5.69". */
  version?: string;
  /** Footer link: Terms & Conditions. */
  legal?: { label: string; href: string };
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which edge of the trigger the panel lines up with. Default `end`. */
  align?: "start" | "end";
  /** `avatar` (default) is the round button; `full` adds the name and email, for a sidebar. */
  variant?: "avatar" | "full";
  /** The view it opens on first. Default `main`. */
  defaultView?: "main" | "signout";
}

const DEFAULT_ITEMS: ProfileMenuItemConfig[] = [
  { id: "activity", label: "Activity", icon: <Activity /> },
  { id: "integrations", label: "Integrations", icon: <LayoutGrid /> },
  { id: "settings", label: "Settings", icon: <Settings /> },
];

const PANEL_W = 360;
const EDGE_GAP = 12;

const errText = (e: unknown) => (e instanceof Error ? e.message : "That did not go through. Nothing was changed.");

export function everywhereConsequence(sessions?: { count: number; devices?: number }) {
  if (!sessions || sessions.count <= 1) return "Ends every session, including this one.";
  const d = sessions.devices && sessions.devices > 1 ? ` on ${sessions.devices} devices` : "";
  return `Ends ${sessions.count} sessions${d}, including this one.`;
}

export function everywhereLabel(sessions?: { count: number }) {
  return sessions && sessions.count > 1 ? `Sign out of all devices (${sessions.count} sessions)` : "Sign out of all devices";
}

function useHeight<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [h, setH] = React.useState<number | "auto">("auto");
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  });
  return [ref, h] as const;
}

function VerifiedTick({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="absolute -top-0.5 -right-0.5 grid place-items-center rounded-full bg-[#3b82f6] text-white ring-[2.5px] ring-card"
    >
      <Check strokeWidth={3.5} style={{ width: size * 0.58, height: size * 0.58 }} />
    </span>
  );
}

function SwitchLook({ on }: { on: boolean }) {
  const state = on ? "checked" : "unchecked";
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn(
        "pointer-events-none inline-flex shrink-0 items-center rounded-full transition-colors duration-150",
        "bg-foreground/15 data-[state=checked]:bg-primary",
        "h-6 w-10 p-[3px]",
      )}
    >
      <span
        data-state={state}
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-out",
          "dark:data-[state=checked]:bg-primary-foreground",
          "size-[18px] data-[state=checked]:translate-x-4",
        )}
      />
    </span>
  );
}

const ROW =
  "group/row flex min-h-11 w-full items-center gap-3 rounded-[14px] px-3 py-2 text-left text-[15px] text-foreground outline-none transition-colors duration-150 " +
  "hover:bg-muted/80 focus-visible:bg-muted/80 data-[busy]:cursor-progress disabled:opacity-50 " +
  "[&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-foreground/70 [&>svg]:[stroke-width:1.75]";

const Divider = () => <div role="separator" className="mx-3 my-1.5 border-t border-border/70" />;

export const ProfileMenu = React.forwardRef<HTMLDivElement, ProfileMenuProps>(function ProfileMenu(
  {
    user,
    avatar,
    plan,
    theme,
    defaultTheme = "light",
    onThemeChange,
    hideTheme,
    items = DEFAULT_ITEMS,
    onNavigate,
    accounts = [],
    onSwitchAccount,
    onAddAccount,
    onSignOut,
    onSignOutEverywhere,
    sessions,
    version,
    legal,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    align = "end",
    variant = "avatar",
    defaultView = "main",
    className,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  const id = React.useId();

  const [openInner, setOpenInner] = React.useState(defaultOpen);
  const open = openProp ?? openInner;
  const setOpen = React.useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOpenInner(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange],
  );
  const [themeInner, setThemeInner] = React.useState<ThemeSetting>(defaultTheme);
  const dark = (theme ?? themeInner) === "dark";

  const [view, setView] = React.useState<"main" | "signout">(defaultView);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [innerRef, height] = useHeight<HTMLDivElement>();

  const [nudge, setNudge] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const vw = document.documentElement.clientWidth;
      const w = Math.min(PANEL_W, vw - 2 * EDGE_GAP);
      if (align === "end") setNudge(Math.max(0, EDGE_GAP - (t.right - w)));
      else setNudge(Math.max(0, t.left + w - (vw - EDGE_GAP)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, align]);

  const close = React.useCallback(
    (focusTrigger = true) => {
      setOpen(false);
      if (focusTrigger) triggerRef.current?.focus();
    },
    [setOpen],
  );
  useDismiss(panelRef, () => close(false), { active: open && !busy, escapeKey: false, triggerRef });

  React.useEffect(() => {
    if (open) return;
    setView("main");
    setError(null);
  }, [open]);

  const items$ = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-mi]:not([disabled])") ?? []);
  const focusFirst = React.useRef<"first" | "last" | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      const list = items$();
      const target = focusFirst.current === "last" ? list[list.length - 1] : (list.find((el) => el.dataset.autofocus != null) ?? list[0]);
      target?.focus({ preventScroll: true });
      focusFirst.current = null;
    });
    return () => cancelAnimationFrame(t);
  }, [open, view]);

  const go = (v: typeof view) => {
    setError(null);
    setView(v);
  };

  const run = async (key: string, fn?: () => void | Promise<void>, after?: () => void) => {
    if (busy) return;
    setError(null);
    setBusy(key);
    try {
      await fn?.();
      setBusy(null);
      after?.();
    } catch (e) {
      setBusy(null);
      setError(errText(e));
    }
  };

  const toggleDark = () => {
    const next: ThemeSetting = dark ? "light" : "dark";
    if (theme === undefined) setThemeInner(next);
    onThemeChange?.(next);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const list = items$();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(at < 0 ? 0 : at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(at < 0 ? list.length - 1 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(list.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (busy) return;
      if (view !== "main") go("main");
      else close();
    } else if (e.key === "Tab") {
      if (!busy) close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      const from = at + 1;
      const order = [...list.slice(from), ...list.slice(0, from)];
      order.find((el) => (el.dataset.label ?? el.textContent ?? "").trim().toLowerCase().startsWith(k))?.focus();
    }
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusFirst.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  }

  const slide = (dir: 1 | -1) =>
    reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
      : { initial: { opacity: 0, x: 20 * dir }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 20 * dir } };

  const face = (size: number) => avatar ?? <Avatar seed={user.email} src={user.avatarUrl} name={user.name} size={size} />;

  const header = (
    <div className="flex items-center gap-3 px-3 pt-3 pb-3">
      <span aria-hidden className="relative shrink-0">
        {face(48)}
        {user.verified && <VerifiedTick size={18} />}
      </span>
      {user.verified && <span className="sr-only">Verified</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline gap-1.5 text-[16px] leading-6">
          <span className="min-w-[4ch] shrink truncate font-semibold tracking-[-0.01em] text-foreground" title={user.name}>
            {user.name}
          </span>
          {user.handle && <span className="min-w-0 shrink-[4] truncate text-muted-foreground">@{user.handle}</span>}
        </p>
        <p className="truncate text-[14px] leading-5 text-muted-foreground" title={user.email}>
          {user.email}
        </p>
      </div>
      {plan && (
        <span className="max-w-28 shrink-0 truncate rounded-full bg-success-soft px-2.5 py-1 text-[12px] leading-none font-semibold tracking-[0.04em] text-success uppercase dark:bg-success/18">
          {plan}
        </span>
      )}
    </div>
  );

  const mainView = (
    <motion.div key="main" {...slide(-1)} transition={reduce ? { duration: 0.12 } : SPRING} className="flex flex-col">
      {header}

      {!hideTheme && (
        <div
          role="menuitemcheckbox"
          aria-checked={dark}
          tabIndex={-1}
          data-mi=""
          data-label="Dark Mode"
          onClick={toggleDark}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleDark();
            }
          }}
          className={cn(ROW, "cursor-pointer")}
        >
          <Moon aria-hidden />
          <span className="min-w-0 flex-1 truncate">Dark Mode</span>
          <SwitchLook on={dark} />
        </div>
      )}

      <Divider />

      <div role="group" aria-label="Go to" className="flex flex-col">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            data-mi=""
            data-label={it.label}
            onClick={() => {
              onNavigate?.(it.id);
              close();
            }}
            className={ROW}
          >
            {it.icon}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
          </button>
        ))}
      </div>

      <Divider />

      <div role="group" aria-label="Accounts" className="flex flex-col">
        {accounts.map((a) => {
          const rowBusy = busy === `acc:${a.id}`;
          return (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              data-mi=""
              data-label={a.name}
              data-busy={rowBusy ? "" : undefined}
              aria-busy={rowBusy || undefined}
              aria-label={`Switch to ${a.name}, ${a.email}`}
              disabled={!!busy && !rowBusy}
              onClick={() => run(`acc:${a.id}`, () => onSwitchAccount?.(a.id, a), () => close(false))}
              className={ROW}
            >
              <Avatar seed={a.email} src={a.avatarUrl} name={a.name} size={28} className="-ml-[5px]" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">{a.name}</span>
                <span className="truncate text-[13px] text-muted-foreground">{a.email}</span>
              </span>
              {rowBusy && <Loader2 aria-hidden className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />}
            </button>
          );
        })}
        {onAddAccount && (
          <button
            type="button"
            role="menuitem"
            data-mi=""
            data-label="Add Account"
            onClick={() => {
              onAddAccount();
              close();
            }}
            className={ROW}
          >
            <Plus aria-hidden />
            <span className="min-w-0 flex-1 truncate">Add Account</span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          data-mi=""
          data-label="Logout"
          onClick={() => go("signout")}
          className={ROW}
        >
          <LogOut aria-hidden />
          <span className="min-w-0 flex-1 truncate">Logout</span>
        </button>
      </div>

      {(version || legal) && (
        <p className="flex min-w-0 items-center gap-1.5 px-3 pt-2.5 pb-2 text-[13px] text-muted-foreground">
          {version && <span className="shrink-0 tabular-nums">{version}</span>}
          {version && legal && <span aria-hidden>·</span>}
          {legal && (
            <a
              href={legal.href}
              role="menuitem"
              data-mi=""
              data-label={legal.label}
              className="truncate rounded-[6px] outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline"
            >
              {legal.label}
            </a>
          )}
        </p>
      )}
    </motion.div>
  );

  const everywhereText = everywhereConsequence(sessions);
  const signoutView = (
    <motion.div key="signout" {...slide(1)} transition={reduce ? { duration: 0.12 } : SPRING} className="flex flex-col px-1 pt-1 pb-1">
      <div className="flex items-start gap-2">
        <button
          type="button"
          role="menuitem"
          data-mi=""
          data-label="Back"
          aria-label="Back"
          disabled={!!busy}
          onClick={() => go("main")}
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted disabled:opacity-50"
        >
          <ArrowLeft aria-hidden className="size-[18px]" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-3 px-3 pt-1 pb-4 text-center">
        <span aria-hidden className="relative">
          {face(56)}
        </span>
        <div className="flex min-w-0 max-w-full flex-col gap-0.5">
          <p id={`${id}-so`} className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-foreground">
            Sign out?
          </p>
          <p className="truncate text-[14px] text-muted-foreground" title={user.email}>
            {user.email} on this device
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 px-2">
        <button
          type="button"
          role="menuitem"
          data-mi=""
          data-label="Sign out"
          data-autofocus=""
          aria-describedby={`${id}-so`}
          aria-busy={busy === "out" || undefined}
          disabled={!!busy && busy !== "out"}
          onClick={() => run("out", onSignOut, () => close(false))}
          className={cn(
            "inline-flex h-11 w-full items-center justify-center gap-2 rounded-[14px] bg-foreground text-[15px] font-medium text-background outline-none transition-[opacity,box-shadow] hover:opacity-90 disabled:opacity-50",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            busy === "out" && "cursor-progress",
          )}
        >
          {busy === "out" && <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
          {busy === "out" ? "Signing out…" : "Sign out"}
        </button>
        {onSignOutEverywhere && (
          <button
            type="button"
            role="menuitem"
            data-mi=""
            data-label={everywhereLabel(sessions)}
            aria-describedby={`${id}-everywhere`}
            aria-busy={busy === "all" || undefined}
            disabled={!!busy && busy !== "all"}
            onClick={() => run("all", onSignOutEverywhere, () => close(false))}
            className={cn(
              "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[14px] px-3 text-[14px] font-medium text-destructive outline-none transition-colors hover:bg-destructive-soft focus-visible:bg-destructive-soft disabled:opacity-50",
              busy === "all" && "cursor-progress",
            )}
          >
            {busy === "all" && <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />}
            <span className="min-w-0">{everywhereLabel(sessions)}</span>
          </button>
        )}
      </div>
      {onSignOutEverywhere && (
        <p id={`${id}-everywhere`} className="px-3 pt-0.5 pb-2 text-center text-[12.5px] leading-5 text-muted-foreground">
          {everywhereText}
        </p>
      )}
    </motion.div>
  );

  return (
    <div ref={ref} {...rest} className={cn("relative inline-flex", variant === "full" && "w-full", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={`Account: ${user.name}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKey}
        className={cn(
          "relative inline-flex items-center gap-2.5 outline-none transition-colors",
          variant === "full"
            ? cn("w-full rounded-[14px] px-2 py-1.5 text-left hover:bg-muted", FOCUS)
            : "rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        {face(34)}
        {variant === "full" && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sub font-medium text-foreground">{user.name}</span>
            <span className="truncate text-meta text-muted-foreground">{user.email}</span>
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            id={`${id}-menu`}
            role="menu"
            aria-label={`Account menu for ${user.name}`}
            onKeyDown={onKeyDown}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={reduce ? { duration: 0.12 } : SOFT}
            style={{
              transformOrigin: align === "end" ? "top right" : "top left",
              width: PANEL_W,
              maxWidth: `calc(100vw - ${2 * EDGE_GAP}px)`,
              ...(align === "end" ? { right: -nudge } : { left: -nudge }),
            }}
            className={cn(
              "absolute top-[calc(100%+10px)] z-[75] overflow-hidden rounded-3xl bg-card p-2 [corner-shape:squircle] ring-1 ring-black/[0.06] dark:ring-white/10",
              "shadow-[0_24px_48px_-16px_rgb(0_0_0/0.18),0_4px_12px_-4px_rgb(0_0_0/0.06)] dark:shadow-[0_24px_48px_-16px_rgb(0_0_0/0.6)]",
            )}
          >
            <motion.div animate={{ height }} transition={reduce ? { duration: 0 } : SOFT} className="overflow-hidden">
              <div ref={innerRef}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {view === "main" ? mainView : signoutView}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                  {error && (
                    <motion.p
                      role="alert"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="mx-1 mt-1 mb-1 rounded-[14px] bg-destructive-soft px-3.5 py-2.5 text-[13px] leading-5 text-destructive"
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export default ProfileMenu;
