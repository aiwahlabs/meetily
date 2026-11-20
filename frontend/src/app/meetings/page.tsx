'use client'

// AIWAH: all meetings, grouped by day, filterable by call platform folder.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Mic } from 'lucide-react'
import { MeetingList, type MeetingRow } from '@/components/aiwah/meetings/MeetingList'
import { SearchInput } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/state'
import { EmptyState } from '@/components/ui/empty-states'
import { meetings as meetingsApi, PLATFORMS, type MeetingSummary, type MeetingType, type Platform } from '@/lib/aiwah/api'
import { useSidebar } from '@/components/Sidebar/SidebarProvider'
import { folderLabel, folderOf, isPlatform, useMeetingMeta } from '@/components/Sidebar/meetingFolders'
import Analytics from '@/lib/analytics'

function MeetingsView() {
  const router = useRouter()
  const params = useSearchParams()
  const folderParam = params?.get('folder')
  const folder = isPlatform(folderParam) ? folderParam : 'all'

  const {
    meetings: sidebarMeetings,
    setMeetings,
    refetchMeetings,
    currentMeeting,
    setCurrentMeeting,
    searchTranscripts,
    searchResults,
    isSearching,
  } = useSidebar()

  const [rows, setRows] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [metaTick, setMetaTick] = useState(0)
  const meta = useMeetingMeta(`${sidebarMeetings.length}-${metaTick}`)

  const load = useCallback(async () => {
    try {
      setRows(await meetingsApi.list())
    } catch (e) {
      console.error('Could not load meetings', e)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, sidebarMeetings])

  // Transcript search runs through the same Tauri command the old sidebar used.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      void searchTranscripts('')
      return
    }
    const t = setTimeout(() => void searchTranscripts(q), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of rows) {
      const p = folderOf(meta[m.id])
      c.set(p, (c.get(p) ?? 0) + 1)
    }
    return c
  }, [rows, meta])

  const options = useMemo(
    () => [
      { value: 'all', label: 'All' },
      ...PLATFORMS.filter((p) => (counts.get(p.id) ?? 0) > 0).map((p) => ({ value: p.id as string, label: folderLabel(p.id) })),
    ],
    [counts],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = new Set(q ? searchResults.map((r) => r.id) : [])
    return rows.filter((m) => {
      if (folder !== 'all' && folderOf(meta[m.id]) !== folder) return false
      if (!q) return true
      return m.title.toLowerCase().includes(q) || hits.has(m.id)
    })
  }, [rows, meta, folder, query, searchResults])

  const items: MeetingRow[] = useMemo(
    () =>
      visible.map((m) => ({
        id: m.id,
        title: m.title || 'Untitled meeting',
        createdAt: m.created_at,
        platform: folderOf(meta[m.id]),
        meetingType: meta[m.id]?.meetingType,
      })),
    [visible, meta],
  )

  const setFolder = (v: string) => {
    router.replace(v === 'all' ? '/meetings' : `/meetings?folder=${v}`)
  }

  const rename = async (id: string, title: string) => {
    try {
      await invoke('api_save_meeting_title', { meetingId: id, title })
      setRows((r) => r.map((m) => (m.id === id ? { ...m, title } : m)))
      setMeetings(sidebarMeetings.map((m) => (m.id === id ? { ...m, title } : m)))
      if (currentMeeting?.id === id) setCurrentMeeting({ id, title })
      Analytics.trackButtonClick('edit_meeting_title', 'meetings')
      toast.success('Meeting renamed')
    } catch (e) {
      toast.error('Could not rename the meeting', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const remove = async (id: string) => {
    try {
      await invoke('api_delete_meeting', { meetingId: id })
      setRows((r) => r.filter((m) => m.id !== id))
      setMeetings(sidebarMeetings.filter((m) => m.id !== id))
      Analytics.trackMeetingDeleted(id)
      toast.success('Meeting deleted', { description: 'All associated data has been removed.' })
      void refetchMeetings()
    } catch (e) {
      toast.error('Could not delete the meeting', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const updateMeta = async (id: string, patch: { platform?: Platform; meetingType?: MeetingType }, msg: string) => {
    try {
      await meetingsApi.updateMeta(id, patch)
      await refetchMeetings()
      setMetaTick((n) => n + 1)
      toast.success(msg)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const startRecording = () => {
    sessionStorage.setItem('autoStartRecording', 'true')
    router.push('/')
  }

  const searching = query.trim() !== ''
  const empty = !loading && items.length === 0

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-8 pt-10 pb-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Meetings</h1>
            <p className="mt-1 text-sub text-muted-foreground">
              {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'meeting' : 'meetings'}`}
              {searching && isSearching ? ' · searching transcripts…' : ''}
            </p>
          </div>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search titles and transcripts"
            aria-label="Search meetings"
            className="w-64"
          />
        </div>
        {options.length > 1 && (
          <div className="overflow-x-auto">
            <SegmentedControl label="Folder" options={options} value={folder} onChange={setFolder} size="sm" />
          </div>
        )}
      </div>

      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 px-6">
        {empty ? (
          searching ? (
            <EmptyState
              illustration="search"
              title="No meetings match that"
              description={`Nothing has “${query.trim()}” in its title or transcript.`}
              primaryAction={{ label: 'Clear search', onClick: () => setQuery('') }}
            />
          ) : folder !== 'all' ? (
            <EmptyState
              illustration="inbox"
              title={`No ${folderLabel(folder)} meetings yet`}
              description="Meetings recorded from this platform show up here."
              primaryAction={{ label: 'Show all meetings', onClick: () => setFolder('all') }}
            />
          ) : (
            <EmptyState
              illustration="inbox"
              title="No meetings yet"
              description="Record a call and its transcript and notes will be kept here."
              primaryAction={{ label: 'New recording', onClick: startRecording, icon: <Mic /> }}
            />
          )
        ) : (
          loading ? (
            <div aria-busy className="flex flex-col gap-3 px-2 pt-2">
              {[72, 88, 60, 80].map((w, i) => (
                <Skeleton key={i} className="h-9" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <MeetingList
              items={items}
              onOpen={(id) => {
                const m = rows.find((r) => r.id === id)
                if (m) setCurrentMeeting({ id, title: m.title })
                router.push(`/meeting-details?id=${id}`)
              }}
              onRename={rename}
              onDelete={remove}
              onMovePlatform={(id, platform) => updateMeta(id, { platform }, 'Moved to folder')}
              onSetType={(id, meetingType) => updateMeta(id, { meetingType }, 'Meeting type updated')}
            />
          )
        )}
      </div>
    </div>
  )
}

export default function MeetingsPage() {
  return (
    <Suspense fallback={null}>
      <MeetingsView />
    </Suspense>
  )
}
