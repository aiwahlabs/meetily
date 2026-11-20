'use client';

import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function DoneStep() {
  const { completeOnboarding, goPrevious } = useOnboarding();
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      await completeOnboarding();
      // Let the saved status settle before the shell reloads into the main app.
      await new Promise((r) => setTimeout(r, 100));
      window.location.reload();
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
      toast.error('Could not finish setup', { description: 'Try again.' });
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col">
      <span className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Check className="size-7" aria-hidden="true" />
      </span>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">You&apos;re all set</h1>
      <p className="mt-2 text-title text-muted-foreground">
        Join a call as usual. Aiwah Minutes will ask before it records anything.
      </p>
      <div className="mt-10 flex items-center justify-between">
        <Button variant="ghost" onClick={goPrevious} disabled={busy}>
          Back
        </Button>
        <Button size="lg" onClick={finish} loading={busy} disabled={busy}>
          Open Aiwah Minutes
        </Button>
      </div>
    </div>
  );
}
