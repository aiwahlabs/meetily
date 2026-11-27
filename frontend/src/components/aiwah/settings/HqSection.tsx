"use client"

import { useCallback, useEffect, useState } from "react"
import { CloudUpload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, PasswordInput } from "@/components/ui/input"
import { SettingsRow, SettingsSection } from "@/components/ui/settings-page"
import { Switch } from "@/components/ui/switch"
import { hq, type HqSettingsView } from "@/lib/aiwah/api"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** HQ connection form state. baseUrl / apiKey / projectId are saved together via the page save bar. */
export function useHqForm() {
  const [view, setView] = useState<HqSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [projectId, setProjectId] = useState("")

  const load = useCallback(async () => {
    try {
      const s = await hq.getSettings()
      setView(s)
      setBaseUrl(s.baseUrl)
      setProjectId(s.defaultProjectId ?? "")
      setApiKey("")
      setLoadError(null)
    } catch (e) {
      setLoadError(msg(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const dirty =
    view !== null &&
    (baseUrl.trim() !== view.baseUrl || projectId.trim() !== (view.defaultProjectId ?? "") || apiKey.trim() !== "")

  const save = async () => {
    try {
      const s = await hq.saveSettings({
        baseUrl: baseUrl.trim(),
        defaultProjectId: projectId.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setView(s)
      setBaseUrl(s.baseUrl)
      setProjectId(s.defaultProjectId ?? "")
      setApiKey("")
    } catch (e) {
      throw new Error(msg(e))
    }
  }

  const discard = () => {
    if (!view) return
    setBaseUrl(view.baseUrl)
    setProjectId(view.defaultProjectId ?? "")
    setApiKey("")
  }

  const setAutoSync = async (autoSync: boolean) => {
    const before = view
    if (!before) return
    setView({ ...before, autoSync })
    try {
      const s = await hq.saveSettings({ autoSync })
      setView((cur) => (cur ? { ...cur, autoSync: s.autoSync } : s))
    } catch (e) {
      setView((cur) => (cur ? { ...cur, autoSync: before.autoSync } : cur))
      toast.error(`Could not save: ${msg(e)}`)
    }
  }

  return { view, loadError, reload: load, baseUrl, setBaseUrl, apiKey, setApiKey, projectId, setProjectId, dirty, save, discard, setAutoSync }
}

export type HqForm = ReturnType<typeof useHqForm>

export function HqSection({ form }: { form: HqForm }) {
  const { view } = form
  const [syncing, setSyncing] = useState(false)

  const syncNow = async () => {
    setSyncing(true)
    try {
      const n = await hq.syncPending()
      toast.success(n > 0 ? `${n} meeting${n === 1 ? "" : "s"} sent` : "Nothing waiting to send")
    } catch (e) {
      toast.error(msg(e))
    } finally {
      setSyncing(false)
    }
  }

  if (!view) {
    return (
      <SettingsSection id="hq" title="HQ Workshop">
        <SettingsRow
          label={form.loadError ? "Could not load HQ settings" : "Loading…"}
          description={form.loadError ?? undefined}
        >
          {form.loadError && (
            <Button size="sm" variant="outline" onClick={form.reload}>
              Try again
            </Button>
          )}
        </SettingsRow>
      </SettingsSection>
    )
  }

  const connected = view.hasSession || view.hasApiKey

  const apiKeyRow = (
    <SettingsRow
      label="API key"
      htmlFor="hq-key"
      description={
        view.hasSession
          ? "Only used if your Google sign-in to HQ is not available. HQ Workshop → Settings → API keys."
          : "HQ Workshop → Settings → API keys. Stored only on this computer."
      }
      keywords={["token", "secret"]}
    >
      <PasswordInput
        id="hq-key"
        autoComplete="off"
        value={form.apiKey}
        onChange={(e) => form.setApiKey(e.target.value)}
        placeholder={view.hasApiKey ? "Paste a new key to replace" : "xchg_…"}
        className="w-full @min-[560px]:w-72"
      />
    </SettingsRow>
  )

  return (
    <SettingsSection
      id="hq"
      title="HQ Workshop"
      description="Every meeting is sent to Workshop → Meetings, where HQ writes the summary and action items."
    >
      <SettingsRow
        label="Connection"
        description={
          view.hasSession
            ? `Signed in to HQ as ${view.signedInEmail ?? view.userEmail ?? "your Google account"}`
            : view.hasApiKey
              ? `Connected${view.userEmail ? ` as ${view.userEmail}` : ""} · key ${view.apiKeyHint ?? ""}`
              : "Not connected. Sign in with Google in Account settings, or paste an HQ API key below."
        }
        keywords={["status", "hq", "workshop"]}
      >
        <Badge tone={connected ? "success" : "neutral"} size="sm" dot>
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </SettingsRow>
      <SettingsRow label="HQ URL" htmlFor="hq-url" description="Where your HQ runs." keywords={["server", "address", "base url"]}>
        <Input
          id="hq-url"
          value={form.baseUrl}
          onChange={(e) => form.setBaseUrl(e.target.value)}
          placeholder="https://hq-api.aiwahconnect.com"
          className="w-full @min-[560px]:w-72"
          spellCheck={false}
        />
      </SettingsRow>
      {view.hasSession ? (
        <details className="px-4 py-2" data-testid="hq-api-key-disclosure">
          <summary className="cursor-pointer text-sm text-muted-foreground">Use an API key instead</summary>
          {apiKeyRow}
        </details>
      ) : (
        apiKeyRow
      )}
      <SettingsRow
        label="Default project ID"
        htmlFor="hq-project"
        description="Optional. New meetings are linked to this HQ project."
        keywords={["project"]}
      >
        <Input
          id="hq-project"
          value={form.projectId}
          onChange={(e) => form.setProjectId(e.target.value)}
          placeholder="Project ID"
          className="w-full @min-[560px]:w-72"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Auto-sync meetings"
        htmlFor="hq-autosync"
        description="Sends each meeting to HQ when it is saved. Failed sends retry every 5 minutes."
        keywords={["sync", "upload"]}
      >
        <Switch id="hq-autosync" checked={view.autoSync} onCheckedChange={form.setAutoSync} />
      </SettingsRow>
      <SettingsRow label="Sync now" description="Send meetings that are still waiting." keywords={["upload", "send", "pending"]}>
        <Button size="sm" variant="outline" onClick={syncNow} loading={syncing} disabled={!connected}>
          {!syncing && <CloudUpload aria-hidden />}
          Sync now
        </Button>
      </SettingsRow>
    </SettingsSection>
  )
}
