"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSection } from "@/components/ui/settings-page"
import { Switch } from "@/components/ui/switch"
import { TagInput } from "@/components/ui/tag-input"
import { autorec, platformLabel, type AutoRecSettings, type DetectionReport } from "@/lib/aiwah/api"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const toTags = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

/** Loads the auto-record settings; `patch` saves immediately, optimistic, reverting on error. */
export function useAutoRec() {
  const [settings, setSettings] = useState<AutoRecSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef<AutoRecSettings | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const load = useCallback(async () => {
    try {
      const s = await autorec.getSettings()
      current.current = s
      setSettings(s)
      setError(null)
    } catch (e) {
      setError(msg(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const patch = useCallback((p: Partial<AutoRecSettings>) => {
    const before = current.current
    if (!before) return
    const next = { ...before, ...p }
    current.current = next
    setSettings(next)
    // Serialise saves so quick successive toggles do not overwrite each other.
    queue.current = queue.current.then(async () => {
      try {
        const saved = await autorec.saveSettings({ ...(current.current ?? next), ...p })
        current.current = saved
        setSettings(saved)
      } catch (e) {
        const reverted = { ...(current.current ?? before) }
        for (const k of Object.keys(p) as (keyof AutoRecSettings)[]) {
          ;(reverted as Record<string, unknown>)[k] = before[k]
        }
        current.current = reverted
        setSettings(reverted)
        toast.error(`Could not save: ${msg(e)}`)
      }
    })
  }, [])

  return { settings, error, reload: load, patch }
}

export type AutoRecApi = ReturnType<typeof useAutoRec>

function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  keywords,
}: {
  id: string
  label: string
  description: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  keywords?: string[]
}) {
  return (
    <SettingsRow label={label} description={description} htmlFor={id} keywords={keywords}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingsRow>
  )
}

function Loading({ id, title, error, onRetry }: { id: string; title: string; error: string | null; onRetry: () => void }) {
  return (
    <SettingsSection id={id} title={title}>
      <SettingsRow label={error ? "Could not load these settings" : "Loading…"} description={error ?? undefined}>
        {error && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  )
}

export function CallDetectionSection({ api }: { api: AutoRecApi }) {
  const { settings: s, patch } = api
  const [testing, setTesting] = useState(false)
  const [report, setReport] = useState<DetectionReport | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const apps = useMemo(() => toTags(s?.excludedApps ?? ""), [s?.excludedApps])

  if (!s) return <Loading id="call-detection" title="Call detection" error={api.error} onRetry={api.reload} />

  const test = async () => {
    setTesting(true)
    setTestError(null)
    try {
      setReport(await autorec.detectNow())
    } catch (e) {
      setReport(null)
      setTestError(msg(e))
    } finally {
      setTesting(false)
    }
  }

  let result: string | null = null
  if (testError) result = testError
  else if (report) {
    if (report.detected) {
      result = `Detected ${platformLabel(report.detected.platform)} in ${report.detected.appName}.`
    } else if (report.micUsers.length > 0) {
      result = `Microphone in use by ${report.micUsers.map((u) => u.displayName).join(", ")}.`
    } else {
      result = "No other app is using the microphone."
    }
    if (!report.perAppSupported) {
      result += " On macOS Aiwah Minutes can tell the microphone is in use, but not which app."
    }
  }

  return (
    <SettingsSection
      id="call-detection"
      title="Call detection"
      description="How Aiwah Minutes notices calls. Changes save as you make them."
    >
      <SwitchRow
        id="ar-prompt"
        label="Ask me when a call starts"
        description="Shows a pop-up when Slack, WhatsApp, Zoom, Teams, Meet or another app turns on the microphone."
        checked={s.promptOnMic}
        onChange={(v) => patch({ promptOnMic: v })}
        keywords={["microphone", "mic", "prompt", "popup"]}
      />
      <SwitchRow
        id="ar-notify"
        label="Remind me 1 minute before calendar meetings"
        description="Shows a pop-up with a Join and record button for meetings that have a video link."
        checked={s.notifyCalendar}
        onChange={(v) => patch({ notifyCalendar: v })}
        keywords={["calendar", "reminder", "notify"]}
      />
      <SwitchRow
        id="ar-meet"
        label="Record every Google Meet call automatically"
        description="While you are signed in with your company Google account, a Meet call is recorded and sent to HQ without asking. Meetings with a private-sounding title and apps you excluded are skipped."
        checked={s.autoRecordMeet}
        onChange={(v) => patch({ autoRecordMeet: v })}
        keywords={["auto", "meet", "google meet", "record"]}
      />
      <SwitchRow
        id="ar-auto"
        label="Record Google Meet calendar meetings automatically"
        description="Starts without asking. The recording pill still shows, and you must tell participants the call is recorded."
        checked={s.autoRecordCalendar}
        onChange={(v) => patch({ autoRecordCalendar: v })}
        keywords={["auto", "meet", "calendar"]}
      />
      <SwitchRow
        id="ar-stop"
        label="Stop when the call ends"
        description="Stops a detected call's recording shortly after the app releases the microphone."
        checked={s.autoStop}
        onChange={(v) => patch({ autoStop: v })}
        keywords={["auto stop", "end"]}
      />
      <SwitchRow
        id="ar-pill"
        label="Show the recording pill"
        description="A small Recording indicator when Aiwah Minutes is not in front."
        checked={s.showRecordingPill}
        onChange={(v) => patch({ showRecordingPill: v })}
        keywords={["floating", "indicator"]}
      />
      <SwitchRow
        id="ar-login"
        label="Start Aiwah Minutes when I sign in"
        description="Opens quietly in the tray so calls are detected without launching it by hand."
        checked={s.startAtLogin}
        onChange={(v) => patch({ startAtLogin: v })}
        keywords={["startup", "login", "tray", "boot"]}
      />
      <SettingsRow
        label="Test detection"
        description={
          <span role="status" aria-live="polite">
            {result ?? "Start a call in another app, then check what Aiwah Minutes sees."}
          </span>
        }
        keywords={["detect", "check"]}
      >
        <Button size="sm" variant="outline" onClick={test} loading={testing}>
          Test detection
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Never ask for these apps"
        description="No pop-up when one of these apps uses the microphone."
        keywords={["exclude", "ignore", "apps", "block"]}
        className="@min-[560px]:items-start"
      >
        <TagInput
          label="Apps to ignore"
          placeholder="e.g. Discord"
          value={apps}
          onChange={(v) => patch({ excludedApps: v.join(", ") })}
          className="w-full @min-[560px]:w-80"
        />
      </SettingsRow>
    </SettingsSection>
  )
}

export function PrivacySection({ api }: { api: AutoRecApi }) {
  const { settings: s, patch } = api
  const keywords = useMemo(() => toTags(s?.excludedKeywords ?? ""), [s?.excludedKeywords])

  if (!s) return <Loading id="privacy" title="Privacy" error={api.error} onRetry={api.reload} />

  return (
    <SettingsSection id="privacy" title="Privacy" description="What you are reminded about and what is kept.">
      <SwitchRow
        id="pv-consent"
        label="Consent reminder"
        description="Reminds you to tell everyone on the call that it is recorded."
        checked={s.consentReminder}
        onChange={(v) => patch({ consentReminder: v })}
        keywords={["consent", "recorded", "notice"]}
      />
      <SwitchRow
        id="pv-delete"
        label="Delete local audio after it reaches HQ"
        description="Keeps the transcript, removes the recording file from this computer."
        checked={s.deleteAudioAfterSync}
        onChange={(v) => patch({ deleteAudioAfterSync: v })}
        keywords={["audio", "storage", "remove"]}
      />
      <SettingsRow
        label="Never record events containing"
        description="Calendar events with these words in the title are skipped."
        keywords={["exclude", "keywords", "private", "personal"]}
        className="@min-[560px]:items-start"
      >
        <TagInput
          label="Words in the event title"
          placeholder="e.g. personal"
          value={keywords}
          onChange={(v) => patch({ excludedKeywords: v.join(", ") })}
          className="w-full @min-[560px]:w-80"
        />
      </SettingsRow>
    </SettingsSection>
  )
}
