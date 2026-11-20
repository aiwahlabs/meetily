'use client';

import React, { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Alert } from '@/components/ui/alert';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { autorec } from '@/lib/aiwah/api';

function Toggle({
  id,
  title,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
      <label htmlFor={id} className="cursor-pointer text-title font-medium text-foreground">
        {title}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function BackgroundStep() {
  const { goNext, goPrevious } = useOnboarding();
  const [startAtLogin, setStartAtLogin] = useState(true);
  const [ask, setAsk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaults are ON; if settings were already saved (resume), reflect them.
  useEffect(() => {
    let alive = true;
    autorec
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setStartAtLogin(s.startAtLogin);
        setAsk(s.promptOnMic);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await autorec.getSettings();
      await autorec.saveSettings({ ...s, startAtLogin, promptOnMic: ask, notifyCalendar: ask });
      goNext();
    } catch (err) {
      console.error('[BackgroundStep] Failed to save settings:', err);
      setError('Could not save these settings. Try again, or change them later in Settings.');
      setSaving(false);
    }
  };

  return (
    <OnboardingContainer
      title="Stay in the background"
      description="Aiwah Minutes stays in your system tray. When Meet, Zoom, Teams, Slack or WhatsApp starts a call, a small pop-up asks if you want to record it."
      onBack={goPrevious}
      onNext={save}
      nextLoading={saving}
    >
      <Toggle id="start-at-login" title="Start Aiwah Minutes when I sign in" checked={startAtLogin} onChange={setStartAtLogin} />
      <Toggle id="ask-on-call" title="Ask me when a call starts" checked={ask} onChange={setAsk} />
      {error && (
        <Alert tone="destructive" size="sm" role="alert">
          {error}
        </Alert>
      )}
    </OnboardingContainer>
  );
}
