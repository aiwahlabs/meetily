import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Mic, Sparkles, Check, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ProgressCircle } from '@/components/ui/progress-circle';
import { Alert } from '@/components/ui/alert';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { toast } from 'sonner';
import { getSummaryModelSizeLabel, getSummaryModelSizeMb } from '@/lib/onboarding-summary-model';
import type { ParakeetDownloadProgressEvent } from '@/lib/parakeet';

const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';

type DownloadStatus = 'waiting' | 'downloading' | 'completed' | 'cancelled' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  error?: string;
}

export function DownloadProgressStep() {
  const {
    goNext,
    goPrevious,
    accountOk,
    selectedSummaryModel,
    recommendedSummaryModel,
    parakeetDownloaded,
    setParakeetDownloaded,
    summaryModelDownloaded,
    setSummaryModelDownloaded,
    startBackgroundDownloads,
  } = useOnboarding();

  const [parakeetState, setParakeetState] = useState<DownloadState>({
    status: parakeetDownloaded ? 'completed' : 'waiting',
    progress: parakeetDownloaded ? 100 : 0,
    downloadedMb: 0,
    totalMb: 670,
    speedMbps: 0,
  });

  const [summaryState, setSummaryState] = useState<DownloadState>({
    status: summaryModelDownloaded ? 'completed' : 'waiting',
    progress: summaryModelDownloaded ? 100 : 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });

  const parakeetDownloadStartedRef = useRef(false);
  const summaryDownloadStartedRef = useRef(false);
  const retryingRef = useRef(false);
  const retryingSummaryRef = useRef(false);

  // Retry download handler
  const handleRetryDownload = async () => {
    // Prevent multiple simultaneous retries
    if (retryingRef.current) {
      console.log('[DownloadProgressStep] Retry already in progress, ignoring');
      return;
    }

    console.log('[DownloadProgressStep] Retrying Parakeet download');
    retryingRef.current = true;

    // Reset error state
    setParakeetState((prev) => ({
      ...prev,
      status: 'waiting',
      error: undefined,
      progress: 0,
      downloadedMb: 0,
      speedMbps: 0,
    }));

    try {
      await invoke('parakeet_retry_download', { modelName: PARAKEET_MODEL });
      // Progress events will update state
    } catch (error) {
      console.error('[DownloadProgressStep] Retry failed:', error);
      setParakeetState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Retry failed',
      }));

      toast.error('Download retry failed', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      // Allow retry again after 2 seconds
      setTimeout(() => {
        retryingRef.current = false;
      }, 2000);
    }
  };

  // Retry summary download handler
  const handleRetrySummaryDownload = async () => {
    // Prevent multiple simultaneous retries
    if (retryingSummaryRef.current) {
      console.log('[DownloadProgressStep] Summary retry already in progress, ignoring');
      return;
    }

    console.log('[DownloadProgressStep] Retrying summary model download');
    retryingSummaryRef.current = true;

    // Reset error state
    setSummaryState((prev) => ({
      ...prev,
      status: 'downloading',
      error: undefined,
      progress: 0,
      downloadedMb: 0,
      totalMb: getSummaryModelSizeMb(selectedSummaryModel || recommendedSummaryModel),
      speedMbps: 0,
    }));

    try {
      // Call download command directly (no retry command exists for built-in AI)
      const modelName = selectedSummaryModel;
      if (!modelName) {
        throw new Error('Summary model recommendation is not ready yet');
      }
      await invoke('builtin_ai_download_model', { modelName });
    } catch (error) {
      console.error('[DownloadProgressStep] Summary retry failed:', error);
      setSummaryState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Retry failed',
      }));

      toast.error('Summary model download retry failed', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      // Allow retry again after 2 seconds
      setTimeout(() => {
        retryingSummaryRef.current = false;
      }, 2000);
    }
  };

  // Start the required transcription model immediately; summary readiness must not block it.
  useEffect(() => {
    if (!accountOk) return; // never download before sign-in
    if (parakeetDownloadStartedRef.current) return;
    parakeetDownloadStartedRef.current = true;

    if (!parakeetDownloaded) {
      setParakeetState((prev) => ({ ...prev, status: 'downloading' }));
    }

    startBackgroundDownloads({
      includeParakeet: true,
      includeSummary: false,
    }).catch((error) => {
      console.error('Failed to start Parakeet download:', error);
      if (!parakeetDownloaded) {
        setParakeetState((prev) => ({ ...prev, status: 'error', error: String(error) }));
      }
    });
  }, [accountOk]);

  // Start the selected summary model only after the backend recommendation is known.
  useEffect(() => {
    if (!accountOk) return; // never download before sign-in
    if (summaryDownloadStartedRef.current) return;
    if (!selectedSummaryModel) return;
    summaryDownloadStartedRef.current = true;

    startSummaryDownload();
  }, [selectedSummaryModel, accountOk]);

  // Listen to Parakeet download progress
  useEffect(() => {
    const unlistenProgress = listen<ParakeetDownloadProgressEvent>(
      'parakeet-model-download-progress',
      (event) => {
        const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
        if (modelName !== PARAKEET_MODEL) return;

        if (status === 'cancelled') {
          setParakeetState((prev) => ({
            ...prev,
            status: 'cancelled',
            progress: 0,
            downloadedMb: 0,
            speedMbps: 0,
          }));
          setParakeetDownloaded(false);
          return;
        }

        setParakeetState((prev) => ({
          ...prev,
          status: status === 'completed' ? 'completed' : 'downloading',
          progress,
          downloadedMb: downloaded_mb ?? prev.downloadedMb,
          totalMb: total_mb ?? prev.totalMb,
          speedMbps: speed_mbps ?? prev.speedMbps,
        }));

        if (status === 'completed') {
          setParakeetDownloaded(true);
        }
      }
    );

    const unlistenComplete = listen<{ modelName: string }>(
      'parakeet-model-download-complete',
      (event) => {
        if (event.payload.modelName === PARAKEET_MODEL) {
          setParakeetState((prev) => ({ ...prev, status: 'completed', progress: 100 }));
          setParakeetDownloaded(true);
        }
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'parakeet-model-download-error',
      (event) => {
        if (event.payload.modelName === PARAKEET_MODEL) {
          setParakeetState((prev) => ({
            ...prev,
            status: 'error',
            error: event.payload.error,
          }));
        }
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  // Listen to Summary Model download progress (always downloading for builtin-ai)
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
      error?: string;
    }>('builtin-ai-download-progress', (event) => {
      const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } = event.payload;
      if (selectedSummaryModel && model === selectedSummaryModel) {
        setSummaryState((prev) => ({
          ...prev,
          status: status === 'completed'
            ? 'completed'
            : status === 'error'
            ? 'error'
            : 'downloading',
          progress,
          downloadedMb: downloaded_mb ?? prev.downloadedMb,
          totalMb: (total_mb ?? prev.totalMb) || getSummaryModelSizeMb(model),
          speedMbps: speed_mbps ?? prev.speedMbps,
          error: status === 'error' ? error : undefined,
        }));

        if (status === 'completed' || progress >= 100) {
          setSummaryModelDownloaded(true);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [selectedSummaryModel]);

  useEffect(() => {
    const modelForSize = selectedSummaryModel || recommendedSummaryModel;
    if (!modelForSize) return;

    setSummaryState((prev) => ({
      ...prev,
      status: summaryModelDownloaded
        ? 'completed'
        : prev.status === 'completed'
        ? 'waiting'
        : prev.status,
      progress: summaryModelDownloaded
        ? 100
        : prev.status === 'completed'
        ? 0
        : prev.progress,
      totalMb: prev.totalMb || getSummaryModelSizeMb(modelForSize),
    }));
  }, [selectedSummaryModel, recommendedSummaryModel, summaryModelDownloaded]);

  const startSummaryDownload = async () => {
    if (!summaryModelDownloaded && selectedSummaryModel) {
      try {
        setSummaryState((prev) => ({
          ...prev,
          status: 'downloading',
          totalMb: getSummaryModelSizeMb(selectedSummaryModel),
        }));
        await startBackgroundDownloads({
          includeParakeet: false,
          includeSummary: true,
          summaryModel: selectedSummaryModel,
        });
      } catch (error) {
        console.error('Failed to start summary model download:', error);
        setSummaryState((prev) => ({ ...prev, status: 'error', error: String(error) }));
      }
    }
  };

  const handleContinue = async () => {
    // Verify actual model availability (catches state drift)
    try {
      await invoke('parakeet_init');
      const actuallyAvailable = await invoke<boolean>('parakeet_has_available_models');

      if (actuallyAvailable && !parakeetDownloaded) {
        console.log('[DownloadProgressStep] Model available but state not updated');
        setParakeetDownloaded(true);
        setParakeetState((prev) => ({
          ...prev,
          status: 'completed',
          progress: 100,
        }));
      } else if (
        !actuallyAvailable &&
        (parakeetState.status === 'error' || parakeetState.status === 'cancelled')
      ) {
        toast.error('Transcription engine required', {
          description: 'Please retry the download before continuing.',
        });
        return;
      }
    } catch (error) {
      console.warn('[DownloadProgressStep] Failed to verify model:', error);
    }

    // Check if downloads are complete for toast notification
    const downloadsComplete = parakeetState.status === 'completed' &&
      summaryState.status === 'completed';

    // Show toast if downloads still in progress
    if (!downloadsComplete) {
      toast.info('Downloads will continue in the background', {
        description: 'You can start using the app. Recording will be available once speech recognition is ready.',
        duration: 5000,
      });
    }

    goNext();
  };

  const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

  const renderDownloadCard = (
    title: string,
    blurb: string,
    icon: React.ReactNode,
    state: DownloadState,
    sizeLabel: string,
    onRetry: () => void
  ) => {
    const failed = state.status === 'error' || state.status === 'cancelled';
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {state.status === 'completed' ? <Check className="size-5 text-primary" aria-hidden="true" /> : icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-title font-medium text-foreground">{title}</p>
            <p className="text-sub text-muted-foreground">
              {state.status === 'completed' ? 'Ready' : `${blurb} ${sizeLabel}`.trim()}
            </p>
          </div>
          {state.status === 'downloading' && (
            <ProgressCircle value={state.progress} size={32} label={`${title} download`} />
          )}
          {state.status === 'waiting' && <span className="text-sub text-muted-foreground">Waiting</span>}
        </div>

        {state.status === 'downloading' && (
          <div className="mt-3">
            <Progress
              value={state.progress}
              size="sm"
              label={`${title} download`}
              description={
                <span className="flex justify-between">
                  <span>
                    {fmtMb(state.downloadedMb)}
                    {state.totalMb > 0 ? ` of ${fmtMb(state.totalMb)}` : ''}
                  </span>
                  {state.speedMbps > 0 && <span>{state.speedMbps.toFixed(1)} MB/s</span>}
                </span>
              }
            />
          </div>
        )}

        {failed && (
          <Alert
            tone="destructive"
            size="sm"
            className="mt-3"
            title={state.status === 'cancelled' ? 'Download cancelled' : 'Download failed'}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCw className="size-3.5" aria-hidden="true" />
                Try again
              </Button>
            }
          >
            {state.error || 'Check your connection and try again.'}
          </Alert>
        )}
      </div>
    );
  };

  const bothDone = parakeetDownloaded && summaryModelDownloaded;

  return (
    <OnboardingContainer
      title="Download the models"
      description="About 700 MB for transcription, plus a summary model. You can keep using your computer."
      onBack={goPrevious}
      onNext={handleContinue}
      nextDisabled={!parakeetDownloaded}
      nextLabel={parakeetDownloaded ? 'Continue' : 'Downloading…'}
      footnote={
        parakeetDownloaded && !bothDone
          ? 'The summary model keeps downloading in the background.'
          : undefined
      }
    >
      {renderDownloadCard(
        'Transcription',
        'Turns speech into text on this device.',
        <Mic className="size-5" aria-hidden="true" />,
        parakeetState,
        '',
        handleRetryDownload
      )}
      {renderDownloadCard(
        'Summaries',
        'Writes the summary and action items.',
        <Sparkles className="size-5" aria-hidden="true" />,
        summaryState,
        getSummaryModelSizeLabel(selectedSummaryModel || recommendedSummaryModel),
        handleRetrySummaryDownload
      )}
    </OnboardingContainer>
  );
}
