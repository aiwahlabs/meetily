'use client';

import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { OnboardingContainer } from '../OnboardingContainer';
import { PermissionRow } from '../shared';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function PermissionsStep() {
  const { setPermissionStatus, setPermissionsSkipped, permissions, goNext, goPrevious } = useOnboarding();
  const [pending, setPending] = useState<'microphone' | 'systemAudio' | null>(null);

  const openSettings = async (fallback: string) => {
    try {
      await invoke('open_system_settings');
    } catch {
      toast.message(fallback);
    }
  };

  const handleMicrophoneAction = async () => {
    if (permissions.microphone === 'denied') {
      await openSettings('Enable microphone access in System Settings, Privacy & Security, Microphone.');
      return;
    }
    setPending('microphone');
    try {
      const granted = await invoke<boolean>('trigger_microphone_permission');
      setPermissionStatus('microphone', granted ? 'authorized' : 'denied');
    } catch (err) {
      console.error('[PermissionsStep] Failed to request microphone permission:', err);
      setPermissionStatus('microphone', 'denied');
    } finally {
      setPending(null);
    }
  };

  const handleSystemAudioAction = async () => {
    if (permissions.systemAudio === 'denied') {
      await openSettings('Enable Audio Capture in System Settings, Privacy & Security, Audio Capture.');
      return;
    }
    setPending('systemAudio');
    try {
      // Backend creates a Core Audio tap and verifies the captured audio is not silence.
      const granted = await invoke<boolean>('trigger_system_audio_permission_command');
      setPermissionStatus('systemAudio', granted ? 'authorized' : 'denied');
    } catch (err) {
      console.error('[PermissionsStep] Failed to request system audio permission:', err);
      setPermissionStatus('systemAudio', 'denied');
    } finally {
      setPending(null);
    }
  };

  const allGranted = permissions.microphone === 'authorized' && permissions.systemAudio === 'authorized';

  const handleContinue = () => {
    setPermissionsSkipped(!allGranted);
    goNext();
  };

  return (
    <OnboardingContainer
      title="Let Aiwah Minutes hear your calls"
      description="Recording needs your microphone and the sound of the call. Audio stays on this device."
      onBack={goPrevious}
      onNext={handleContinue}
      nextLabel={allGranted ? 'Continue' : 'Skip for now'}
      footnote={!allGranted ? 'Recording will not work until both are allowed. You can do this later in Settings.' : undefined}
    >
      <PermissionRow
        icon={<Mic className="size-5" aria-hidden="true" />}
        title="Microphone"
        description="Captures your voice"
        status={permissions.microphone}
        isPending={pending === 'microphone'}
        onAction={handleMicrophoneAction}
      />
      <PermissionRow
        icon={<Volume2 className="size-5" aria-hidden="true" />}
        title="System audio"
        description="Captures everyone else on the call"
        status={permissions.systemAudio}
        isPending={pending === 'systemAudio'}
        onAction={handleSystemAudioAction}
      />
    </OnboardingContainer>
  );
}
