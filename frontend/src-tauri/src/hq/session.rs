//! AIWAH: one login. Signing in with Google in Minutes also signs the user in to HQ.
//!
//! The Google `id_token` is exchanged at `POST {HQ}/v1/auth/oidc/id-token` for an HQ session:
//! a short-lived access token (kept in memory) and a refresh token (kept in the OS credential
//! store, see `autorec::secrets::HQ_REFRESH_TOKEN`). The access token is the Bearer for every HQ
//! call; it is refreshed with `POST /v1/auth/refresh { refreshToken }` shortly before it expires
//! and once more if HQ answers 401. Refresh tokens rotate, so refreshes are serialised: two
//! concurrent refreshes with the same token would look like token reuse to HQ and kill the session.
//!
//! The pasted HQ API key stays as a fallback (see `hq::send_authed`). Tokens are never logged.

use crate::autorec::secrets;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;

/// Refresh when the access token has less than this left.
const REFRESH_MARGIN_SECS: i64 = 60;

pub const NOT_ALLOWED_MESSAGE: &str = "You don't have access to Aiwah HQ yet. Ask an Aiwah admin to invite you.";

#[derive(Default)]
struct State {
    access: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    /// Mirror of the keychain copy; the only copy where no OS credential store exists.
    refresh: Option<String>,
    email: Option<String>,
}

