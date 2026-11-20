'use client'

// AIWAH: calendar events grouped by day. Each row expands to show who is invited and who
// has replied. Used by the home "Coming up" card and the Calendar page.

import { useMemo, useState } from 'react'
import { Check, ChevronDown, CircleHelp, Crown, X } from 'lucide-react'
import { platformFromUrl, system, type CalendarEvent, type EventAttendee } from '@/lib/aiwah/api'
import { PlatformIcon } from '@/components/aiwah/PlatformIcon'
import { Avatar } from '@/components/ui/avatar'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(d: Date, now = new Date()) {
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const base = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })
  if (dayKey(d) === dayKey(now)) return `Today · ${base}`
  if (dayKey(d) === dayKey(tomorrow)) return `Tomorrow · ${base}`
  return base
}

const RESPONSE = {
  accepted: { icon: Check, label: 'Going', className: 'text-success' },
  declined: { icon: X, label: "Can't go", className: 'text-destructive' },
  tentative: { icon: CircleHelp, label: 'Maybe', className: 'text-warning' },
  needsAction: { icon: CircleHelp, label: 'No reply yet', className: 'text-muted-foreground' },
} as const

type ResponseKey = keyof typeof RESPONSE

function keyOf(a: EventAttendee): ResponseKey {
  return a.response && a.response in RESPONSE ? (a.response as ResponseKey) : 'needsAction'
}

function AttendeeList({ attendees }: { attendees: EventAttendee[] }) {
  if (attendees.length === 0) {
    return <p className="text-meta text-muted-foreground">No guests on this event.</p>
  }
  const counts: Record<string, number> = {}
  for (const a of attendees) counts[keyOf(a)] = (counts[keyOf(a)] ?? 0) + 1
  const summary = [
    counts.accepted ? `${counts.accepted} going` : null,
    counts.tentative ? `${counts.tentative} maybe` : null,
    counts.declined ? `${counts.declined} can't go` : null,
    counts.needsAction ? `${counts.needsAction} no reply` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div>
      <p className="mb-2 text-meta font-medium text-muted-foreground">
        {attendees.length} {attendees.length === 1 ? 'person' : 'people'} invited{summary ? ` · ${summary}` : ''}
      </p>
      <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {attendees.map((a) => {
          const r = RESPONSE[keyOf(a)]
          const Icon = r.icon
          return (
            <li key={a.email} className="flex min-w-0 items-center gap-2.5">
              <Avatar seed={a.email} name={a.name || a.email} size={26} fallback="initials" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-body text-foreground">
                  <span className="truncate">{a.name || a.email}</span>
                  {a.isSelf && <span className="text-meta text-muted-foreground">(you)</span>}
                  {a.isOrganizer && <Crown className="size-3 text-muted-foreground" aria-label="Organizer" />}
                </p>
                {a.name && <p className="truncate text-meta text-muted-foreground">{a.email}</p>}
              </div>
              <span className={cn('flex shrink-0 items-center gap-1 text-meta', r.className)} title={r.label}>
                <Icon className="size-3.5" aria-hidden />
                <span className="sr-only">{r.label}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EventRow({
  e,
  now,
  onRecord,
  defaultOpen,
}: {
  e: CalendarEvent
  now: number
  onRecord: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const start = new Date(e.start).getTime()
  const live = start <= now && new Date(e.end).getTime() > now
  const mins = Math.round((start - now) / 60_000)
  const soon = !live && mins >= 0 && mins <= 15
  const people = e.attendees.filter((a) => !a.isSelf)
  const stack = people.map((a) => ({ name: a.name || a.email }))
  const panelId = `ev-${e.id}`

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <PlatformIcon platform={platformFromUrl(e.meetingUrl) ?? 'other'} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-foreground">{e.title || 'Untitled event'}</p>
            <p className="flex items-center gap-2 text-meta text-muted-foreground">
              <span className="tabular-nums">
                {time(e.start)} – {time(e.end)}
              </span>
              {people.length > 0 && (
                <span>
                  · {people.length} {people.length === 1 ? 'guest' : 'guests'}
                </span>
              )}
              {live && (
                <Badge tone="success" size="sm" dot>
                  Now
                </Badge>
              )}
              {soon && (
                <Badge tone="primary" size="sm">
                  In {Math.max(mins, 1)} min
                </Badge>
              )}
            </p>
          </div>
          {stack.length > 0 && <AvatarStack people={stack} max={4} size="xs" label="Attendees" />}
          <ChevronDown
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180')}
          />
        </button>
        {e.meetingUrl ? (
          <Button
            size="sm"
            variant={live || soon ? 'primary' : 'outline'}
            onClick={() => {
              system.openUrl(e.meetingUrl!).catch(() => {})
              onRecord()
            }}
          >
            Join &amp; record
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRecord}>
            Record
          </Button>
        )}
      </div>
      {open && (
        <div id={panelId} className="mt-3 ml-11 rounded-lg bg-muted/50 p-3">
          <AttendeeList attendees={e.attendees} />
        </div>
      )}
    </li>
  )
}

export function ScheduleList({
  events,
  now,
  onRecord,
  expandFirst,
}: {
  events: CalendarEvent[]
  now: number
  onRecord: () => void
  /** Open the first event so the guest list is visible without a click. */
  expandFirst?: boolean
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { date: Date; items: CalendarEvent[] }>()
    for (const e of events) {
      const d = new Date(e.start)
      const k = dayKey(d)
      if (!map.has(k)) map.set(k, { date: d, items: [] })
      map.get(k)!.items.push(e)
    }
    return [...map.values()]
  }, [events])

  return (
    <div>
      {groups.map((g, gi) => (
        <section key={dayKey(g.date)} aria-label={dayLabel(g.date, new Date(now))}>
          <h3 className="border-y border-border bg-muted/40 px-4 py-1.5 text-meta font-medium text-muted-foreground first:border-t-0">
            {dayLabel(g.date, new Date(now))}
          </h3>
          <ul className="divide-y divide-border">
            {g.items.map((e, i) => (
              <EventRow key={e.id} e={e} now={now} onRecord={onRecord} defaultOpen={!!expandFirst && gi === 0 && i === 0} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
