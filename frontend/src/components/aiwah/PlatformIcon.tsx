// AIWAH: one visual for each call platform, used by the pop-up, sidebar and lists.
// Colour tiles with a matching glyph (no third-party logos are bundled).

import { Hash, Mic, Phone, Users, Video } from "lucide-react"
import type { Platform } from "@/lib/aiwah/api"
import { cn } from "@/lib/utils"

const STYLE: Record<Platform, { bg: string; fg: string; Icon: typeof Video; label: string }> = {
  google_meet: { bg: "#E6F4EA", fg: "#0F9D58", Icon: Video, label: "Google Meet" },
  zoom: { bg: "#E8F0FE", fg: "#2D8CFF", Icon: Video, label: "Zoom" },
  teams: { bg: "#EEEBFA", fg: "#5B5FC7", Icon: Users, label: "Microsoft Teams" },
  slack: { bg: "#F4EAF3", fg: "#611F69", Icon: Hash, label: "Slack" },
  whatsapp: { bg: "#E7F8EE", fg: "#1DA851", Icon: Phone, label: "WhatsApp" },
  other: { bg: "#E0F7F3", fg: "#007A66", Icon: Mic, label: "Call" },
}

export function platformStyle(p: Platform | string | null | undefined) {
  return STYLE[(p as Platform) in STYLE ? (p as Platform) : "other"]
}

export function PlatformIcon({
  platform,
  size = 28,
  className,
}: {
  platform: Platform | string | null | undefined
  /** Tile size in px. */
  size?: number
  className?: string
}) {
  const s = platformStyle(platform)
  const Icon = s.Icon
  return (
    <span
      role="img"
      aria-label={s.label}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[28%]", className)}
      style={{ width: size, height: size, background: s.bg, color: s.fg }}
    >
      <Icon style={{ width: size * 0.52, height: size * 0.52 }} strokeWidth={2.2} />
    </span>
  )
}
