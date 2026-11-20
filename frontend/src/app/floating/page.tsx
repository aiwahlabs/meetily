"use client"

// AIWAH: the call pop-up window (its own frameless, always-on-top window, label "floating").
// Content only: the Rust side shows, hides and positions the window; this page reports its
// rendered size through floating.resize(). States: prompt | starting | recording | saved.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { Check, Loader2, MoreHorizontal, Square, AppWindow, BellOff } from "lucide-react"
import { Button, IconButton } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PlatformIcon } from "@/components/aiwah/PlatformIcon"
import { floating, type FloatingAction, type FloatingState } from "@/lib/aiwah/api"
import { cn } from "@/lib/utils"

const MARGIN = 8 // transparent margin around the card, for the shadow
const CARD = "relative overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-float"
// Extra room while the overflow menu is open, so the (portaled) menu is not clipped by the window.
const MENU_ROOM = 120

const act = (a: FloatingAction) => {
  floating.act(a).catch((e) => console.error("floating action failed", e))
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function formatElapsed(startedAt: string | null, now: number) {
  const t = startedAt ? Date.parse(startedAt) : NaN
  const s = Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`
}

function formatTime(iso: string | null) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/** Slide in from the right (200ms). Instant when the user prefers reduced motion. */
function SlideIn({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { x: 28, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: reduce ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** 2px hairline at the bottom of the card that shrinks until the pop-up expires. */
function Countdown({ expiresAt }: { expiresAt: string | null }) {
  const reduce = useReducedMotion()
  const [span] = useState(() => {
    const end = expiresAt ? Date.parse(expiresAt) : NaN
    return Number.isNaN(end) ? null : { end, total: Math.max(1, end - Date.now()) }
  })
  if (!span || reduce) return null
  const remaining = Math.max(0, span.end - Date.now())
  return (
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-transparent">
      <motion.div
        className="h-full bg-primary/50"
        initial={{ width: "100%" }}
        animate={{ width: "0%" }}
        transition={{ duration: remaining / 1000, ease: "linear" }}
      />
    </div>
  )
}

// ── prompt ─────────────────────────────────────────────────────────────────────

function Prompt({ s, onMenuOpen }: { s: FloatingState; onMenuOpen: (open: boolean) => void }) {
  const calendar = s.kind === "calendar"
  const canJoin = calendar && !!s.meetingUrl
  const primary: FloatingAction = canJoin ? "join" : "record"
  const primaryLabel = canJoin ? "Join & record" : "Start recording"
  const who = s.appName || s.platformLabel || "this app"
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        act("dismiss")
      } else if (e.key === "Enter") {
        const el = e.target as HTMLElement | null
        // Buttons and menu items handle Enter themselves.
        if (el && el.closest("button, [role=menuitem]")) return
        e.preventDefault()
        act(primary)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [primary])

  const time = formatTime(s.startsAt)
  const people = s.attendeeCount > 0 ? `${s.attendeeCount} ${s.attendeeCount === 1 ? "person" : "people"}` : null

  let sub: string
  if (calendar) {
    sub = [s.title, time, people].filter(Boolean).join(" · ")
  } else {
    sub = `${who} is using your microphone`
    if (s.title) sub += ` · ${s.title}`
  }

  return (
    <SlideIn>
      <div className={cn(CARD, "w-[360px]")} role="dialog" aria-label={s.headline ?? "Call detected"}>
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 w-[3px]", calendar && "bg-primary")}
          style={
            calendar
              ? undefined
              : {
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, var(--primary) 0 6px, transparent 6px 10px)",
                }
          }
        />
        <div className="px-4 pb-4 pl-5 pt-3.5">
          <div className="flex items-center gap-3">
            <PlatformIcon platform={s.platform} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-title font-semibold leading-tight">{s.headline ?? "Call detected"}</p>
              <p className="mt-0.5 truncate text-meta text-muted-foreground" title={sub}>
                {sub}
              </p>
            </div>
          </div>
          <div className="mt-3.5 flex items-center gap-2">
            <Button ref={primaryRef} size="sm" onClick={() => act(primary)}>
              {primaryLabel}
            </Button>
            {canJoin && (
              <Button size="sm" variant="outline" onClick={() => act("record")}>
                Record only
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => act("dismiss")}>
              Not now
            </Button>
            <div className="ml-auto">
              <DropdownMenu onOpenChange={onMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" label="More options">
                    <MoreHorizontal />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => act("mute_app")}>
                    <BellOff />
                    {`Don't ask for ${s.appName || s.platformLabel || "this app"}`}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => act("open")}>
                    <AppWindow />
                    Open Aiwah Minutes
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
        <Countdown key={s.expiresAt ?? "none"} expiresAt={s.expiresAt} />
      </div>
    </SlideIn>
  )
}

