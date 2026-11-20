"use client"

// AIWAH: meeting folders = call platforms (see autorec/meta.rs). Meetings without
// metadata count as "other".

import { useEffect, useState } from "react"
import { PLATFORMS, meetings as meetingsApi, type MeetingMeta, type Platform } from "@/lib/aiwah/api"

export function folderOf(meta: MeetingMeta | undefined): Platform {
  const p = meta?.platform
  return PLATFORMS.some((x) => x.id === p) ? (p as Platform) : "other"
}

export function folderLabel(p: Platform): string {
  return p === "other" ? "Other recordings" : (PLATFORMS.find((x) => x.id === p)?.label ?? "Other")
}

export function isPlatform(v: string | null | undefined): v is Platform {
  return PLATFORMS.some((x) => x.id === v)
}

/** Meeting metadata by meeting id; reloads whenever `refreshKey` changes. */
export function useMeetingMeta(refreshKey: unknown): Record<string, MeetingMeta> {
  const [meta, setMeta] = useState<Record<string, MeetingMeta>>({})
  useEffect(() => {
    let cancelled = false
    meetingsApi
      .meta()
      .then((rows) => {
        if (!cancelled) setMeta(Object.fromEntries(rows.map((r) => [r.meetingId, r])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey])
  return meta
}
