'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PermissionStatus, OnboardingPermissions } from '@/types/onboarding';
import { resolveOnboardingSummaryModelStatus } from '@/lib/onboarding-summary-model';
import type { ParakeetDownloadProgressEvent } from '@/lib/parakeet';
import { account, type AccountStatus } from '@/lib/aiwah/api';

// Persisted step numbers (u8 in the Rust status file). Never renumber without bumping STATUS_VERSION.
export const STEP = {
  WELCOME: 1,
  SIGN_IN: 2,
  PERMISSIONS: 3,
  DOWNLOAD: 4,
  HQ: 5,
  BACKGROUND: 6,
  DONE: 7,
} as const;
export const LAST_STEP = STEP.DONE;
// Status files written by the old 4-step flow have a different version; they restart at Welcome.
const STATUS_VERSION = '2.0';

export function isAccountOk(s: AccountStatus | null | undefined): boolean {
  return !!s && s.signedIn && s.domainOk;
}

const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';

interface OnboardingStatus {
  version: string;
  completed: boolean;
  current_step: number;
  model_status: {
    parakeet: string;
    summary: string;
    selected_summary_model?: string;
  };
  last_updated: string;
}

interface SummaryModelProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
}

interface ParakeetProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
}

interface OnboardingContextType {
  currentStep: number;
  /** False until the saved step and the Google account have been checked. */
  ready: boolean;
  /** True when a signed-in @aiwahlabs.com account exists. Gates every step after sign-in. */
  accountOk: boolean;
  accountStatus: AccountStatus | null;
  /** The permissions step only exists on macOS; other platforms skip it. */
  hasPermissionsStep: boolean;
  /** Call after account.signIn() succeeds so the gate opens. */
  setAccountStatus: (s: AccountStatus) => void;
  parakeetDownloaded: boolean;
  parakeetProgress: number;
  parakeetProgressInfo: ParakeetProgressInfo;
  summaryModelDownloaded: boolean;
  summaryModelProgress: number;
  summaryModelProgressInfo: SummaryModelProgressInfo;
  selectedSummaryModel: string;
  recommendedSummaryModel: string;
  databaseExists: boolean;
  isBackgroundDownloading: boolean;
  // Permissions
  permissions: OnboardingPermissions;
  permissionsSkipped: boolean;
  // Navigation
  goToStep: (step: number) => void;
  goNext: () => void;
  goPrevious: () => void;
  // Setters
  setParakeetDownloaded: (value: boolean) => void;
  setSummaryModelDownloaded: (value: boolean) => void;
  setSelectedSummaryModel: (value: string) => void;
  setDatabaseExists: (value: boolean) => void;
  setPermissionStatus: (permission: keyof OnboardingPermissions, status: PermissionStatus) => void;
  setPermissionsSkipped: (skipped: boolean) => void;
  completeOnboarding: () => Promise<void>;
  startBackgroundDownloads: (options: StartBackgroundDownloadsOptions) => Promise<void>;
  retryParakeetDownload: () => Promise<void>;
}

interface StartBackgroundDownloadsOptions {
  includeParakeet: boolean;
  includeSummary: boolean;
  summaryModel?: string;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState<number>(STEP.WELCOME);
  const [ready, setReady] = useState(false);
  const [accountStatus, setAccountStatusState] = useState<AccountStatus | null>(null);
  const [hasPermissionsStep, setHasPermissionsStep] = useState(false);
  const accountOk = isAccountOk(accountStatus);
  // Ref mirror so async download code always sees the latest gate value.
  const accountOkRef = useRef(false);
  accountOkRef.current = accountOk;
  const hasPermissionsStepRef = useRef(false);
  hasPermissionsStepRef.current = hasPermissionsStep;
  const [completed, setCompleted] = useState(false);
  const [parakeetDownloaded, setParakeetDownloaded] = useState(false);
  const [parakeetProgress, setParakeetProgress] = useState(0);
  const [parakeetProgressInfo, setParakeetProgressInfo] = useState<ParakeetProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  const [summaryModelDownloaded, setSummaryModelDownloaded] = useState(false);
  const [summaryModelProgress, setSummaryModelProgress] = useState(0);
  const [summaryModelProgressInfo, setSummaryModelProgressInfo] = useState<SummaryModelProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  const [selectedSummaryModel, setSelectedSummaryModel] = useState<string>('');
  const [recommendedSummaryModel, setRecommendedSummaryModel] = useState<string>('');
  const [databaseExists, setDatabaseExists] = useState(false);
  const [isBackgroundDownloading, setIsBackgroundDownloading] = useState(false);

