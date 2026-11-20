'use client'

// AIWAH: "Coming up" card on the home screen: the next 7 days of calendar events, grouped by day.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays } from 'lucide-react'
import { calendar, type CalendarEvent } from '@/lib/aiwah/api'
import { ScheduleList } from '@/components/aiwah/calendar/ScheduleList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-states'
import { Skeleton } from '@/components/ui/state'

const HOME_DAYS = 7
const HOME_MAX_EVENTS = 8

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
      .upcoming(HOME_DAYS * 24)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  const upcoming = (events ?? [])
    .filter((e) => new Date(e.end).getTime() > now)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))
  const shown = upcoming.slice(0, HOME_MAX_EVENTS)
  const hidden = upcoming.length - shown.length

  return (
    <section aria-labelledby="coming-up" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5">
        <h2 id="coming-up" className="text-title font-semibold text-foreground">
          Coming up
        </h2>
        {!failed && events !== null && upcoming.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => router.push('/calendar')}>
            {hidden > 0 ? `See all ${upcoming.length}` : 'Open calendar'}
          </Button>
        )}
      </div>
      {failed ? (
        <EmptyState
          size="sm"
          illustration={<CalendarDays className="size-8 text-muted-foreground" />}
          title="Calendar isn't connected"
          description="Sign in with Google to see your meetings here and get a reminder before they start."
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
          title="Nothing scheduled this week"
          description="Meetings on your Google Calendar will appear here."
        />
      ) : (
        <ScheduleList events={shown} now={now} onRecord={onRecord} />
      )}
    </section>
  )
}
