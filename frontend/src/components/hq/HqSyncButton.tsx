"use client"

// AIWAH: per-meeting HQ sync status + actions (meeting details toolbar).

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { CheckCircle2, CloudUpload, AlertTriangle, Loader2, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MEETING_TYPES, PLATFORMS } from "@/lib/aiwah/api"
import { useSidebar } from "@/components/Sidebar/SidebarProvider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface SyncRecord {
  meetingId: string
  status: "pending" | "synced" | "failed" | "skipped"
  mode: "ingest" | "upload" | null
  language: string | null
  projectId: string | null
  leadId: string | null
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

interface HqTarget {
  id: string
  kind: "project" | "lead"
  label: string
}

// Folders and meeting types come from the shared contract.
const FOLDERS = PLATFORMS

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
  const { refetchMeetings } = useSidebar()

  const updateMeta = async (patch: { platform?: string; meetingType?: string }) => {
    try {
      await invoke("autorec_update_meeting_meta", { meetingId, ...patch })
      await refetchMeetings()
      toast.success(patch.platform ? "Moved to folder" : "Meeting type updated")
    } catch (e) {
      toast.error(String(e))
    }
  }
  const [targets, setTargets] = useState<HqTarget[] | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)

  // Projects and leads are fetched from HQ the first time the menu opens.
  const loadTargets = useCallback(async () => {
    if (targets) return
    try {
      setTargets(await invoke<HqTarget[]>("hq_list_targets"))
      setTargetsError(null)
    } catch (e) {
      setTargetsError(String(e))
    }
  }, [targets])

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

  const sync = async (language?: string, target?: HqTarget) => {
    setBusy(true)
    try {
      const status = await invoke<string>("hq_sync_meeting", {
        meetingId,
        language,
        projectId: target?.kind === "project" ? target.id : undefined,
        leadId: target?.kind === "lead" ? target.id : undefined,
        force: true,
      })
      if (status === "synced") toast.success(language ? "Recording sent to HQ for Sarvam transcription" : target ? `Meeting sent to HQ and tagged to ${target.label}` : "Meeting sent to HQ")
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
    : status === "synced" ? <CheckCircle2 className="text-success" />
    : status === "failed" ? <AlertTriangle className="text-warning" />
    : status === "pending" ? <Clock className="text-muted-foreground" />
    : <CloudUpload />
  const label = busy ? "Syncing" : status === "synced" ? "In HQ" : status === "failed" ? "Sync failed" : status === "pending" ? "Queued" : "Send to HQ"
  const title = record?.lastError
    ? `Last error: ${record.lastError}`
    : status === "synced"
      ? `Synced to HQ Workshop${record?.mode === "upload" ? " (Sarvam transcription)" : ""}`
      : "Send this meeting to HQ Workshop → Meetings"

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) loadTargets() }}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="px-2 @[22rem]:px-3 gap-1.5" title={title} disabled={busy}>
          {icon}
          <span className="hidden @[22rem]:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>HQ Workshop</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => sync()}>
          {status === "synced" ? "Send transcript again" : "Send transcript now"}
        </DropdownMenuItem>
        {(["project", "lead"] as const).map((kind) => {
          const items = (targets ?? []).filter((t) => t.kind === kind)
          const title = kind === "project" ? "Send to a project" : "Send to a lead"
          return (
            <DropdownMenuSub key={kind}>
              <DropdownMenuSubTrigger>{title}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 max-w-xs overflow-y-auto">
                {targets === null && !targetsError && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
                {targetsError && <DropdownMenuItem disabled title={targetsError}>Could not load from HQ</DropdownMenuItem>}
                {targets !== null && items.length === 0 && <DropdownMenuItem disabled>None available</DropdownMenuItem>}
                {items.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => sync(undefined, t)} className="truncate">{t.label}</DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {FOLDERS.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => updateMeta({ platform: f.id })}>{f.label}</DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Meeting type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {MEETING_TYPES.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => updateMeta({ meetingType: t.id })}>{t.label}</DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal">Transcribe the recording with Sarvam</DropdownMenuLabel>
        {SARVAM_LANGUAGES.map((l) => (
          <DropdownMenuItem key={l.code} onSelect={() => sync(l.code)}>{l.name}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
