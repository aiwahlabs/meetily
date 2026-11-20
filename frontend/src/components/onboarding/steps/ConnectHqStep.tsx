'use client';

import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { hq } from '@/lib/aiwah/api';

export function ConnectHqStep() {
  const { goNext, goPrevious } = useOnboarding();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const view = await hq.saveSettings({ apiKey: key });
      setConnectedAs(view.userEmail || view.userName || 'your HQ account');
      setApiKey('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      setError(msg || 'That key was not accepted. Check it and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingContainer
      title="Connect HQ"
      description="Meetings are sent to HQ Workshop with their summary and action items."
      onBack={goPrevious}
      onNext={goNext}
      nextLabel={connectedAs ? 'Continue' : 'Skip for now'}
      footnote={!connectedAs ? 'You can connect HQ later in Settings. Meetings stay on this device until then.' : undefined}
    >
      {connectedAs ? (
        <Alert tone="success" icon={<Check className="size-4" aria-hidden="true" />} title={`Connected as ${connectedAs}`} />
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <Field label="HQ API key" hint="HQ Workshop → Settings → API keys" error={error ?? undefined}>
            <PasswordInput
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your key"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <div>
            <Button type="submit" variant="outline" loading={busy} disabled={busy || !apiKey.trim()}>
              Connect
            </Button>
          </div>
        </form>
      )}
    </OnboardingContainer>
  );
}
