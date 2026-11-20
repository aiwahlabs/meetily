'use client'

// AIWAH: meetings grouped by day. Row = platform tile, title, "Type · time · platform",
// and a hover menu (rename, move to folder, meeting type, delete).

import { useMemo, useState } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import {
  MEETING_TYPES,
  PLATFORMS,
  platformLabel,
  type MeetingType,
  type Platform,
} from '@/lib/aiwah/api'
import { PlatformIcon } from '@/components/aiwah/PlatformIcon'
import { IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface MeetingRow {
  id: string
  title: string
  createdAt?: string
  platform: Platform
  meetingType?: MeetingType
}

interface Props {
  items: MeetingRow[]
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onMovePlatform: (id: string, platform: Platform) => void | Promise<void>
  onSetType: (id: string, type: MeetingType) => void | Promise<void>
}

const DAY = 86_400_000

function bucket(iso: string | undefined, now: Date) {
  if (!iso) return 'Earlier'
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = new Date(iso).getTime()
  if (t >= start) return 'Today'
  if (t >= start - DAY) return 'Yesterday'
  if (t >= start - 7 * DAY) return 'This week'
  return 'Earlier'
}
const ORDER = ['Today', 'Yesterday', 'This week', 'Earlier']

function metaLine(m: MeetingRow) {
  const type = MEETING_TYPES.find((t) => t.id === m.meetingType)?.label
  const d = m.createdAt ? new Date(m.createdAt) : null
  const time = d
    ? bucket(m.createdAt, new Date()) === 'Earlier' || bucket(m.createdAt, new Date()) === 'This week'
      ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : null
  return [type, time, platformLabel(m.platform)].filter(Boolean).join(' · ')
}

export function MeetingList({ items, onOpen, onRename, onDelete, onMovePlatform, onSetType }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<MeetingRow | null>(null)

  const groups = useMemo(() => {
    const now = new Date()
    const by = new Map<string, MeetingRow[]>()
    for (const m of [...items].sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))) {
      const k = bucket(m.createdAt, now)
      by.set(k, [...(by.get(k) ?? []), m])
    }
    return ORDER.filter((k) => by.has(k)).map((k) => ({ label: k, items: by.get(k)! }))
  }, [items])

  const commit = (m: MeetingRow) => {
    const next = draft.trim()
    if (next && next !== m.title) void onRename(m.id, next)
    setRenaming(null)
  }

  return (
    <div className="h-full overflow-y-auto pb-6">
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h2 className="sticky top-0 z-10 bg-background/95 px-2 py-1.5 text-meta font-semibold text-muted-foreground backdrop-blur">
            {g.label}
          </h2>
          <ul>
            {g.items.map((m) => (
              <li key={m.id} className="group/row relative">
                {renaming === m.id ? (
                  <div className="px-2 py-1.5">
                    <Input
                      size="sm"
                      autoFocus
                      aria-label="Meeting title"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={() => commit(m)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commit(m)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setRenaming(null)
                        }
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpen(m.id)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 pr-11 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <PlatformIcon platform={m.platform} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-foreground">{m.title || 'Untitled meeting'}</span>
                        <span className="block truncate text-meta text-muted-foreground">{metaLine(m)}</span>
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label={`Options for ${m.title}`}
                          variant="ghost"
                          size="sm"
                          className={cn(
                            'absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity',
                            'group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
                          )}
                        >
                          <MoreHorizontal />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[190px]">
                        <DropdownMenuItem
                          onSelect={() => {
                            setDraft(m.title)
                            setRenaming(m.id)
                          }}
                        >
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {PLATFORMS.map((p) => (
                              <DropdownMenuItem key={p.id} onSelect={() => void onMovePlatform(m.id, p.id)}>
                                {p.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Meeting type</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {MEETING_TYPES.map((t) => (
                              <DropdownMenuItem key={t.id} onSelect={() => void onSetType(m.id, t.id)}>
                                {t.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem danger onSelect={() => setDeleting(m)}>
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
        title="Delete this meeting?"
        description={deleting ? `“${deleting.title}” and its transcript and notes will be removed. This can't be undone.` : undefined}
        actionLabel="Delete meeting"
        onConfirm={async () => {
          if (deleting) await onDelete(deleting.id)
        }}
      />
    </div>
  )
}
