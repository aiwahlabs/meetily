'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { AuthCard } from '@/components/ui/auth';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { account, type AccountStatus } from '@/lib/aiwah/api';

export interface GoogleSignInCardProps {
  onSignedIn?: (s: AccountStatus) => void;
  title?: string;
  description?: string;
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className ?? 'size-[18px]'}>
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.94H1.28v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.29 14.3a7.2 7.2 0 0 1 0-4.6v-3.1H1.28a12 12 0 0 0 0 10.8l4.01-3.1Z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.6l4.01 3.1C6.23 6.87 8.88 4.76 12 4.76Z" />
    </svg>
  );
}

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const msg = raw.trim();
  const lower = msg.toLowerCase();
  if (!msg) return 'Sign-in did not finish. Try again.';
  if (lower.includes('cancel') || lower.includes('denied') || lower.includes('access_denied')) {
    return 'Sign-in was cancelled. Try again when you are ready.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'Sign-in took too long. Try again.';
  }
  return msg;
}

export function GoogleSignInCard({
  onSignedIn,
  title = 'Sign in to Aiwah Minutes',
  description = "Sign in with your Google account. We'll also read your calendar so meetings are named and recorded on time.",
}: GoogleSignInCardProps) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lets Cancel ignore a sign-in that is still pending in the backend.
  const attemptRef = useRef(0);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  useEffect(() => {
    let alive = true;
    account
      .status()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.signedIn && s.domainOk) onSignedInRef.current?.(s);
      })
      .catch(() => {})
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setBusy(true);
    setError(null);
    try {
      const s = await account.signIn();
      if (attempt !== attemptRef.current) return;
      setStatus(s);
      if (s.signedIn && !s.domainOk) {
        setError('This account cannot be used here. Choose another Google account and try again.');
        return;
      }
      if (s.signedIn && s.domainOk) onSignedInRef.current?.(s);
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setError(describeError(err));
    } finally {
      if (attempt === attemptRef.current) setBusy(false);
    }
  }, []);

  const cancel = () => {
    attemptRef.current++;
    setBusy(false);
    setError('Sign-in was cancelled. Try again when you are ready.');
  };

  const noClient = status !== null && status.hasClientId === false;
  const signedIn = !!status && status.signedIn && status.domainOk;

  const logo = (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo-collapsed.png" alt="" className="size-11 rounded-xl" />
  );

  if (signedIn && status) {
    const email = status.email ?? '';
    return (
      <AuthCard title="You're signed in" description="Signed in with Google." logo={logo}>
        <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 ring-1 ring-border">
          <Avatar seed={email || 'user'} src={status.picture ?? undefined} name={status.name ?? email} size={36} />
          <div className="min-w-0 flex-1">
            {status.name && <p className="truncate text-body font-medium text-foreground">{status.name}</p>}
            <p className="truncate text-sub text-muted-foreground">{email}</p>
          </div>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Signed in</span>
          </span>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={title} description={description} logo={logo} level={2}>
      <div className="grid gap-3" aria-busy={busy}>
        {noClient && (
          <Alert tone="warning" size="sm">
            Sign-in isn&apos;t set up in this build yet. Ask your admin.
          </Alert>
        )}
        {error && !busy && (
          <Alert tone="destructive" size="sm" role="alert">
            {error}
          </Alert>
        )}
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          onClick={signIn}
          disabled={busy || checking || noClient}
          loading={busy}
        >
          {!busy && <GoogleMark />}
          {busy ? 'Waiting for Google…' : error ? 'Try again' : 'Continue with Google'}
        </Button>
        {busy && (
          <div className="grid gap-1 text-center" role="status">
            <p className="text-sub text-muted-foreground">Finish signing in in your browser.</p>
            <button
              type="button"
              onClick={cancel}
              className="mx-auto text-sub font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}

export default GoogleSignInCard;
