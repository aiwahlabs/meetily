'use client';

import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STEP } from '@/contexts/OnboardingContext';

const ALL_STEPS: { id: number; label: string }[] = [
  { id: STEP.WELCOME, label: 'Welcome' },
  { id: STEP.SIGN_IN, label: 'Sign in' },
  { id: STEP.PERMISSIONS, label: 'Permissions' },
  { id: STEP.DOWNLOAD, label: 'Models' },
  { id: STEP.HQ, label: 'Connect HQ' },
  { id: STEP.BACKGROUND, label: 'Background' },
  { id: STEP.DONE, label: 'Done' },
];

/** Slim vertical progress rail. Display only: steps are not clickable (sign-in is a hard gate). */
export function StepRail({ current, hasPermissionsStep }: { current: number; hasPermissionsStep: boolean }) {
  const steps = ALL_STEPS.filter((s) => hasPermissionsStep || s.id !== STEP.PERMISSIONS);
  const currentIndex = steps.findIndex((s) => s.id === current);

  return (
    <nav aria-label="Setup progress" className="hidden w-56 shrink-0 flex-col justify-center px-8 md:flex">
      <ol className="grid gap-1">
        {steps.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <li
              key={s.id}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-2 py-1.5 text-body transition-colors',
                active ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-meta ring-1 ring-inset transition-colors',
                  done && 'bg-primary text-primary-foreground ring-primary',
                  active && 'bg-card text-primary ring-primary',
                  !done && !active && 'bg-card ring-border'
                )}
              >
                {done ? <Check className="size-3" aria-hidden="true" /> : i + 1}
              </span>
              <span>{s.label}</span>
              {done && <span className="sr-only">(completed)</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