// ── starting ───────────────────────────────────────────────────────────────────

function Starting({ s }: { s: FloatingState }) {
  return (
    <SlideIn>
      <div className={cn(CARD, "flex w-[300px] items-center gap-3 px-4 py-3")} role="status">
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="text-body font-medium leading-tight">Starting recording…</p>
          {s.title && <p className="mt-0.5 truncate text-meta text-muted-foreground">{s.title}</p>}
        </div>
      </div>
    </SlideIn>
  )
}

// ── recording ──────────────────────────────────────────────────────────────────

function Recording({ s }: { s: FloatingState }) {
  const now = useNow(true)
  const started = s.startedAt ? Date.parse(s.startedAt) : NaN
  const early = !Number.isNaN(started) && now - started < 60_000
  const showConsent = s.consentReminder && early
  const showSource = s.source === "calendar" && early
  const title = s.title || s.platformLabel || "Recording"

  return (
    <SlideIn>
      <div className="w-[320px]">
        <div className={cn(CARD, "flex h-10 items-center gap-2.5 rounded-full p-1.5 pl-3.5")} role="status">
          <span className="relative flex size-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex size-full rounded-full bg-destructive opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
          </span>
          <span className="font-mono text-body font-semibold tabular-nums" aria-label="Recording time">
            {formatElapsed(s.startedAt, now)}
          </span>
          <PlatformIcon platform={s.platform} size={20} />
          <button
            type="button"
            onClick={() => act("open")}
            title={`${title} — open Aiwah Minutes`}
            className="min-w-0 flex-1 truncate rounded-md text-left text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </button>
          <button
            type="button"
            aria-label="Stop recording"
            onClick={() => act("stop")}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square className="size-2.5 fill-current" />
          </button>
        </div>
        {(showConsent || showSource) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="mt-1.5 rounded-xl border border-border bg-card px-3 py-1.5 shadow-float"
          >
            {showConsent && (
              <p className="text-meta font-medium text-warning">Let everyone know this call is recorded.</p>
            )}
            {showSource && <p className="text-meta text-muted-foreground">From your calendar</p>}
          </motion.div>
        )}
      </div>
    </SlideIn>
  )
}

// ── saved ──────────────────────────────────────────────────────────────────────

function Saved({ s }: { s: FloatingState }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        act("dismiss")
      } else if (e.key === "Enter") {
        if ((e.target as HTMLElement | null)?.closest("button")) return
        e.preventDefault()
        act("open_meeting")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <SlideIn>
      <div className={cn(CARD, "w-[360px] px-4 py-3.5")} role="status">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
            <Check className="size-[18px]" strokeWidth={2.4} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-title font-semibold leading-tight">Saved to Aiwah Minutes</p>
            {s.title && (
              <p className="mt-0.5 truncate text-meta text-muted-foreground" title={s.title}>
                {s.title}
              </p>
            )}
          </div>
        </div>
        <div className="mt-3.5 flex items-center gap-2">
          <Button size="sm" onClick={() => act("open_meeting")}>
            Open notes
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => act("dismiss")}>
            Close
          </Button>
        </div>
      </div>
    </SlideIn>
  )
}

// ── page ───────────────────────────────────────────────────────────────────────

export default function FloatingPage() {
  const [state, setState] = useState<FloatingState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    floating
      .state()
      .then((s) => alive && setState(s))
      .catch(() => {})
    const un = floating.onState((s) => setState(s))
    return () => {
      alive = false
      un.then((f) => f()).catch(() => {})
    }
  }, [])

  const mode = state?.mode ?? "hidden"
  const visible = mode !== "hidden"

  useEffect(() => {
    if (mode !== "prompt") setMenuOpen(false)
  }, [mode])

  // Report the rendered size to the native window.
  const lastSize = useRef("")
  const report = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = Math.ceil(r.width)
    const h = Math.ceil(r.height)
    const key = `${w}x${h}`
    if (w < 2 || h < 2 || key === lastSize.current) return
    lastSize.current = key
    floating.resize(w, h).catch(() => {})
  }, [])

  useLayoutEffect(() => {
    lastSize.current = ""
    const el = rootRef.current
    if (!el || !visible) return
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible, mode, report])

  if (!state || !visible) return null

  return (
    <div
      ref={rootRef}
      className="inline-block select-none"
      style={{ padding: MARGIN, paddingBottom: MARGIN + (menuOpen ? MENU_ROOM : 0) }}
    >
      {mode === "prompt" && <Prompt s={state} onMenuOpen={setMenuOpen} />}
      {mode === "starting" && <Starting s={state} />}
      {mode === "recording" && <Recording s={state} />}
      {mode === "saved" && <Saved s={state} />}
    </div>
  )
}
