"use client"

// AIWAH: Settings → HQ. Connects Aiwah Minutes to HQ Workshop so every meeting
// lands in Workshop → Meetings.

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { CheckCircle2, CloudUpload, Loader2, Building2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

export interface HqSettingsView {
  baseUrl: string
  hasApiKey: boolean
  apiKeyHint: string | null
  autoSync: boolean
  defaultProjectId: string | null
  userEmail: string | null
  userName: string | null
}

export function HqSettings() {
  const [settings, setSettings] = useState<HqSettingsView | null>(null)
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [projectId, setProjectId] = useState("")
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await invoke<HqSettingsView>("hq_get_settings")
      setSettings(s)
      setBaseUrl(s.baseUrl)
      setProjectId(s.defaultProjectId ?? "")
    } catch (e) {
      toast.error(`Could not load HQ settings: ${e}`)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (patch: Partial<{ apiKey: string; autoSync: boolean }> = {}) => {
    setSaving(true)
    try {
      const s = await invoke<HqSettingsView>("hq_save_settings", {
        settings: {
          baseUrl,
          defaultProjectId: projectId,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...patch,
        },
      })
      setSettings(s)
      setApiKey("")
      toast.success(s.hasApiKey ? `Connected to HQ${s.userEmail ? ` as ${s.userEmail}` : ""}` : "HQ settings saved")
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = () => save({ apiKey: "" })

  const syncNow = async () => {
    setSyncing(true)
    try {
      const n = await invoke<number>("hq_sync_pending")
      toast.success(n > 0 ? `Synced ${n} meeting${n === 1 ? "" : "s"} to HQ` : "Nothing waiting to sync")
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSyncing(false)
    }
  }

  if (!settings) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 p-6"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }

  return (
    <div className="space-y-6 mt-6">
      <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
        <Building2 className="h-5 w-5 text-emerald-700 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-emerald-900">
          <p className="font-medium">HQ Workshop</p>
          <p className="mt-1">
            Every meeting you record is sent to <b>Workshop → Meetings</b>, where HQ writes the summary and action items.
            English is transcribed on this device. When the meeting language is Malayalam, Tamil, Hindi or another Indian
            language, the recording is sent to HQ and transcribed with Sarvam.
          </p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Connection</h3>
            {settings.hasApiKey ? (
              <p className="text-sm text-emerald-700 flex items-center gap-1 mt-1">
                <CheckCircle2 className="h-4 w-4" />
                Connected{settings.userEmail ? ` as ${settings.userEmail}` : ""} · key {settings.apiKeyHint}
              </p>
            ) : (
              <p className="text-sm text-gray-500 mt-1">Not connected</p>
            )}
          </div>
          {settings.hasApiKey && (
            <Button variant="outline" onClick={disconnect} disabled={saving}>Disconnect</Button>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">HQ API URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://hq-api.aiwahconnect.com" />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">
            {settings.hasApiKey ? "Replace API key" : "Your HQ API key"}
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="xchg_…  (HQ Workshop → Settings → API keys)"
          />
          <span className="text-xs text-gray-500">Stored only on this computer and sent only to your HQ.</span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Default HQ project ID (optional)</span>
          <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Link new meetings to this project" />
        </label>

        <div className="flex gap-3">
          <Button onClick={() => save()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {apiKey.trim() ? "Connect" : "Save"}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Sync meetings automatically</h3>
          <p className="text-sm text-gray-500 mt-1">Send each meeting to HQ when it is saved. Failed syncs retry every 5 minutes.</p>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={syncNow} disabled={syncing || !settings.hasApiKey}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CloudUpload className="h-4 w-4 mr-2" />}
            Sync now
          </Button>
          <Switch checked={settings.autoSync} onCheckedChange={(v) => save({ autoSync: v })} />
        </div>
      </div>
    </div>
  )
}
