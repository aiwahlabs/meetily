"use client"

// AIWAH: the Indian languages pack (IndicConformer) — download, languages spoken, and
// whether to detect the meeting language automatically.

import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { Check, Languages } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SettingsRow, SettingsSection } from "@/components/ui/settings-page"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  INDIC_LANGUAGES,
  INDIC_PROGRESS_EVENT,
  indicPack,
  type IndicPackStatus,
} from "@/lib/aiwah/api"
import type { AutoRecApi } from "./CallDetectionSection"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 1024 ** 3 ? 1 : 2)} GB`

/** Pack status plus download progress, shared by Settings and onboarding. */
export function useIndicPack() {
  const [status, setStatus] = useState<IndicPackStatus | null>(null)
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null)

  const refresh = useCallback(() => {
    indicPack
      .status()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
    let unlisten: (() => void) | undefined
    let cancelled = false
    listen<{ downloaded: number; total: number }>(INDIC_PROGRESS_EVENT, (e) => setProgress(e.payload))
      .then((u) => (cancelled ? u() : (unlisten = u)))
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [refresh])

  const download = useCallback(async () => {
    setProgress({ downloaded: 0, total: status?.downloadBytes ?? 0 })
    setStatus((s) => (s ? { ...s, downloading: true } : s))
    try {
      await indicPack.download()
      toast.success("Indian languages pack installed")
    } catch (e) {
      const m = msg(e)
      if (!/cancel/i.test(m)) toast.error(`Download failed: ${m}`)
    } finally {
      setProgress(null)
      refresh()
    }
  }, [refresh, status?.downloadBytes])

  const cancel = useCallback(() => {
    indicPack.cancel().catch(() => {})
  }, [])

  const remove = useCallback(async () => {
    try {
      setStatus(await indicPack.remove())
      toast.message("Indian languages pack removed")
    } catch (e) {
      toast.error(`Could not remove it: ${msg(e)}`)
    }
  }, [])

  return { status, progress, download, cancel, remove, refresh }
}

export function IndianLanguagesSection({ api }: { api: AutoRecApi }) {
  const { settings: s, patch } = api
  const pack = useIndicPack()
  const installed = !!pack.status?.installed
  const downloading = !!pack.status?.downloading || !!pack.progress

  const toggleLanguage = (code: string) => {
    if (!s) return
    const has = s.indicLanguages.includes(code)
    const next = has ? s.indicLanguages.filter((c) => c !== code) : [...s.indicLanguages, code]
    patch({ indicLanguages: next })
  }

  return (
    <SettingsSection
      id="indian-languages"
      title="Indian languages"
      description="Transcribe Malayalam, Tamil, Hindi and other Indian languages on this device with IndicConformer. English stays with the standard model."
    >
      <SettingsRow
        label="Indian languages pack"
        description={
          installed
            ? `Installed · ${gb(pack.status?.bytesOnDisk ?? 0)} on disk.`
            : `Download once, about ${gb(pack.status?.downloadBytes || 0.7 * 1024 ** 3)}. Without it, Indian-language meetings are transcribed by HQ instead.`
        }
        keywords={["malayalam", "tamil", "hindi", "indicconformer", "download", "model"]}
      >
        {downloading ? (
          <div className="flex w-56 flex-col gap-1.5">
            <Progress
              size="sm"
              label="Downloading"
              value={pack.progress?.total ? pack.progress.downloaded : null}
              max={pack.progress?.total || 1}
              formatValue={(v, max) => `${gb(v)} of ${gb(max)}`}
            />
            <Button size="sm" variant="ghost" onClick={pack.cancel}>
              Cancel
            </Button>
          </div>
        ) : installed ? (
          <Button size="sm" variant="outline" onClick={pack.remove}>
            Remove
          </Button>
        ) : (
          <Button size="sm" onClick={pack.download}>
            <Languages />
            Download
          </Button>
        )}
      </SettingsRow>

      {s && (
        <>
          <SettingsRow
            label="Detect the meeting language"
            htmlFor="detect-language"
            description={
              installed
                ? "After each meeting, check whether it was in English or one of your languages below, and transcribe it with the right model. The meeting language picker overrides this."
                : "Needs the Indian languages pack."
            }
            keywords={["auto", "language", "router"]}
          >
            <Switch
              id="detect-language"
              checked={s.detectLanguage && installed}
              disabled={!installed}
              onCheckedChange={(v) => patch({ detectLanguage: v })}
            />
          </SettingsRow>

          <div className="px-4 pb-4">
            <p className="mb-2 text-sm font-medium text-foreground">Languages you speak in meetings</p>
            <p className="mb-3 text-meta text-muted-foreground">
              Detection only chooses between English and these, which makes it more accurate.
            </p>
            <div role="group" aria-label="Languages you speak in meetings" className="flex flex-wrap gap-2">
              {INDIC_LANGUAGES.map((l) => {
                const on = s.indicLanguages.includes(l.code)
                return (
                  <button
                    key={l.code}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleLanguage(l.code)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                      on
                        ? "border-primary bg-accent text-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {on && <Check className="size-3.5 text-primary" aria-hidden />}
                    {l.name}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  )
}
