'use client'

// AIWAH: "Coming up" card on the home screen: today's calendar events.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays } from 'lucide-react'
import { calendar, platformFromUrl, type CalendarEvent, system } from '@/lib/aiwah/api'
import { PlatformIcon } from '@/components/aiwah/PlatformIcon'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-states'
import { Skeleton } from '@/components/ui/state'

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function UpcomingCard({ onRecord }: { onRecord: () => void }) {
  const router = useRouter()
  const now = useNow()
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    calendar
      .upcoming(12)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  const upcoming = (events ?? [])
    .filter((e) => new Date(e.end).getTime() > now)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))

  return (
    <section aria-labelledby="coming-up" className="rounded-xl border border-border bg-card">
      <h2 id="coming-up" className="px-4 pt-3.5 pb-1 text-title font-semibold text-foreground">
        Coming up
      </h2>
      {failed ? (
        <EmptyState
          size="sm"
          illustration={<CalendarDays className="size-8 text-muted-foreground" />}
          title="Calendar isn't connected"
          description="Sign in with Google to see today's meetings here and get a reminder before they start."
          secondaryAction={{ label: 'Open settings', onClick: () => router.push('/settings') }}
        />
      ) : events === null ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-4/5" />
        </div>
      ) : upcoming.length === 0 ? (
        <EmptyState
          size="sm"
          illustration={<CalendarDays className="size-8 text-muted-foreground" />}
          title="Nothing else today"
          description="Meetings with a video link will appear here."
        />
      ) : (
        <ul className="divide-y divide-border">
          {upcoming.map((e) => {
            const start = new Date(e.start).getTime()
            const live = start <= now
            const mins = Math.round((start - now) / 60_000)
            const soon = !live && mins <= 15
            const people = e.attendees
              .filter((a) => !a.isSelf)
              .map((a) => ({ name: a.name || a.email }))
            return (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                <PlatformIcon platform={platformFromUrl(e.meetingUrl) ?? 'other'} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-foreground">{e.title || 'Untitled event'}</p>
                  <p className="flex items-center gap-2 text-meta text-muted-foreground">
                    <span className="tabular-nums">
                      {time(e.start)} – {time(e.end)}
                    </span>
                    {live && <Badge tone="success" size="sm" dot>Now</Badge>}
                    {soon && <Badge tone="primary" size="sm">In {Math.max(mins, 1)} min</Badge>}
                  </p>
                </div>
                {people.length > 0 && <AvatarStack people={people} max={3} size="xs" label="Attendees" />}
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
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
