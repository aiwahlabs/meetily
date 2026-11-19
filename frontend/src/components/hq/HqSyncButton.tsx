"use client"

// AIWAH: per-meeting HQ sync status + actions (meeting details toolbar).

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { CheckCircle2, CloudUpload, AlertTriangle, Loader2, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface SyncRecord {
  meetingId: string
  status: "pending" | "synced" | "failed" | "skipped"
  mode: "ingest" | "upload" | null
  language: string | null
  hqMeetingId: string | null
  attempts: number
  lastError: string | null
}

interface SyncEvent {
  meetingId: string
  status: string
  hqMeetingId: string | null
  error: string | null
}

const SARVAM_LANGUAGES = [
  { code: "ml", name: "Malayalam" },
  { code: "ta", name: "Tamil" },
  { code: "hi", name: "Hindi" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
]

export function HqSyncButton({ meetingId }: { meetingId: string }) {
  const [record, setRecord] = useState<SyncRecord | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const rows = await invoke<SyncRecord[]>("hq_get_sync_status", { meetingIds: [meetingId] })
      setRecord(rows[0] ?? null)
    } catch {
      setRecord(null)
    }
  }, [meetingId])

  useEffect(() => {
    refresh()
    const unlisten = listen<SyncEvent>("hq-sync-status", (event) => {
      if (event.payload.meetingId !== meetingId) return
      if (event.payload.status === "syncing") setBusy(true)
      else {
        setBusy(false)
        refresh()
      }
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [meetingId, refresh])

  const sync = async (language?: string) => {
    setBusy(true)
    try {
      const status = await invoke<string>("hq_sync_meeting", { meetingId, language, force: true })
      if (status === "synced") toast.success(language ? "Recording sent to HQ for Sarvam transcription" : "Meeting sent to HQ")
      else if (status === "pending") toast.message("Queued: connect HQ in Settings → HQ to send it")
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const status = record?.status
  const icon = busy ? <Loader2 className="animate-spin" />
    : status === "synced" ? <CheckCircle2 className="text-emerald-600" />
    : status === "failed" ? <AlertTriangle className="text-amber-600" />
    : status === "pending" ? <Clock className="text-gray-500" />
    : <CloudUpload />
  const label = busy ? "Syncing" : status === "synced" ? "In HQ" : status === "failed" ? "Sync failed" : status === "pending" ? "Queued" : "Send to HQ"
  const title = record?.lastError
    ? `Last error: ${record.lastError}`
    : status === "synced"
      ? `Synced to HQ Workshop${record?.mode === "upload" ? " (Sarvam transcription)" : ""}`
      : "Send this meeting to HQ Workshop → Meetings"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="px-2 @[22rem]:px-3" title={title} disabled={busy}>
          {icon}
          <span className="hidden @[22rem]:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>HQ Workshop</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => sync()}>
          {status === "synced" ? "Send transcript again" : "Send transcript now"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-gray-500">Transcribe the recording with Sarvam</DropdownMenuLabel>
        {SARVAM_LANGUAGES.map((l) => (
          <DropdownMenuItem key={l.code} onClick={() => sync(l.code)}>{l.name}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
