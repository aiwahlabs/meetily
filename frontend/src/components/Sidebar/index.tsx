'use client';

// AIWAH: app sidebar built on the Liro Sidebar. Home, Meetings, one folder per call
// platform, recording status, and the signed-in account.

import React, { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, Home, MessageSquare, Mic, NotebookPen, Settings, Upload } from 'lucide-react';
import { Sidebar, SidebarGroup, SidebarItem } from '@/components/ui/sidebar';
import { Button, IconButton } from '@/components/ui/button';
import { ProfileMenu } from '@/components/ui/profile-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { PlatformIcon } from '@/components/aiwah/PlatformIcon';
import { useAccountStatus } from '@/components/aiwah/useAccountStatus';
import { account, PLATFORMS, type Platform } from '@/lib/aiwah/api';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useConfig } from '@/contexts/ConfigContext';
import { cn } from '@/lib/utils';
import { useSidebar } from './SidebarProvider';
import { folderLabel, folderOf, useMeetingMeta } from './meetingFolders';

const SIDEBAR_WIDTH = 256; // 16rem, matches MainContent and the recording overlays
const SIDEBAR_RAIL = 64; // 4rem

function formatClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const AppSidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isCollapsed, toggleCollapse, handleRecordingToggle, meetings } = useSidebar();
  const { isRecording, activeDuration } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const { status: acct } = useAccountStatus();
  const meta = useMeetingMeta(meetings);

  // The tray's "Settings" entry calls window.openSettings().
  useEffect(() => {
    (window as any).openSettings = () => router.push('/settings');
    return () => {
      delete (window as any).openSettings;
    };
  }, [router]);

  const clock = formatClock(activeDuration ?? 0);

  const folders = useMemo(() => {
    const counts = new Map<Platform, number>();
    for (const m of meetings) {
      const p = folderOf(meta[m.id]);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return PLATFORMS.filter((p) => (counts.get(p.id) ?? 0) > 0).map((p) => ({
      id: p.id,
      label: folderLabel(p.id),
      count: counts.get(p.id) ?? 0,
    }));
  }, [meetings, meta]);

  const folderParam = searchParams?.get('folder') ?? null;
  const onHome = pathname === '/';
  const onMeetings = pathname === '/meetings' || pathname?.startsWith('/meeting-details') === true;
  const onSettings = pathname === '/settings';

  const link = (href: string) =>
    function LinkRender(p: React.HTMLAttributes<HTMLElement> & { className: string }) {
      return <Link {...(p as any)} href={href} />;
    };

  const signedIn = !!acct?.signedIn;
  const displayName = acct?.name || acct?.email || 'Account';

  const header = isCollapsed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo-collapsed.png" alt="Aiwah Minutes" className="mx-auto size-7 object-contain" />
  ) : (
    <div className="flex items-center gap-2.5 px-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-collapsed.png" alt="" className="size-7 shrink-0 object-contain" />
      <span className="truncate font-display text-[15px] font-semibold tracking-tight text-foreground">Aiwah Minutes</span>
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-1">
      <SidebarGroup className="mt-0">
        {betaFeatures.importAndRetranscribe && (
          <SidebarItem icon={<Upload />} onClick={() => openImportDialog()}>
            Import audio
          </SidebarItem>
        )}
        <SidebarItem icon={<MessageSquare />} render={link('/feedback')} active={pathname === '/feedback'}>
          Send feedback
        </SidebarItem>
        {!signedIn && (
          <SidebarItem icon={<Settings />} render={link('/settings')} active={onSettings}>
            Settings
          </SidebarItem>
        )}
      </SidebarGroup>
      {signedIn && acct && (
        <ProfileMenu
          variant={isCollapsed ? 'avatar' : 'full'}
          align="start"
          user={{ name: displayName, email: acct.email ?? '', avatarUrl: acct.picture ?? undefined }}
          items={[{ id: 'settings', label: 'Settings', icon: <Settings /> }]}
          onNavigate={(id) => {
            if (id === 'settings') router.push('/settings');
          }}
          hideTheme
          onSignOut={async () => {
            await account.signOut();
            window.location.reload();
          }}
          className={isCollapsed ? 'mx-auto' : 'w-full'}
        />
      )}
    </div>
  );

  return (
    <div className="fixed top-0 left-0 z-40 h-screen border-r border-border">
      <Sidebar
        collapsed={isCollapsed}
        onCollapsedChange={() => toggleCollapse()}
        header={header}
        footer={footer}
        width={SIDEBAR_WIDTH}
        railWidth={SIDEBAR_RAIL}
        className="h-screen"
      >
        <div className="px-0.5 pt-1 pb-1">
          {isRecording ? (
            <Tooltip label="Recording in progress" side="right">
              <button
                type="button"
                onClick={() => !onHome && router.push('/')}
                aria-label={`Recording, ${clock}. Open recording`}
                className={cn(
                  'flex h-9 w-full cursor-pointer items-center gap-2 rounded-[10px] bg-destructive-soft px-3 text-[13px] font-semibold text-destructive',
                  'ring-1 ring-inset ring-destructive/20 transition-colors hover:bg-destructive-soft/70',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isCollapsed && 'justify-center px-0',
                )}
              >
                <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" />
                {!isCollapsed && (
                  <span className="truncate">
                    Recording · <span className="tabular-nums">{clock}</span>
                  </span>
                )}
              </button>
            </Tooltip>
          ) : isCollapsed ? (
            <Tooltip label="New recording" side="right">
              <IconButton label="New recording" onClick={handleRecordingToggle} className="mx-auto flex">
                <Mic />
              </IconButton>
            </Tooltip>
          ) : (
            <Button onClick={handleRecordingToggle} className="w-full justify-center">
              <Mic />
              New recording
            </Button>
          )}
        </div>

        <SidebarGroup>
          <SidebarItem icon={<Home />} render={link('/')} active={onHome}>
            Home
          </SidebarItem>
          <SidebarItem icon={<CalendarDays />} render={link('/calendar')} active={pathname === '/calendar'}>
            Calendar
          </SidebarItem>
          <SidebarItem icon={<NotebookPen />} render={link('/meetings')} active={onMeetings && !(pathname === '/meetings' && folderParam)}>
            Meetings
          </SidebarItem>
        </SidebarGroup>

        {folders.length > 0 && (
          <SidebarGroup label="Folders">
            {folders.map((f) => (
              <SidebarItem
                key={f.id}
                icon={<PlatformIcon platform={f.id} size={18} />}
                badge={f.count}
                render={link(`/meetings?folder=${f.id}`)}
                active={pathname === '/meetings' && folderParam === f.id}
              >
                {f.label}
              </SidebarItem>
            ))}
          </SidebarGroup>
        )}
      </Sidebar>
    </div>
  );
};

export default AppSidebar;
