import React from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { PermissionRowProps } from '@/types/onboarding';

export function PermissionRow({ icon, title, description, status, isPending = false, onAction }: PermissionRowProps) {
  const isAuthorized = status === 'authorized';
  const isDenied = status === 'denied';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors',
        isAuthorized ? 'border-primary/40' : isDenied ? 'border-destructive/40' : 'border-border'
      )}
    >
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          isAuthorized ? 'bg-primary/10 text-primary' : isDenied ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-title font-medium text-foreground">{title}</p>
        <p className="text-sub text-muted-foreground">
          {isDenied ? 'Access was denied. Allow it in System Settings, then come back.' : description}
        </p>
      </div>
      {isAuthorized ? (
        <span className="flex items-center gap-1 text-sub font-medium text-primary">
          <Check className="size-4" aria-hidden="true" />
          Allowed
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={onAction} loading={isPending} disabled={isPending}>
          {isDenied ? (
            <>
              <TriangleAlert className="size-3.5" aria-hidden="true" />
              Open Settings
            </>
          ) : (
            'Allow'
          )}
        </Button>
      )}
    </div>
  );
}