static STATE: Mutex<State> = Mutex::new(State { access: None, expires_at: None, refresh: None, email: None });
/// Serialises refreshes (rotation) and exchanges.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq)]
pub enum Exchange {
    SignedIn { email: Option<String>, name: Option<String> },
    /// HQ refused this Google account (403): not invited and not on a listed domain.
    NotAllowed,
    /// HQ not reachable, the route does not exist yet (404), or HQ rejected the token for a
    /// server-side reason (401/5xx). Callers keep today's behaviour and may use an API key.
    Unavailable(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<String>,
    user: Option<GrantUser>,
}

#[derive(Deserialize)]
struct GrantUser {
    email: Option<String>,
    name: Option<String>,
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Is there an HQ session (access token in memory, or a stored refresh token)?
pub fn has_session() -> bool {
    {
        let s = lock();
        if s.access.is_some() || s.refresh.is_some() {
            return true;
        }
    }
    matches!(secrets::get(secrets::HQ_REFRESH_TOKEN), Ok(Some(_)))
}

pub fn session_email() -> Option<String> {
    lock().email.clone()
}

fn refresh_token() -> Option<String> {
    if let Some(r) = lock().refresh.clone() {
        return Some(r);
    }
    match secrets::get(secrets::HQ_REFRESH_TOKEN) {
        Ok(Some(r)) => {
            lock().refresh = Some(r.clone());
            Some(r)
        }
        _ => None,
    }
}

fn store(grant: &Grant, fallback_refresh: Option<&str>) {
    let refresh = grant.refresh_token.clone().or_else(|| fallback_refresh.map(str::to_string));
    let expires_at = grant
        .expires_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|| Utc::now() + ChronoDuration::minutes(10));
    if let Some(r) = &refresh {
        // `stash` returns Some(value) when the OS store is unavailable: then memory is the only copy.
        let _ = secrets::stash(secrets::HQ_REFRESH_TOKEN, Some(r));
    }
    let mut s = lock();
    s.access = Some(grant.access_token.clone());
    s.expires_at = Some(expires_at);
    s.refresh = refresh;
    if let Some(u) = &grant.user {
        if u.email.is_some() {
            s.email = u.email.clone();
        }
    }
}

fn wipe_local() {
    let _ = secrets::set(secrets::HQ_REFRESH_TOKEN, None);
    let mut s = lock();
    *s = State::default();
}

/// Exchange a Google `id_token` for an HQ session.
pub async fn exchange_id_token(base_url: &str, id_token: &str) -> Exchange {
    let _guard = REFRESH_LOCK.lock().await;
    let client = match super::client(Duration::from_secs(20)) {
        Ok(c) => c,
        Err(e) => return Exchange::Unavailable(e),
    };
    let url = format!("{}/v1/auth/oidc/id-token", base_url.trim_end_matches('/'));
    let resp = match client.post(url).json(&serde_json::json!({ "idToken": id_token })).send().await {
        Ok(r) => r,
        Err(e) => return Exchange::Unavailable(format!("Could not reach HQ: {}", e)),
    };
    let status = resp.status().as_u16();
    match status {
        200 => match resp.json::<Grant>().await {
            Ok(grant) => {
                store(&grant, None);
                let user = grant.user.as_ref();
                Exchange::SignedIn { email: user.and_then(|u| u.email.clone()), name: user.and_then(|u| u.name.clone()) }
            }
            Err(e) => Exchange::Unavailable(format!("Unexpected HQ response: {}", e)),
        },
        // HQ understood the token and said no (not_allowed / no_auto_provision / inactive).
        403 => Exchange::NotAllowed,
        // 404: old server without the route. 401: HQ not configured to trust this app yet. Others: outage.
        s => Exchange::Unavailable(format!("HQ answered {} to the sign-in exchange", s)),
    }
}

/// The access token to send as Bearer, refreshing when it is (nearly) expired or `force` is set.
/// `Ok(None)` = there is no HQ session (use the API key). `Err` = a session exists but HQ could
/// not be reached just now (retry later; the session is kept).
pub async fn bearer(base_url: &str, force: bool) -> Result<Option<String>, String> {
    if !has_session() {
        return Ok(None);
    }
    let fresh = |s: &State| match (&s.access, s.expires_at) {
        (Some(a), Some(exp)) if exp - Utc::now() > ChronoDuration::seconds(REFRESH_MARGIN_SECS) => Some(a.clone()),
        _ => None,
    };
    if !force {
        if let Some(a) = fresh(&*lock()) {
            return Ok(Some(a));
        }
    }
    let seen_access = lock().access.clone();
    let _guard = REFRESH_LOCK.lock().await;
    // Someone else refreshed while we waited: use theirs instead of rotating again.
    {
        let s = lock();
        if s.access != seen_access {
            if let Some(a) = fresh(&*s) {
                return Ok(Some(a));
            }
        }
    }
    let Some(refresh) = refresh_token() else {
        return Ok(None);
    };
    let client = super::client(Duration::from_secs(20))?;
    let url = format!("{}/v1/auth/refresh", base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .json(&serde_json::json!({ "refreshToken": refresh }))
        .send()
        .await
        .map_err(|e| format!("Could not reach HQ to refresh your sign-in: {}", e))?;
    match resp.status().as_u16() {
        200 => {
            let grant: Grant = resp.json().await.map_err(|e| format!("Unexpected HQ response: {}", e))?;
            store(&grant, Some(&refresh));
            Ok(Some(grant.access_token))
        }
        // The session is gone for good (expired, revoked, reuse): forget it and fall back to the key.
        401 | 403 => {
            log::warn!("HQ session is no longer valid; signed out of HQ");
            wipe_local();
            Ok(None)
        }
        s => Err(format!("HQ answered {} while refreshing your sign-in", s)),
    }
}

/// Sign out of HQ: revoke the token family (best effort) and forget the tokens.
pub async fn sign_out(base_url: &str) {
    let refresh = refresh_token();
    if let Some(r) = refresh {
        if let Ok(client) = super::client(Duration::from_secs(10)) {
            let url = format!("{}/v1/auth/logout", base_url.trim_end_matches('/'));
            let _ = client.post(url).json(&serde_json::json!({ "refreshToken": r })).send().await;
        }
    }
    wipe_local();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_parses_native_response() {
        let g: Grant = serde_json::from_str(
            r#"{"accessToken":"a","refreshToken":"r","tokenType":"Bearer","expiresAt":"2030-01-01T00:00:00.000Z","refreshExpiresAt":"2030-02-01T00:00:00.000Z","user":{"id":"u","email":"x@y.zz"}}"#,
        )
        .unwrap();
        assert_eq!(g.access_token, "a");
        assert_eq!(g.refresh_token.as_deref(), Some("r"));
        assert_eq!(g.user.unwrap().email.as_deref(), Some("x@y.zz"));
    }

    #[test]
    fn grant_without_refresh_token_keeps_the_old_one() {
        let g: Grant = serde_json::from_str(r#"{"accessToken":"a"}"#).unwrap();
        assert!(g.refresh_token.is_none());
    }
}
