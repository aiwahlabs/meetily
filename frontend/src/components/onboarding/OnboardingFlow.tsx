'use client';

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useOnboarding, STEP } from '@/contexts/OnboardingContext';
import { StepRail } from './shared';
import {
  WelcomeStep,
  SignInStep,
  PermissionsStep,
  DownloadProgressStep,
  ConnectHqStep,
  BackgroundStep,
  DoneStep,
} from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

// Persisted numbering (see STEP in OnboardingContext):
// 1 Welcome, 2 Sign in (hard gate), 3 Permissions (macOS only), 4 Download models,
// 5 Connect HQ, 6 Background, 7 Done.
export function OnboardingFlow({ onComplete: _onComplete }: OnboardingFlowProps) {
  const { currentStep, ready, hasPermissionsStep } = useOnboarding();
  const reduce = useReducedMotion();

  return (
    <div className="fixed inset-0 z-50 flex overflow-hidden bg-background text-foreground">
      <StepRail current={currentStep} hasPermissionsStep={hasPermissionsStep} />
      <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        {ready && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentStep}
              className="w-full"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              {currentStep === STEP.WELCOME && <WelcomeStep />}
              {currentStep === STEP.SIGN_IN && <SignInStep />}
              {currentStep === STEP.PERMISSIONS && <PermissionsStep />}
              {currentStep === STEP.DOWNLOAD && <DownloadProgressStep />}
              {currentStep === STEP.HQ && <ConnectHqStep />}
              {currentStep === STEP.BACKGROUND && <BackgroundStep />}
              {currentStep === STEP.DONE && <DoneStep />}
            </motion.div>
          </AnimatePresence>
        )}
      </main>
    </div>
  );
}
