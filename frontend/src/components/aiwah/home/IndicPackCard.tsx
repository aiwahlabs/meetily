'use client'

// AIWAH: one-time offer on Home to install the Indian languages pack (IndicConformer).
// Hidden once installed or dismissed ("Not now" is remembered on this device).

import { useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useIndicPack } from '@/components/aiwah/settings/IndianLanguagesSection'

const DISMISS_KEY = 'aiwah.indicPackOffer.dismissed'
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

export function IndicPackCard() {
  const router = useRouter()
  const pack = useIndicPack()
  const [dismissed, setDismissed] = useState(true) // hidden until we know

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  const downloading = !!pack.status?.downloading || !!pack.progress
  if (!pack.status || pack.status.installed || (dismissed && !downloading)) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private window: the card just reappears next time */
    }
    setDismissed(true)
  }

  return (
    <section
      aria-labelledby="indic-offer"
      className="flex items-start gap-3.5 rounded-xl border border-border bg-card p-4"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
        <Languages className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="indic-offer" className="text-title font-semibold text-foreground">
          Transcribe Malayalam, Tamil, Hindi and more
        </h2>
        <p className="mt-1 text-body text-muted-foreground">
          Add the Indian languages pack to transcribe these meetings on this device. English stays as it is. One
          download of about {gb(pack.status.downloadBytes || 2.65 * 1024 ** 3)}; without it, HQ transcribes these
          meetings instead.
        </p>
        {downloading ? (
          <div className="mt-3 flex max-w-sm flex-col gap-2">
            <Progress
              size="sm"
              label="Downloading"
              value={pack.progress?.total ? pack.progress.downloaded : null}
              max={pack.progress?.total || 1}
              formatValue={(v, max) => `${gb(v)} of ${gb(max)}`}
            />
            <div>
              <Button size="sm" variant="ghost" onClick={pack.cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={pack.download}>
              Download
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => router.push('/settings#indian-languages')}>
              Choose languages
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
