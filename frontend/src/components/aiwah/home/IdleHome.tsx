'use client'

// AIWAH: the home screen when nothing is being recorded.

import { useEffect, useState } from 'react'
import { autorec } from '@/lib/aiwah/api'
import { firstName, useAccountStatus } from '@/components/aiwah/useAccountStatus'
import { UpcomingCard } from './UpcomingCard'
import { RecentMeetingsCard } from './RecentMeetingsCard'
import { IndicPackCard } from './IndicPackCard'

function greeting(hour: number) {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function IdleHome({
  onRecord,
  banner,
}: {
  onRecord: () => void
  /** Optional element above the cards, e.g. a permission warning. */
  banner?: React.ReactNode
}) {
  const { status } = useAccountStatus()
  const [listening, setListening] = useState(true)

  useEffect(() => {
    autorec
      .getSettings()
      .then((s) => setListening(s.promptOnMic || s.notifyCalendar))
      .catch(() => {})
  }, [])

  const name = firstName(status?.name, status?.email)

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-12">
        <header>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
            {greeting(new Date().getHours())}
            {name ? `, ${name}` : ''}
          </h1>
          <p className="mt-2 flex items-center gap-2 text-sub text-muted-foreground">
            <span
              aria-hidden
              className={`size-2 rounded-full ${listening ? 'bg-primary' : 'bg-muted-foreground/50'}`}
            />
            {listening ? "Listening for calls — we'll ask before recording" : 'Call detection is off. Turn it on in Settings.'}
          </p>
        </header>
        {banner}
        <IndicPackCard />
        <UpcomingCard onRecord={onRecord} />
        <RecentMeetingsCard onRecord={onRecord} />
      </div>
    </div>
  )
}
