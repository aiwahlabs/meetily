'use client'

// AIWAH: "Recent meetings" card on the home screen.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { NotebookPen } from 'lucide-react'
import { meetings as meetingsApi, MEETING_TYPES, type MeetingMeta, type MeetingSummary } from '@/lib/aiwah/api'
import { PlatformIcon } from '@/components/aiwah/PlatformIcon'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-states'
import { Skeleton } from '@/components/ui/state'

function relative(iso?: string) {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const mins = Math.round(diff / 60_000)
  if (Math.abs(mins) < 60) return Math.abs(mins) < 1 ? 'Just now' : rtf.format(mins, 'minute')
  const hours = Math.round(mins / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function RecentMeetingsCard({ onRecord }: { onRecord: () => void }) {
  const router = useRouter()
  const [rows, setRows] = useState<MeetingSummary[] | null>(null)
  const [meta, setMeta] = useState<Record<string, MeetingMeta>>({})

  useEffect(() => {
    let cancelled = false
    meetingsApi
      .list()
      .then((r) => !cancelled && setRows(r))
      .catch(() => !cancelled && setRows([]))
    meetingsApi
      .meta()
      .then((m) => !cancelled && setMeta(Object.fromEntries(m.map((x) => [x.meetingId, x]))))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const recent = (rows ?? [])
    .slice()
    .sort((a, b) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0))
    .slice(0, 5)

  return (
    <section aria-labelledby="recent-meetings" className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
        <h2 id="recent-meetings" className="text-title font-semibold text-foreground">
          Recent meetings
        </h2>
        {recent.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => router.push('/meetings')}>
            View all
          </Button>
        )}
      </div>
      {rows === null ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-4/5" />
          <Skeleton className="h-9 w-3/5" />
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          size="sm"
          illustration={<NotebookPen className="size-8 text-muted-foreground" />}
          title="No meetings yet"
          description="Record a call and its transcript and notes will be kept here."
          primaryAction={{ label: 'New recording', onClick: onRecord }}
        />
      ) : (
        <ul className="px-2 pb-2">
          {recent.map((m) => {
            const mm = meta[m.id]
            const type = MEETING_TYPES.find((t) => t.id === mm?.meetingType)?.label
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/meeting-details?id=${m.id}`)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PlatformIcon platform={mm?.platform ?? 'other'} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">{m.title || 'Untitled meeting'}</span>
                    {type && <span className="block text-meta text-muted-foreground">{type}</span>}
                  </span>
                  <span className="shrink-0 text-meta text-muted-foreground">{relative(m.created_at)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
