'use client'

// AIWAH: follow the language routing of a just-saved meeting. While the recording is being
// checked for an Indian language (and re-transcribed by IndicConformer), the meeting page
// waits before it writes the summary, then reloads the transcript.

import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ROUTING_EVENT, transcriptInfo, type RoutingState } from '@/lib/aiwah/api'

const BUSY = new Set(['pending', 'detecting', 'transcribing'])

export function useLanguageRouting(meetingId: string | undefined, onFinished?: (s: RoutingState) => void) {
  const [state, setState] = useState<RoutingState | null>(null)
  const [checked, setChecked] = useState(false)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  useEffect(() => {
    if (!meetingId) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    let wasBusy = false

    const apply = (s: RoutingState | null) => {
      if (cancelled) return
      setState(s)
      if (s && BUSY.has(s.state)) wasBusy = true
      else if (s && wasBusy) {
        wasBusy = false
        finishedRef.current?.(s)
      }
    }

    listen<RoutingState>(ROUTING_EVENT, (e) => {
      if (e.payload.meetingId === meetingId) apply(e.payload)
    })
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch(() => {})

    transcriptInfo
      .routingState(meetingId)
      .then(apply)
      .catch(() => {})
      .finally(() => !cancelled && setChecked(true))

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [meetingId])

  const busy = !!state && BUSY.has(state.state)
  return { state, busy, ready: checked && !busy }
}
