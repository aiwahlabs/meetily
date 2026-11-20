'use client';

import React from 'react';
import { Mic, Captions, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOnboarding } from '@/contexts/OnboardingContext';

const BENEFITS = [
  { icon: Mic, text: 'Detects your calls and asks before recording' },
  { icon: Captions, text: 'Transcribes on this device, with Malayalam, Tamil and Hindi via HQ' },
  { icon: Send, text: 'Lands in HQ Workshop with a summary and action items' },
];

export function WelcomeStep() {
  const { goNext } = useOnboarding();

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-collapsed.png" alt="" className="mb-6 size-14 rounded-2xl" />
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Aiwah Minutes</h1>
      <p className="mt-2 text-title text-muted-foreground">
        Every meeting, transcribed and in HQ — without lifting a finger.
      </p>

      <ul className="mt-8 grid gap-4">
        {BENEFITS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="pt-1 text-body text-foreground">{text}</span>
          </li>
        ))}
      </ul>

      <div className="mt-10 flex items-center justify-between">
        <span className="text-meta text-muted-foreground">Takes about 3 minutes</span>
        <Button size="lg" onClick={goNext}>
          Get started
        </Button>
      </div>
    </div>
  );
}
