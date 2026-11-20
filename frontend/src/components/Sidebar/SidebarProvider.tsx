'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import type { SummaryProcessResponse } from '@/types';



interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
  badge?: string; // AIWAH: meeting type
}

// AIWAH: per-platform meeting folders (platform comes from the call watcher, see
// src-tauri/src/autorec/meta.rs). Meetings without metadata go to "Other recordings".
const AIWAH_PLATFORMS: [string, string][] = [
  ['google_meet', 'Google Meet'],
  ['slack', 'Slack'],
  ['whatsapp', 'WhatsApp'],
  ['zoom', 'Zoom'],
  ['teams', 'Microsoft Teams'],
  ['other', 'Other recordings'],
];
export const AIWAH_FOLDER_IDS = AIWAH_PLATFORMS.map(([p]) => `aiwah-folder-${p}`);
const AIWAH_TYPE_BADGE: Record<string, string> = {
  hiring: 'Hiring', discovery: 'Discovery', demo: 'Demo', client: 'Client', internal: 'Internal',
};
interface AiwahMeetingMeta { meetingId: string; platform: string; meetingType: string }

function aiwahGroupMeetings(meetings: { id: string; title: string }[], meta: Record<string, AiwahMeetingMeta>): SidebarItem[] {
  const file = (m: { id: string; title: string }): SidebarItem => ({
    id: m.id, title: m.title, type: 'file', badge: AIWAH_TYPE_BADGE[meta[m.id]?.meetingType ?? ''],
  });
  const groups = AIWAH_PLATFORMS.map(([p, label]) => ({
    p, label, items: meetings.filter((m) => (AIWAH_PLATFORMS.some(([k]) => k === meta[m.id]?.platform) ? meta[m.id].platform : 'other') === p),
  })).filter((g) => g.items.length > 0);
  // One group only (e.g. nothing detected yet): keep the flat list.
  if (groups.length <= 1) return meetings.map(file);
  return groups.map((g) => ({
    id: `aiwah-folder-${g.p}`, title: `${g.label} (${g.items.length})`, type: 'folder', children: g.items.map(file),
  }));
}

export interface CurrentMeeting {
  id: string;
  title: string;
}

// Search result type for transcript search
interface TranscriptSearchResult {
  id: string;
  title: string;
  matchContext: string;
  timestamp: string;
}

