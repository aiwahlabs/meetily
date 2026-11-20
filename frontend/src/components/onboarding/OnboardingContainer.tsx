'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface OnboardingContainerProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Primary action, bottom-right. */
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  /** Ghost "Back" button, bottom-left. */
  onBack?: () => void;
  /** Quiet extra action next to the primary one, e.g. "Skip for now". */
  secondary?: React.ReactNode;
  /** Shown under the footer, e.g. why Continue is disabled. */
  footnote?: React.ReactNode;
  className?: string;
}

/** Content column of one onboarding step: heading, body, and the footer actions. */
export function OnboardingContainer({
  title,
  description,
  children,
  onNext,
  nextLabel = 'Continue',
  nextDisabled,
  nextLoading,
  onBack,
  secondary,
  footnote,
  className,
}: OnboardingContainerProps) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[480px] flex-col', className)}>
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-2 text-body text-muted-foreground">{description}</p>}
      </header>

      {children && <div className="grid gap-3">{children}</div>}

      {(onNext || onBack || secondary) && (
        <footer className="mt-8 flex items-center justify-between gap-3">
          <div>
            {onBack && (
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {secondary}
            {onNext && (
              <Button onClick={onNext} disabled={nextDisabled || nextLoading} loading={nextLoading}>
                {nextLabel}
              </Button>
            )}
          </div>
        </footer>
      )}
      {footnote && <p className="mt-3 text-right text-meta text-muted-foreground">{footnote}</p>}
    </div>
  );
}