  // Permissions state
  const [permissions, setPermissions] = useState<OnboardingPermissions>({
    microphone: 'not_determined',
    systemAudio: 'not_determined',
    screenRecording: 'not_determined',
  });
  const [permissionsSkipped, setPermissionsSkipped] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout>();

  const initializeSummaryModelSelection = async (preferredModel = selectedSummaryModel) => {
    try {
      const recommendedModel = await invoke<string>('builtin_ai_get_recommended_model');
      setRecommendedSummaryModel(recommendedModel);
      const modelToCheck = preferredModel || recommendedModel;
      setSelectedSummaryModel(modelToCheck);

      const selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: modelToCheck,
        refresh: true,
      });
      const resolved = resolveOnboardingSummaryModelStatus({
        selectedModel: preferredModel,
        recommendedModel,
        selectedModelReady,
      });

      setSelectedSummaryModel(resolved.selectedSummaryModel);
      setSummaryModelDownloaded(resolved.summaryModelDownloaded);
      console.log('[OnboardingContext] Set recommended model:', resolved.selectedSummaryModel);

      return resolved;
    } catch (error) {
      console.error('[OnboardingContext] Failed to initialize summary model:', error);
      return null;
    }
  };

  const requestSummaryModelDownload = (modelName: string) => {
    if (!accountOkRef.current) {
      console.warn('[OnboardingContext] Summary download blocked: not signed in');
      return;
    }
    console.log('[OnboardingContext] Starting Summary Model download');
    invoke('builtin_ai_download_model', { modelName })
      .catch(err => {
        if (String(err).includes('Download already in progress')) {
          return;
        }
        console.error('[OnboardingContext] Summary Model download failed:', err);
      });
  };

  // Load status on mount and initialize database
  useEffect(() => {
    (async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setHasPermissionsStep(platform() === 'macos');
      } catch {
        setHasPermissionsStep(navigator.userAgent.includes('Mac'));
      }
    })();
    loadOnboardingStatus();
    checkDatabaseStatus();
    initializeDatabaseInBackground();
  }, []);

  // Initialize database silently in background (moved from SetupOverviewStep)
  const initializeDatabaseInBackground = async () => {
    try {
      console.log('[OnboardingContext] Starting background database initialization');
      const isFirstLaunch = await invoke<boolean>('check_first_launch');

      if (!isFirstLaunch) {
        console.log('[OnboardingContext] Database exists, skipping initialization');
        setDatabaseExists(true);
        return;
      }

      // First launch - attempt auto-detection and import
      await performAutoDetection();
    } catch (error) {
      console.error('[OnboardingContext] Database initialization failed:', error);
      // Don't throw - database init failure shouldn't block onboarding
    }
  };

  const performAutoDetection = async () => {
    // Check Homebrew (macOS only)
    if (typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac')) {
      const homebrewDbPath = '/usr/local/var/meetily/meeting_minutes.db';
      try {
        const homebrewCheck = await invoke<{ exists: boolean; size: number } | null>(
          'check_homebrew_database',
          { path: homebrewDbPath }
        );

        if (homebrewCheck?.exists) {
          console.log('[OnboardingContext] Found Homebrew database, importing');
          await invoke('import_and_initialize_database', { legacyDbPath: homebrewDbPath });
          setDatabaseExists(true);
          return;
        }
      } catch (e) {
        console.log('[OnboardingContext] Homebrew check failed, continuing:', e);
      }
    }

    // Check default legacy database location
    try {
      const legacyPath = await invoke<string | null>('check_default_legacy_database');
      if (legacyPath) {
        console.log('[OnboardingContext] Found legacy database, importing');
        await invoke('import_and_initialize_database', { legacyDbPath: legacyPath });
        setDatabaseExists(true);
        return;
      }
    } catch (e) {
      console.log('[OnboardingContext] Legacy check failed, continuing:', e);
    }

    // No legacy database found - initialize fresh
    console.log('[OnboardingContext] No legacy database found, initializing fresh');
    await invoke('initialize_fresh_database');
    setDatabaseExists(true);
  };

  const isCompletingRef = useRef(false);

  // Auto-save on state change (debounced)
  useEffect(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    // Don't auto-save if completed (to avoid overwriting completion status)
    // Also don't auto-save if we are currently in the process of completing
    if (completed || isCompletingRef.current || !ready) return;

    saveTimeoutRef.current = setTimeout(() => {
      saveOnboardingStatus();
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [currentStep, parakeetDownloaded, summaryModelDownloaded, completed, ready]);

  // If the account disappears mid-flow, fall back to the sign-in step.
  useEffect(() => {
    if (ready && !accountOk && currentStep > STEP.SIGN_IN) setCurrentStep(STEP.SIGN_IN);
  }, [ready, accountOk, currentStep]);

  // Listen to Parakeet download progress
  useEffect(() => {
    const unlisten = listen<ParakeetDownloadProgressEvent>(
      'parakeet-model-download-progress',
      (event) => {
        const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
        if (modelName !== PARAKEET_MODEL) return;

        if (status === 'cancelled') {
          setIsBackgroundDownloading(false);
          setParakeetDownloaded(false);
          setParakeetProgress(0);
          setParakeetProgressInfo({
            percent: 0,
            downloadedMb: 0,
            totalMb: 0,
            speedMbps: 0,
          });
          return;
        }

        setParakeetProgress(progress);
        setParakeetProgressInfo({
          percent: progress,
          downloadedMb: downloaded_mb ?? 0,
          totalMb: total_mb ?? 0,
          speedMbps: speed_mbps ?? 0,
        });
        if (status === 'completed') {
          setParakeetDownloaded(true);
        }
      }
    );

    const unlistenComplete = listen<{ modelName: string }>(
      'parakeet-model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === PARAKEET_MODEL) {
          setParakeetDownloaded(true);
          setParakeetProgress(100);
        }
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'parakeet-model-download-error',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === PARAKEET_MODEL) {
          console.error('Parakeet download error:', event.payload.error);
        }
      }
    );

    return () => {
      unlisten.then(fn => fn());
      unlistenComplete.then(fn => fn());
      unlistenError.then(fn => fn());
    };
  }, []);

  // Listen to summary model (Built-in AI) download progress
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
    }>(
      'builtin-ai-download-progress',
      (event) => {
        const { model, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
        if (selectedSummaryModel && model === selectedSummaryModel) {
          setSummaryModelProgress(progress);
          setSummaryModelProgressInfo({
            percent: progress,
            downloadedMb: downloaded_mb ?? 0,
            totalMb: total_mb ?? 0,
            speedMbps: speed_mbps ?? 0,
          });
          if (status === 'completed' || progress >= 100) {
            setSummaryModelDownloaded(true);
          }
        }
      }
    );

    return () => {
      unlisten.then(fn => fn());
    };
  }, [selectedSummaryModel]);

  const checkDatabaseStatus = async () => {
    try {
      const isFirstLaunch = await invoke<boolean>('check_first_launch');
      setDatabaseExists(!isFirstLaunch);
      console.log('[OnboardingContext] Database exists:', !isFirstLaunch);
    } catch (error) {
      console.error('[OnboardingContext] Failed to check database status:', error);
      setDatabaseExists(false);
    }
  };

  const loadOnboardingStatus = async () => {
    try {
      await loadOnboardingStatusInner();
    } finally {
      setReady(true);
    }
  };

  const loadOnboardingStatusInner = async () => {
    // Check the Google account first: it decides how far a restart may resume.
    let acct: AccountStatus | null = null;
    try {
      acct = await account.status();
      setAccountStatusState(acct);
      accountOkRef.current = isAccountOk(acct);
    } catch (error) {
      console.warn('[OnboardingContext] account_status failed:', error);
    }

    try {
      const status = await invoke<OnboardingStatus | null>('get_onboarding_status');
      if (status) {
        console.log('[OnboardingContext] Loaded saved status:', status);

        if (status.completed) {
          setCurrentStep(status.current_step);
          setCompleted(true);
          setParakeetDownloaded(status.model_status.parakeet === 'downloaded');
          setSummaryModelDownloaded(status.model_status.summary === 'downloaded');
          if (status.model_status.selected_summary_model) {
            setSelectedSummaryModel(status.model_status.selected_summary_model);
          }
          console.log('[OnboardingContext] Restored completed onboarding status without model verification');
          return;
        }

        // Don't trust saved status - verify actual model status on disk
        const verifiedStatus = await verifyModelStatus(status);

        // Legacy (pre-sign-in) numbering: restart at Welcome. Never resume past sign-in without it.
        let resumeStep = status.version === STATUS_VERSION ? verifiedStatus.currentStep : STEP.WELCOME;
        if (resumeStep > STEP.SIGN_IN && !isAccountOk(acct)) resumeStep = STEP.SIGN_IN;
        if (resumeStep === STEP.PERMISSIONS && !hasPermissionsStepRef.current) resumeStep = STEP.DOWNLOAD;
        // The Done step is only reached through the flow; resume one step earlier.
        if (resumeStep >= STEP.DONE) resumeStep = STEP.BACKGROUND;
        setCurrentStep(resumeStep);
        setCompleted(verifiedStatus.completed);
        setParakeetDownloaded(verifiedStatus.parakeetDownloaded);
        setSummaryModelDownloaded(verifiedStatus.summaryModelDownloaded);
        if (verifiedStatus.selectedSummaryModel) {
          setSelectedSummaryModel(verifiedStatus.selectedSummaryModel);
        }

        console.log('[OnboardingContext] Verified status:', verifiedStatus);

        // Check if any downloads are active to restore isBackgroundDownloading state
        await checkActiveDownloads();
      } else {
        await initializeSummaryModelSelection();
      }
    } catch (error) {
      console.error('[OnboardingContext] Failed to load onboarding status:', error);
    }
  };

  // Verify that models actually exist on disk, not just trust saved JSON
  const verifyModelStatus = async (savedStatus: OnboardingStatus) => {
    let parakeetDownloaded = false;
    let summaryModelDownloaded = false;
    let selectedSummaryModel = '';

    // Verify Parakeet model exists on disk
    try {
      await invoke('parakeet_init');
      parakeetDownloaded = await invoke<boolean>('parakeet_has_available_models');
      console.log('[OnboardingContext] Parakeet verified on disk:', parakeetDownloaded);
    } catch (error) {
      console.warn('[OnboardingContext] Failed to verify Parakeet:', error);
      parakeetDownloaded = false;
    }

    // Verify the selected/recommended Summary model exists on disk.
    try {
      const recommendedModel = await invoke<string>('builtin_ai_get_recommended_model');
      setRecommendedSummaryModel(recommendedModel);
      const savedSelectedModel = savedStatus.model_status.selected_summary_model || '';
      const modelToCheck = savedSelectedModel || recommendedModel;
      const selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: modelToCheck,
        refresh: true,
      });
      const resolved = resolveOnboardingSummaryModelStatus({
        selectedModel: savedSelectedModel,
        recommendedModel,
        selectedModelReady,
      });
      selectedSummaryModel = resolved.selectedSummaryModel;
      summaryModelDownloaded = resolved.summaryModelDownloaded;
      console.log('[OnboardingContext] Summary model verified on disk:', summaryModelDownloaded, 'model:', selectedSummaryModel);
    } catch (error) {
      console.warn('[OnboardingContext] Failed to verify Summary model:', error);
      summaryModelDownloaded = false;
    }

    let currentStep = Math.max(1, Math.min(savedStatus.current_step, LAST_STEP));
    let completed = savedStatus.completed;

    // Trust the completed status - don't revert based on model downloads
    // Downloads continue in background; user stays in main app regardless
    return {
      currentStep,
      completed,
      parakeetDownloaded,
      summaryModelDownloaded,
      selectedSummaryModel,
    };
  };

  const saveOnboardingStatus = async () => {
    // Safety check: if we are in the process of completing, DO NOT save
    // This prevents a race condition where a download completion event triggers a save
    // that overwrites the "completed" status set by completeOnboarding
    if (isCompletingRef.current) {
      console.log('[OnboardingContext] Skipping saveOnboardingStatus because completion is in progress');
      return;
    }

    try {
      await invoke('save_onboarding_status_cmd', {
        status: {
          version: STATUS_VERSION,
          completed: completed,
          current_step: currentStep,
          model_status: {
            parakeet: parakeetDownloaded ? 'downloaded' : 'not_downloaded',
            summary: summaryModelDownloaded ? 'downloaded' : 'not_downloaded',
            selected_summary_model: selectedSummaryModel || undefined,
          },
          last_updated: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[OnboardingContext] Failed to save onboarding status:', error);
    }
  };

  const completeOnboarding = async () => {
    try {
      // Set completion flag to prevent race conditions with auto-save
      isCompletingRef.current = true;

      // Clear any pending auto-saves
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }

      let modelToSave = selectedSummaryModel;
      if (!modelToSave) {
        modelToSave = await invoke<string>('builtin_ai_get_recommended_model');
        setSelectedSummaryModel(modelToSave);
      }

      const selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: modelToSave,
        refresh: true,
      });
      setSummaryModelDownloaded(selectedModelReady);
      if (!selectedModelReady) {
        requestSummaryModelDownload(modelToSave);
      }

      // Onboarding always uses builtin-ai with selected model
      await invoke('complete_onboarding', {
        model: modelToSave,
      });
      setCompleted(true);
      console.log('[OnboardingContext] Onboarding completed with model:', modelToSave);

      // Reset the flag so subsequent state updates can be saved
      isCompletingRef.current = false;
    } catch (error) {
      console.error('[OnboardingContext] Failed to complete onboarding:', error);
      isCompletingRef.current = false; // Reset flag on error
      throw error; // Re-throw so PermissionsStep can handle it
    }
  };

  // Start background downloads for models.
  const startBackgroundDownloads = async ({
    includeParakeet,
    includeSummary,
    summaryModel,
  }: StartBackgroundDownloadsOptions) => {
    console.log('[OnboardingContext] Starting background downloads:', {
      includeParakeet,
      includeSummary,
      summaryModel,
    });

    try {
      if (!accountOkRef.current) {
        // Hard gate: nothing is downloaded before the user signs in with their company account.
        console.warn('[OnboardingContext] Downloads blocked: sign in required');
        throw new Error('Sign in with your Aiwah Labs account before downloading models.');
      }

      const shouldStartParakeet = includeParakeet && !parakeetDownloaded;
      const shouldStartSummary = includeSummary && !summaryModelDownloaded && !!summaryModel;

      if (!shouldStartParakeet && !shouldStartSummary) {
        if (includeSummary && !summaryModelDownloaded && !summaryModel) {
          console.warn('[OnboardingContext] Summary Model download skipped until recommendation is loaded');
        }
        return;
      }

      setIsBackgroundDownloading(true);

      // Start Parakeet download first (speech recognition - always required)
      if (shouldStartParakeet) {
        console.log('[OnboardingContext] Starting Parakeet download');
        invoke('parakeet_download_model', { modelName: PARAKEET_MODEL })
          .catch(err => console.error('[OnboardingContext] Parakeet download failed:', err));
      }

      // Start selected Summary Model download immediately so completion cannot race the request.
      if (shouldStartSummary && summaryModel) {
        requestSummaryModelDownload(summaryModel);
      }
    } catch (error) {
      console.error('[OnboardingContext] Failed to start background downloads:', error);
      setIsBackgroundDownloading(false);
      throw error;
    }
  };

  // Check if any models are currently downloading (for re-entry)
  const checkActiveDownloads = async () => {
    try {
      const models = await invoke<any[]>('parakeet_get_available_models');
      const isDownloading = models.some(m => m.status && (typeof m.status === 'object' ? 'Downloading' in m.status : m.status === 'Downloading'));
      
      if (isDownloading) {
        console.log('[OnboardingContext] Detected active background downloads on mount');
        setIsBackgroundDownloading(true);
      }
      
      // Also check for Built-in AI downloads if possible (though less critical as Parakeet is the main blocker)
      
    } catch (error) {
      console.warn('[OnboardingContext] Failed to check active downloads:', error);
    }
  };

  const retryParakeetDownload = async () => {
    if (!accountOkRef.current) throw new Error('Sign in required');
    console.log('[OnboardingContext] Retrying Parakeet download');
    try {
      await invoke('parakeet_retry_download', { modelName: PARAKEET_MODEL });
    } catch (error) {
      console.error('[OnboardingContext] Retry failed:', error);
      throw error;
    }
  };

  const setPermissionStatus = useCallback((permission: keyof OnboardingPermissions, status: PermissionStatus) => {
    setPermissions((prev: OnboardingPermissions) => ({
      ...prev,
      [permission]: status,
    }));
  }, []);

  const setAccountStatus = useCallback((s: AccountStatus) => {
    accountOkRef.current = isAccountOk(s);
    setAccountStatusState(s);
  }, []);

  // Clamp a target step: never past sign-in without a valid account, skip permissions off macOS.
  const resolveStep = useCallback((target: number, direction: 1 | -1 = 1) => {
    let step = Math.max(STEP.WELCOME, Math.min(target, LAST_STEP));
    if (step === STEP.PERMISSIONS && !hasPermissionsStepRef.current) {
      step += direction;
    }
    if (step > STEP.SIGN_IN && !accountOkRef.current) step = STEP.SIGN_IN;
    return Math.max(STEP.WELCOME, Math.min(step, LAST_STEP));
  }, []);

  const goToStep = useCallback((step: number) => {
    setCurrentStep((prev: number) => resolveStep(step, step >= prev ? 1 : -1));
  }, [resolveStep]);

  const goNext = useCallback(() => {
    setCurrentStep((prev: number) => resolveStep(prev + 1, 1));
  }, [resolveStep]);

  const goPrevious = useCallback(() => {
    setCurrentStep((prev: number) => resolveStep(prev - 1, -1));
  }, [resolveStep]);

  return (
    <OnboardingContext.Provider
      value={{
        currentStep,
        ready,
        accountOk,
        accountStatus,
        hasPermissionsStep,
        setAccountStatus,
        parakeetDownloaded,
        parakeetProgress,
        parakeetProgressInfo,
        summaryModelDownloaded,
        summaryModelProgress,
        summaryModelProgressInfo,
        selectedSummaryModel,
        recommendedSummaryModel,
        databaseExists,
        isBackgroundDownloading,
        permissions,
        permissionsSkipped,
        goToStep,
        goNext,
        goPrevious,
        setParakeetDownloaded,
        setSummaryModelDownloaded,
        setSelectedSummaryModel,
        setDatabaseExists,
        setPermissionStatus,
        setPermissionsSkipped,
        completeOnboarding,
        startBackgroundDownloads,
        retryParakeetDownload,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return context;
}
