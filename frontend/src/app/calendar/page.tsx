'use client'

// AIWAH: every scheduled meeting for the next 30 days with the people invited.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, RefreshCw } from 'lucide-react'
import { calendar, type CalendarEvent } from '@/lib/aiwah/api'
import { ScheduleList } from '@/components/aiwah/calendar/ScheduleList'
import { useSidebar } from '@/components/Sidebar/SidebarProvider'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-states'
import { Skeleton } from '@/components/ui/state'
import { SegmentedControl } from '@/components/ui/segmented-control'

type Range = '7' | '14' | '30'
const RANGES: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '14', label: '2 weeks' },
  { value: '30', label: '30 days' },
]

export default function CalendarPage() {
  const router = useRouter()
  const { handleRecordingToggle } = useSidebar()
  const [days, setDays] = useState<Range>('30')
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(() => {
    setFailed(false)
    calendar
      .upcoming(Number(days) * 24)
      .then((e) => {
        setEvents(e)
        setNow(Date.now())
      })
      .catch(() => setFailed(true))
  }, [days])

  useEffect(() => {
    setEvents(null)
    load()
  }, [load])

  const list = (events ?? [])
    .filter((e) => new Date(e.end).getTime() > now)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-12">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Calendar</h1>
            <p className="mt-1.5 text-sub text-muted-foreground">
              Your meetings and who is invited. Open one to see replies.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl label="Range" value={days} onChange={setDays} options={RANGES} />
            <Button variant="ghost" size="sm" onClick={load} aria-label="Refresh calendar">
              <RefreshCw />
            </Button>
          </div>
        </header>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          {failed ? (
            <EmptyState
              size="sm"
              illustration={<CalendarDays className="size-8 text-muted-foreground" />}
              title="Calendar isn't connected"
              description="Sign in with Google to see your meetings here."
              secondaryAction={{ label: 'Open settings', onClick: () => router.push('/settings') }}
            />
          ) : events === null ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-9 w-3/5" />
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              size="sm"
              illustration={<CalendarDays className="size-8 text-muted-foreground" />}
              title="No meetings in this range"
              description="Events with a time on your Google Calendar show up here."
            />
          ) : (
            <ScheduleList events={list} now={now} onRecord={handleRecordingToggle} expandFirst />
          )}
        </section>
      </div>
    </div>
  )
}