interface SummaryPoll {
  processId: string;
  timer: NodeJS.Timeout;
  inFlight: boolean;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  doodlePath: string | null;
  doodleDate: string | null;
  toggleCollapse: () => void;
  meetings: CurrentMeeting[];
  setMeetings: (meetings: CurrentMeeting[]) => void;
  isMeetingActive: boolean;
  setIsMeetingActive: (active: boolean) => void;
  handleRecordingToggle: () => void;
  searchTranscripts: (query: string) => Promise<void>;
  searchResults: TranscriptSearchResult[];
  isSearching: boolean;
  setServerAddress: (address: string) => void;
  serverAddress: string;
  transcriptServerAddress: string;
  setTranscriptServerAddress: (address: string) => void;
  // Summary polling management
  startSummaryPolling: (
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => void;
  stopSummaryPolling: (meetingId: string, processId?: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(false);
  // AIWAH: remember the rail/expanded choice
  useEffect(() => {
    try { if (localStorage.getItem('aiwah-sidebar-collapsed') === '1') setIsCollapsed(true); } catch { /* ignore */ }
  }, []);
  const [doodlePath, setDoodlePath] = useState<string | null>(null);
  const [doodleDate, setDoodleDate] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const [aiwahMeta, setAiwahMeta] = useState<Record<string, AiwahMeetingMeta>>({}); // AIWAH
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [transcriptServerAddress, setTranscriptServerAddress] = useState('');
  const summaryPollsRef = React.useRef(new Map<string, SummaryPoll>());

  // Use recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();

  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const sync = () => {
      invoke<string | null>('doodle_sync').then(path => {
        setDoodlePath(path);
        setDoodleDate(new Date().toISOString().slice(0, 10));
      }).catch(() => setDoodlePath(null));
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') sync(); };
    sync();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Extract fetchMeetings as a reusable function
  const fetchMeetings = React.useCallback(async () => {
    if (serverAddress) {
      try {
        const meetings = await invoke('api_get_meetings') as Array<{ id: string, title: string }>;
        const transformedMeetings = meetings.map((meeting: any) => ({
          id: meeting.id,
          title: meeting.title
        }));
        setMeetings(transformedMeetings);
        // AIWAH: platform folder + meeting type per meeting
        try {
          const metaRows = await invoke<AiwahMeetingMeta[]>('autorec_list_meeting_meta');
          setAiwahMeta(Object.fromEntries(metaRows.map((r) => [r.meetingId, r])));
        } catch (e) {
          console.warn('Could not load meeting folders:', e);
        }
        Analytics.trackBackendConnection(true);
      } catch (error) {
        console.error('Error fetching meetings:', error);
        setMeetings([]);
        Analytics.trackBackendConnection(false, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [serverAddress]);

  useEffect(() => {
    fetchMeetings();
  }, [serverAddress, fetchMeetings]);

  useEffect(() => {
    const fetchSettings = async () => {
      setServerAddress('http://localhost:5167');
      setTranscriptServerAddress('http://127.0.0.1:8178/stream');
    };
    fetchSettings();
  }, []);

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Meeting Notes',
      type: 'folder' as const,
      children: [
        ...aiwahGroupMeetings(meetings, aiwahMeta) // AIWAH: per-platform folders
      ]
    },
  ];


  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    try { localStorage.setItem('aiwah-sidebar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings, aiwahMeta]); // AIWAH: also regroup when folders change

  // Function to handle recording toggle from sidebar
  const handleRecordingToggle = () => {
    if (!isRecording) {
      // Check if already on home page
      if (pathname === '/') {
        // Already on home - trigger recording directly via custom event
        console.log('Triggering recording from sidebar (already on home page)');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      } else {
        // Not on home - navigate and use auto-start mechanism
        console.log('Navigating to home page with auto-start flag');
        sessionStorage.setItem('autoStartRecording', 'true');
        router.push('/');
      }

      // Track recording initiation from sidebar
      Analytics.trackButtonClick('start_recording', 'sidebar');
    }
    // The actual recording start/stop is handled in the Home component
  };

  // Function to search through meeting transcripts
  const searchTranscripts = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      setIsSearching(true);


      const results = await invoke('api_search_transcripts', { query }) as TranscriptSearchResult[];
      setSearchResults(results);
    } catch (error) {
      console.error('Error searching transcripts:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Summary polling management
  const stopSummaryPolling = React.useCallback((meetingId: string, processId?: string) => {
    const poll = summaryPollsRef.current.get(meetingId);
    if (!poll || (processId && poll.processId !== processId)) {
      return;
    }
    clearInterval(poll.timer);
    summaryPollsRef.current.delete(meetingId);
  }, []);

  const startSummaryPolling = React.useCallback((
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => {
    stopSummaryPolling(meetingId);
    let pollCount = 0;
    const maxPolls = 200;
    const poll = async () => {
      const entry = summaryPollsRef.current.get(meetingId);
      if (!entry || entry.processId !== processId || entry.inFlight) {
        return;
      }
      entry.inFlight = true;
      try {
        pollCount += 1;
        if (pollCount >= maxPolls) {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: 'Summary generation timed out after 15 minutes. Please try again or check your model configuration.',
          });
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
          return;
        }

        const result = await invoke<SummaryProcessResponse>('api_get_summary', { meetingId });
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry || result.start !== processId) {
          return;
        }
        await onUpdate(result);
        if (summaryPollsRef.current.get(meetingId) !== entry) return;
        if (
          result.status === 'completed'
          || result.status === 'error'
          || result.status === 'failed'
          || result.status === 'cancelled'
          || (result.status === 'idle' && pollCount > 1)
        ) {
          stopSummaryPolling(meetingId, processId);
        }
      } catch (error) {
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry) {
          return;
        }
        try {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } catch (callbackError) {
          console.error('Failed to handle summary polling error:', callbackError);
        } finally {
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
        }
      } finally {
        const current = summaryPollsRef.current.get(meetingId);
        if (current === entry) {
          current.inFlight = false;
        }
      }
    };

    const timer = setInterval(() => void poll(), 5000);
    summaryPollsRef.current.set(meetingId, { processId, timer, inFlight: false });
  }, [stopSummaryPolling]);

  useEffect(() => () => {
    summaryPollsRef.current.forEach(({ timer }) => clearInterval(timer));
    summaryPollsRef.current.clear();
  }, []);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      doodlePath,
      doodleDate,
      toggleCollapse,
      meetings,
      setMeetings,
      isMeetingActive,
      setIsMeetingActive,
      handleRecordingToggle,
      searchTranscripts,
      searchResults,
      isSearching,
      setServerAddress,
      serverAddress,
      transcriptServerAddress,
      setTranscriptServerAddress,
      startSummaryPolling,
      stopSummaryPolling,
      refetchMeetings: fetchMeetings,

    }}>
      {children}
    </SidebarContext.Provider>
  );
}
