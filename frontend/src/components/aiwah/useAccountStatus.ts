"use client"

// AIWAH: the signed-in Google account, shared by the shell, sidebar and home.

import { useEffect, useState } from "react"
import { account, type AccountStatus } from "@/lib/aiwah/api"

export function useAccountStatus() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    account
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        /* not running inside Tauri, or the command failed: treat as unknown */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { status, loading, setStatus }
}

export function firstName(name: string | null | undefined, email?: string | null): string | null {
  const n = (name ?? "").trim().split(/\s+/)[0]
  if (n) return n
  const local = (email ?? "").split("@")[0]
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : null
}
