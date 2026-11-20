"use client"

import { useCallback, useEffect, useState } from "react"
import { CalendarCheck } from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { SettingsRow, SettingsSection } from "@/components/ui/settings-page"
import { account, type AccountStatus } from "@/lib/aiwah/api"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function AccountSection() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await account.status())
      setLoadError(null)
    } catch (e) {
      setLoadError(msg(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const signIn = async () => {
    setSigningIn(true)
    setSignInError(null)
    toast.message("Finish signing in to Google in your browser.")
    try {
      setStatus(await account.signIn())
    } catch (e) {
      setSignInError(msg(e))
    } finally {
      setSigningIn(false)
    }
  }

  const signOut = async () => {
    try {
      await account.signOut()
    } catch (e) {
      toast.error(msg(e))
      throw e
    }
    window.location.reload()
  }

  return (
    <SettingsSection
      id="account"
      title="Account"
      description="Your Google account signs you in and lets Aiwah Minutes read your calendar."
    >
      {status === null ? (
        <SettingsRow label="Google account" description={loadError ?? "Loading…"}>
          {loadError && (
            <Button size="sm" variant="outline" onClick={load}>
              Try again
            </Button>
          )}
        </SettingsRow>
      ) : status.signedIn ? (
        <SettingsRow
          label={status.name ?? status.email ?? "Signed in"}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {status.name && <span>{status.email}</span>}
              <Badge tone="success" size="sm" dot>
                <CalendarCheck className="size-3" aria-hidden /> Calendar connected · read-only
              </Badge>
            </span>
          }
          keywords={["google", "email", "calendar", "sign out", "log out"]}
        >
          <Avatar seed={status.email ?? "me"} src={status.picture ?? undefined} name={status.name ?? undefined} size={32} />
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Sign out of Aiwah Minutes?"
            description="Calendar reminders and automatic recording stop until you sign in again. Your meetings stay on this computer."
            actionLabel="Sign out"
            onConfirm={signOut}
            trigger={
              <Button size="sm" variant="outline">
                Sign out
              </Button>
            }
          />
        </SettingsRow>
      ) : (
        <SettingsRow
          label="Not signed in"
          description={
            signInError ??
            (status.hasClientId
              ? "Sign in with your @aiwahlabs.com Google account to connect your calendar."
              : "Google sign-in is not set up in this build yet. Ask an admin.")
          }
          keywords={["google", "sign in", "log in", "calendar"]}
        >
          <Button size="sm" onClick={signIn} loading={signingIn} disabled={!status.hasClientId}>
            Sign in
          </Button>
        </SettingsRow>
      )}
    </SettingsSection>
  )
}
