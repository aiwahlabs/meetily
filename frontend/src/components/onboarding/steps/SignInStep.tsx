'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { GoogleSignInCard } from '@/components/aiwah/GoogleSignInCard';
import { useOnboarding } from '@/contexts/OnboardingContext';

/** Hard gate: Continue only works once account.status() is signedIn && domainOk. */
export function SignInStep() {
  const { goNext, goPrevious, accountOk, setAccountStatus } = useOnboarding();

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col items-center">
      <GoogleSignInCard onSignedIn={setAccountStatus} />
      <div className="mt-6 flex w-full max-w-[400px] items-center justify-between">
        <Button variant="ghost" onClick={goPrevious}>
          Back
        </Button>
        <Button onClick={goNext} disabled={!accountOk}>
          Continue
        </Button>
      </div>
      {!accountOk && (
        <p className="mt-3 text-meta text-muted-foreground">Sign in to continue. Nothing is downloaded until you do.</p>
      )}
    </div>
  );
}
