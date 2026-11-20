'use client';

import React, { useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Building2,
  FlaskConical,
  Mic,
  Radar,
  Settings2,
  ShieldCheck,
  SparkleIcon,
  User,
  Database as DatabaseIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { BetaSettings } from '@/components/BetaSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { SettingsPage, SettingsSection, type SettingsSectionLink } from '@/components/ui/settings-page';
import { AccountSection } from '@/components/aiwah/settings/AccountSection';
import { CallDetectionSection, PrivacySection, useAutoRec } from '@/components/aiwah/settings/CallDetectionSection';
import { HqSection, useHqForm } from '@/components/aiwah/settings/HqSection';

const SECTIONS: SettingsSectionLink[] = [
  { id: 'account', title: 'Account', icon: <User /> },
  { id: 'call-detection', title: 'Call detection', icon: <Radar /> },
  { id: 'privacy', title: 'Privacy', icon: <ShieldCheck /> },
  { id: 'hq', title: 'HQ Workshop', icon: <Building2 /> },
  { id: 'transcription', title: 'Transcription', icon: <DatabaseIcon /> },
  { id: 'summary', title: 'Summary', icon: <SparkleIcon /> },
  { id: 'recordings', title: 'Recordings', icon: <Mic /> },
  { id: 'general', title: 'General', icon: <Settings2 /> },
  { id: 'beta', title: 'Beta', icon: <FlaskConical /> },
];

export default function SettingsRoute() {
  const router = useRouter();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();
  const autorec = useAutoRec();
  const hq = useHqForm();
  const scroller = useRef<HTMLDivElement>(null);

  // The app shell never scrolls (body and <main> are overflow-hidden), so this wrapper is the
  // scroll container. SettingsPage's own scroll-spy observes the window viewport and does not
  // follow it, so keep the section list highlighted from the wrapper's scroll position.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = ['bg-accent', 'font-medium', 'text-foreground'];
    const off = ['text-muted-foreground', 'hover:bg-accent/60', 'hover:text-foreground'];
    const sync = () => {
      const secs = Array.from(el.querySelectorAll<HTMLElement>('[data-settings-section]')).filter((n) => n.offsetParent !== null);
      if (!secs.length) return;
      const line = el.getBoundingClientRect().top + el.clientHeight * 0.4;
      let id = secs[0].id;
      for (const n of secs) if (n.getBoundingClientRect().top <= line) id = n.id;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) id = secs[secs.length - 1].id;
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button'));
      buttons.forEach((b, i) => {
        const active = SECTIONS[i] && `settings-${SECTIONS[i].id}` === id;
        b.classList.remove(...(active ? off : on));
        b.classList.add(...(active ? on : off));
        if (active) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  // Load saved transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await invoke('api_get_transcript_config') as any;
        if (config) {
          setTranscriptModelConfig({
            provider: config.provider || 'localWhisper',
            model: config.model || 'large-v3',
            apiKey: config.apiKey || null
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  return (
    <div ref={scroller} className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <Button variant="ghost" size="sm" className="-ml-2 mb-3" onClick={() => router.back()}>
          <ArrowLeft aria-hidden />
          Back
        </Button>

        <SettingsPage
          title="Settings"
          sections={SECTIONS}
          dirty={hq.dirty}
          onSave={hq.save}
          onDiscard={hq.discard}
        >
          <AccountSection />
          <CallDetectionSection api={autorec} />
          <PrivacySection api={autorec} />
          <HqSection form={hq} />

          <SettingsSection
            id="transcription"
            title="Transcription"
            description="The speech-to-text model used on this device."
          >
            <div className="p-4">
              <TranscriptSettings
                transcriptModelConfig={transcriptModelConfig}
                setTranscriptModelConfig={setTranscriptModelConfig}
              />
            </div>
          </SettingsSection>

          <SettingsSection id="summary" title="Summary" description="Which model writes meeting summaries.">
            <div className="p-4">
              <SummaryModelSettings />
            </div>
          </SettingsSection>

          <SettingsSection id="recordings" title="Recordings" description="Where recordings are saved and which devices are used.">
            <div className="p-4">
              <RecordingSettings />
            </div>
          </SettingsSection>

          <SettingsSection id="general" title="General" description="App preferences.">
            <div className="p-4">
              <PreferenceSettings />
            </div>
          </SettingsSection>

          <SettingsSection id="beta" title="Beta" description="Experimental features that may change.">
            <div className="p-4">
              <BetaSettings />
            </div>
          </SettingsSection>
        </SettingsPage>
      </div>
    </div>
  );
}
