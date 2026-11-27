//! AIWAH: Google Calendar integration (installed-app OAuth with PKCE + loopback redirect).
//!
//! Tokens live in the local SQLite table `aiwah_google_calendar` (single row, id = 'default'),
//! the same way the HQ key is stored. Tokens, codes and secrets are never logged.
//! Only read-only calendar event access is requested.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ROW_ID: &str = "default";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const EVENTS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const SCOPES: &str = "https://www.googleapis.com/auth/calendar.events.readonly openid email profile";
// AIWAH: who may use the app is decided by HQ (invite or listed domain), not by an email domain
// hard-coded here: see `connect` and `hq::session`.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MEETING_HOSTS: &[&str] = &["zoom.us", "teams.microsoft.com", "teams.live.com", "meet.google.com"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub meeting_url: Option<String>,
    pub attendees: Vec<EventAttendee>,
    pub organizer_email: Option<String>,
    pub self_response: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAttendee {
    pub email: String,
    pub name: Option<String>,
    pub is_self: bool,
    /// accepted | declined | tentative | needsAction (Google's responseStatus)
    #[serde(default)]
    pub response: Option<String>,
    #[serde(default)]
    pub is_organizer: bool,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarStatus {
    pub connected: bool,
    pub account_email: Option<String>,
    pub has_client_id: bool,
    pub client_id_hint: Option<String>,
}

// ── Storage ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct Row {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    access_token: Option<String>,
    access_token_expires_at: Option<String>,
    account_email: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

fn now_str() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

type RowTuple = (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

async fn load_row(pool: &SqlitePool) -> Result<Row, String> {
    let r: Option<RowTuple> = sqlx::query_as(
        "SELECT client_id, client_secret, refresh_token, access_token, access_token_expires_at, account_email
         FROM aiwah_google_calendar WHERE id = ?",
    )
    .bind(ROW_ID)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read calendar settings: {}", e))?;
    Ok(match r {
        Some((client_id, client_secret, refresh_token, access_token, access_token_expires_at, account_email)) => {
            // AIWAH: secrets live in the OS credential store; move legacy DB copies there.
            use super::secrets;
            let (client_secret, m1) = secrets::load(secrets::GOOGLE_CLIENT_SECRET, client_secret);
            let (refresh_token, m2) = secrets::load(secrets::GOOGLE_REFRESH_TOKEN, refresh_token);
            let (access_token, m3) = secrets::load(secrets::GOOGLE_ACCESS_TOKEN, access_token);
            if m1 || m2 || m3 {
                let _ = sqlx::query(
                    "UPDATE aiwah_google_calendar SET client_secret = NULL, refresh_token = NULL, access_token = NULL WHERE id = ?",
                )
                .bind(ROW_ID)
                .execute(pool)
                .await;
            }
            Row { client_id, client_secret, refresh_token, access_token, access_token_expires_at, account_email }
        }
        None => Row::default(),
    })
}

async fn save_row(pool: &SqlitePool, row: &Row) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO aiwah_google_calendar
           (id, client_id, client_secret, refresh_token, access_token, access_token_expires_at, account_email, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at,
           account_email = excluded.account_email,
           updated_at = excluded.updated_at",
    )
    .bind(ROW_ID)
    .bind(&row.client_id)
    .bind(super::secrets::stash(super::secrets::GOOGLE_CLIENT_SECRET, row.client_secret.as_deref()))
    .bind(super::secrets::stash(super::secrets::GOOGLE_REFRESH_TOKEN, row.refresh_token.as_deref()))
    .bind(super::secrets::stash(super::secrets::GOOGLE_ACCESS_TOKEN, row.access_token.as_deref()))
    .bind(&row.access_token_expires_at)
    .bind(&row.account_email)
    .bind(now_str())
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save calendar settings: {}", e))?;
    Ok(())
}

/// (client_id, client_secret) from the row, falling back to compile-time values.
fn effective_client(row: &Row) -> Option<(String, Option<String>)> {
    if let Some(id) = non_empty(&row.client_id) {
        return Some((id.to_string(), non_empty(&row.client_secret).map(str::to_string)));
    }
    let id = option_env!("AIWAH_GOOGLE_CLIENT_ID").map(str::trim).filter(|v| !v.is_empty())?;
    let secret = option_env!("AIWAH_GOOGLE_CLIENT_SECRET").map(str::trim).filter(|v| !v.is_empty());
    Some((id.to_string(), secret.map(str::to_string)))
}

fn build_status(row: &Row) -> CalendarStatus {
    let client = effective_client(row);
    let hint = client.as_ref().map(|(id, _)| {
        let c: Vec<char> = id.chars().collect();
        if c.len() > 14 {
            format!("{}…{}", c[..8].iter().collect::<String>(), c[c.len() - 6..].iter().collect::<String>())
        } else {
            "set".to_string()
        }
    });
    CalendarStatus {
        connected: non_empty(&row.refresh_token).is_some(),
        account_email: non_empty(&row.account_email).map(str::to_string),
        has_client_id: client.is_some(),
        client_id_hint: hint,
    }
}

async fn status(pool: &SqlitePool) -> Result<CalendarStatus, String> {
    Ok(build_status(&load_row(pool).await?))
}

pub async fn is_connected(pool: &SqlitePool) -> bool {
    load_row(pool).await.map(|r| non_empty(&r.refresh_token).is_some()).unwrap_or(false)
}

// ── PKCE helpers ───────────────────────────────────────────────────────────────

fn base64url(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() * 4 + 2) / 3);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        }
    }
    out
}

fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in s.trim_end_matches('=').bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

/// Minimal SHA-256 (sha2 is only a build-dependency of this crate).
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] =
        [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

fn pkce_challenge(verifier: &str) -> String {
    base64url(&sha256(verifier.as_bytes()))
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    id_token: Option<String>,
}

enum TokenError {
    InvalidGrant,
    Other(String),
}

async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
    let client = http().map_err(TokenError::Other)?;
    let resp = client
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| TokenError::Other(format!("Could not reach Google: {}", e)))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let code = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        if code == "invalid_grant" {
            return Err(TokenError::InvalidGrant);
        }
        let desc = v.get("error_description").and_then(|e| e.as_str()).unwrap_or("");
        return Err(TokenError::Other(
            format!("Google token error ({}): {} {}", status.as_u16(), code, desc).trim().to_string(),
        ));
    }
    serde_json::from_str(&body).map_err(|e| TokenError::Other(format!("Unexpected Google token response: {}", e)))
}

fn id_token_claims(id_token: &str) -> Option<serde_json::Value> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64url_decode(payload)?;
    serde_json::from_slice(&bytes).ok()
}

fn email_from_id_token(id_token: &str) -> Option<String> {
    id_token_claims(id_token)?.get("email").and_then(|e| e.as_str()).map(str::to_string)
}

/// A valid access token, refreshing if it expires within 60 s.
async fn access_token(pool: &SqlitePool) -> Result<String, String> {
    let mut row = load_row(pool).await?;
    let refresh = non_empty(&row.refresh_token)
        .map(str::to_string)
        .ok_or_else(|| "Google Calendar is not connected. Connect it in Settings → Calendar.".to_string())?;

    if let (Some(tok), Some(exp)) = (non_empty(&row.access_token), non_empty(&row.access_token_expires_at)) {
        if let Ok(exp) = DateTime::parse_from_rfc3339(exp) {
            if exp.with_timezone(&Utc) - ChronoDuration::seconds(60) > Utc::now() {
                return Ok(tok.to_string());
            }
        }
    }

    let (client_id, client_secret) =
        effective_client(&row).ok_or_else(|| "Google sign-in isn't set up in this build yet. Ask your admin.".to_string())?;
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if let Some(s) = client_secret.as_deref() {
        form.push(("client_secret", s));
    }
    match token_request(&form).await {
        Ok(t) => {
            let token = t.access_token.ok_or("Google did not return an access token")?;
            row.access_token = Some(token.clone());
            row.access_token_expires_at = Some(
                (Utc::now() + ChronoDuration::seconds(t.expires_in.unwrap_or(3600))).to_rfc3339_opts(SecondsFormat::Secs, true),
            );
            if let Some(r) = t.refresh_token {
                row.refresh_token = Some(r);
            }
            save_row(pool, &row).await?;
            Ok(token)
        }
        Err(TokenError::InvalidGrant) => {
            row.refresh_token = None;
            row.access_token = None;
            row.access_token_expires_at = None;
            let _ = save_row(pool, &row).await;
            Err("Google Calendar access expired or was revoked. Reconnect Google Calendar in Settings → Calendar.".to_string())
        }
        Err(TokenError::Other(e)) => Err(e),
    }
}

// ── OAuth connect flow ─────────────────────────────────────────────────────────

fn html_page(ok: bool, msg: &str) -> String {
    let title = if ok { "Connected" } else { "Connection failed" };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Aiwah Minutes</title></head>\
         <body style=\"font-family:system-ui,sans-serif;text-align:center;margin-top:20vh\">\
         <h2>{}</h2><p>{}</p></body></html>",
        title, msg
    )
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

type Callback = (Option<String>, Option<String>, Option<String>);

/// Parse the request line `GET /?code=..&state=.. HTTP/1.1` into (code, state, error).
fn parse_callback(request: &str) -> Option<Callback> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{}", target)).ok()?;
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if code.is_none() && error.is_none() {
        return None;
    }
    Some((code, state, error))
}

async fn wait_for_callback(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| format!("Callback listener failed: {}", e))?;
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        match parse_callback(&req) {
            None => {
                // favicon or other stray request; keep waiting
                respond(&mut stream, "404 Not Found", "").await;
            }
            Some((code, state, error)) => {
                if state.as_deref() != Some(expected_state) {
                    respond(
                        &mut stream,
                        "400 Bad Request",
                        &html_page(false, "Invalid sign-in state. Please try again from Aiwah Minutes."),
                    )
                    .await;
                    return Err("Google sign-in failed: state mismatch".to_string());
                }
                if let Some(err) = error {
                    respond(
                        &mut stream,
                        "200 OK",
                        &html_page(false, "Google Calendar was not connected. You can close this tab."),
                    )
                    .await;
                    return Err(format!("Google sign-in was not completed ({})", err));
                }
                return match code {
                    Some(c) => {
                        respond(
                            &mut stream,
                            "200 OK",
                            &html_page(true, "Aiwah Minutes is connected to Google Calendar. You can close this tab."),
                        )
                        .await;
                        Ok(c)
                    }
                    None => Err("Google sign-in returned no code".to_string()),
                };
            }
        }
    }
}

async fn connect(pool: &SqlitePool) -> Result<CalendarStatus, String> {
    let mut row = load_row(pool).await?;
    let (client_id, client_secret) =
        effective_client(&row).ok_or_else(|| "Google sign-in isn't set up in this build yet. Ask your admin.".to_string())?;

    let verifier = random_string(64);
    let challenge = pkce_challenge(&verifier);
    let state = random_string(32);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start local sign-in listener: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);

    let auth_url = url::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| format!("Failed to build sign-in URL: {}", e))?;

    open::that(auth_url.as_str()).map_err(|e| format!("Could not open the browser: {}", e))?;

    let code = tokio::time::timeout(CALLBACK_TIMEOUT, wait_for_callback(&listener, &state))
        .await
        .map_err(|_| "Timed out waiting for Google sign-in (5 minutes)".to_string())??;
    drop(listener);

    let mut form: Vec<(&str, &str)> = vec![
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(s) = client_secret.as_deref() {
        form.push(("client_secret", s));
    }
    let t = match token_request(&form).await {
        Ok(t) => t,
        Err(TokenError::InvalidGrant) => return Err("Google rejected the sign-in code. Please try again.".to_string()),
        Err(TokenError::Other(e)) => return Err(e),
    };
    // AIWAH: one login. The id_token comes straight from Google's token endpoint over TLS, so its
    // claims can be trusted here; HQ verifies the signature itself when we hand it over below.
    let claims = t.id_token.as_deref().and_then(id_token_claims).unwrap_or(serde_json::Value::Null);
    let email = claims.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let verified = claims.get("email_verified").and_then(|v| v.as_bool()).unwrap_or(false);
    let revoke_google = |t: &TokenResponse| {
        let tok = t.refresh_token.clone().or_else(|| t.access_token.clone());
        async move {
            if let (Some(tok), Ok(c)) = (tok, http()) {
                let _ = c.post(REVOKE_URL).form(&[("token", tok.as_str())]).send().await;
            }
        }
    };
    if email.is_empty() || !verified {
        revoke_google(&t).await;
        return Err("Google did not return a verified email address for this account. Try another account.".to_string());
    }
    // HQ decides who gets in. 403 = not invited: sign out of everything. Unreachable / old server
    // (404) / not yet configured to trust this app (401): carry on as before, minus any domain gate;
    // the pasted API key still works as a fallback.
    let hq = crate::hq::load_settings(pool).await?;
    if let Some(id_token) = t.id_token.as_deref() {
        match crate::hq::session::exchange_id_token(&hq.base_url, id_token).await {
            crate::hq::session::Exchange::SignedIn { email: hq_email, name: hq_name } => {
                let mut hq = hq;
                hq.user_email = hq_email.or_else(|| Some(email.clone()));
                if hq.user_name.is_none() {
                    hq.user_name = hq_name;
                }
                let _ = crate::hq::save_settings(pool, &hq).await;
            }
            crate::hq::session::Exchange::NotAllowed => {
                revoke_google(&t).await;
                crate::hq::session::sign_out(&hq.base_url).await;
                return Err(crate::hq::session::NOT_ALLOWED_MESSAGE.to_string());
            }
            crate::hq::session::Exchange::Unavailable(why) => {
                log::warn!("HQ sign-in exchange unavailable ({}); continuing without an HQ session", why);
            }
        }
    }
    let name = claims.get("name").and_then(|v| v.as_str()).map(str::to_string);
    let picture = claims.get("picture").and_then(|v| v.as_str()).map(str::to_string);
    let _ = sqlx::query(
        "INSERT INTO aiwah_account (id, name, picture, updated_at) VALUES ('default', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, picture = excluded.picture, updated_at = excluded.updated_at",
    )
    .bind(&name)
    .bind(&picture)
    .bind(now_str())
    .execute(pool)
    .await;

    let refresh = t.refresh_token.ok_or(
        "Google did not return a refresh token. Remove Aiwah Minutes from your Google account permissions and try again.",
    )?;
    row.refresh_token = Some(refresh);
    row.access_token = t.access_token;
    row.access_token_expires_at = Some(
        (Utc::now() + ChronoDuration::seconds(t.expires_in.unwrap_or(3600))).to_rfc3339_opts(SecondsFormat::Secs, true),
    );
    row.account_email = t.id_token.as_deref().and_then(email_from_id_token);
    save_row(pool, &row).await?;
    log::info!("Google Calendar connected");
    Ok(build_status(&row))
}

async fn disconnect(pool: &SqlitePool) -> Result<CalendarStatus, String> {
    let mut row = load_row(pool).await?;
    if let Some(tok) = non_empty(&row.refresh_token).map(str::to_string) {
        if let Ok(c) = http() {
            let _ = c.post(REVOKE_URL).form(&[("token", tok.as_str())]).send().await;
        }
    }
    row.refresh_token = None;
    row.access_token = None;
    row.access_token_expires_at = None;
    row.account_email = None;
    save_row(pool, &row).await?;
    Ok(build_status(&row))
}

// ── Events ─────────────────────────────────────────────────────────────────────

fn first_meeting_url(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']'))
        .filter(|t| t.starts_with("https://"))
        .find(|t| MEETING_HOSTS.iter().any(|h| t.contains(h)))
        .map(|t| t.trim_end_matches(|c: char| matches!(c, '.' | ',' | ';')).to_string())
}

fn extract_meeting_url(v: &serde_json::Value) -> Option<String> {
    if let Some(l) = v.get("hangoutLink").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        return Some(l.to_string());
    }
    if let Some(eps) = v.pointer("/conferenceData/entryPoints").and_then(|x| x.as_array()) {
        for ep in eps {
            if ep.get("entryPointType").and_then(|x| x.as_str()) == Some("video") {
                if let Some(u) = ep.get("uri").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                    return Some(u.to_string());
                }
            }
        }
    }
    for key in ["location", "description"] {
        if let Some(u) = v.get(key).and_then(|x| x.as_str()).and_then(first_meeting_url) {
            return Some(u);
        }
    }
    None
}

/// Convert one Google event JSON into a `CalendarEvent`; `None` for all-day, cancelled or declined.
fn parse_event(v: &serde_json::Value) -> Option<CalendarEvent> {
    if v.get("status").and_then(|s| s.as_str()) == Some("cancelled") {
        return None;
    }
    let parse = |p: &str| -> Option<DateTime<Utc>> {
        let s = v.pointer(p)?.as_str()?;
        DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
    };
    let start = parse("/start/dateTime")?; // date-only (all-day) has no dateTime
    let end = parse("/end/dateTime")?;

    let mut attendees = Vec::new();
    let mut self_response = None;
    if let Some(arr) = v.get("attendees").and_then(|a| a.as_array()) {
        for a in arr {
            let email = a.get("email").and_then(|e| e.as_str()).unwrap_or("").to_string();
            let is_self = a.get("self").and_then(|s| s.as_bool()).unwrap_or(false);
            if is_self {
                self_response = a.get("responseStatus").and_then(|s| s.as_str()).map(str::to_string);
            }
            if email.is_empty() {
                continue;
            }
            attendees.push(EventAttendee {
                email,
                name: a.get("displayName").and_then(|n| n.as_str()).map(str::to_string),
                is_self,
                response: a.get("responseStatus").and_then(|s| s.as_str()).map(str::to_string),
                is_organizer: a.get("organizer").and_then(|s| s.as_bool()).unwrap_or(false),
                optional: a.get("optional").and_then(|s| s.as_bool()).unwrap_or(false),
            });
        }
    }
    if self_response.as_deref() == Some("declined") {
        return None;
    }

    let title = v
        .get("summary")
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("(No title)")
        .to_string();
    let description = v
        .get("description")
        .and_then(|d| d.as_str())
        .filter(|d| !d.is_empty())
        .map(|d| d.chars().take(MAX_DESCRIPTION_CHARS).collect::<String>());

    Some(CalendarEvent {
        id: v.get("id").and_then(|i| i.as_str())?.to_string(),
        title,
        start,
        end,
        meeting_url: extract_meeting_url(v),
        attendees,
        organizer_email: v.pointer("/organizer/email").and_then(|e| e.as_str()).map(str::to_string),
        self_response,
        description,
    })
}

pub async fn upcoming_events(
    pool: &SqlitePool,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<CalendarEvent>, String> {
    let token = access_token(pool).await?;
    let client = http()?;
    let mut events: Vec<CalendarEvent> = Vec::new();
    let mut page_token: Option<String> = None;
    // Up to 5 pages of 250: a month of a busy calendar fits comfortably.
    for _ in 0..5 {
        let mut query = vec![
            ("timeMin", from.to_rfc3339_opts(SecondsFormat::Secs, true)),
            ("timeMax", to.to_rfc3339_opts(SecondsFormat::Secs, true)),
            ("singleEvents", "true".to_string()),
            ("orderBy", "startTime".to_string()),
            ("maxResults", "250".to_string()),
        ];
        if let Some(t) = &page_token {
            query.push(("pageToken", t.clone()));
        }
        let resp = client
            .get(EVENTS_URL)
            .bearer_auth(&token)
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("Could not reach Google Calendar: {}", e))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => "Google Calendar rejected the request. Reconnect Google Calendar in Settings → Calendar.".to_string(),
                c => format!("Google Calendar returned an error ({})", c),
            });
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Unexpected Google Calendar response: {}", e))?;
        if let Some(items) = body.get("items").and_then(|i| i.as_array()) {
            events.extend(items.iter().filter_map(parse_event));
        }
        page_token = body.get("nextPageToken").and_then(|t| t.as_str()).map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    Ok(events)
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// AIWAH: the signed-in company account (the same Google sign-in as the calendar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub domain_ok: bool,
    pub has_client_id: bool,
}

pub async fn account_status(pool: &SqlitePool) -> Result<AccountStatus, String> {
    let row = load_row(pool).await?;
    let st = build_status(&row);
    let details: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT name, picture FROM aiwah_account WHERE id = 'default'")
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    let (name, picture) = details.unwrap_or((None, None));
    let email = st.account_email.clone();
    // AIWAH: no email-domain gate any more (HQ decides at sign-in); kept so the UI contract is unchanged.
    let domain_ok = email.is_some();
    Ok(AccountStatus {
        signed_in: st.connected && email.is_some(),
        email,
        name,
        picture,
        domain_ok,
        has_client_id: st.has_client_id,
    })
}

/// True once a company account is signed in (used to gate model downloads).
pub async fn is_signed_in(pool: &SqlitePool) -> bool {
    account_status(pool).await.map(|a| a.signed_in && a.domain_ok).unwrap_or(false)
}

pub mod commands {
    use super::*;
    use crate::state::AppState;

    #[tauri::command]
    pub async fn account_status(state: tauri::State<'_, AppState>) -> Result<AccountStatus, String> {
        super::account_status(state.db_manager.pool()).await
    }

    #[tauri::command]
    pub async fn account_sign_in(state: tauri::State<'_, AppState>) -> Result<AccountStatus, String> {
        let pool = state.db_manager.pool();
        connect(pool).await?;
        crate::autorec::watcher::invalidate_calendar();
        super::account_status(pool).await
    }

    #[tauri::command]
    pub async fn account_sign_out(state: tauri::State<'_, AppState>) -> Result<AccountStatus, String> {
        let pool = state.db_manager.pool();
        disconnect(pool).await?;
        // AIWAH: one login: signing out of Google signs out of HQ too (the API-key fallback is kept).
        if let Ok(hq) = crate::hq::load_settings(pool).await {
            crate::hq::session::sign_out(&hq.base_url).await;
        }
        let _ = sqlx::query("DELETE FROM aiwah_account WHERE id = 'default'").execute(pool).await;
        crate::autorec::watcher::invalidate_calendar();
        super::account_status(pool).await
    }

    #[tauri::command]
    pub async fn calendar_get_status(state: tauri::State<'_, AppState>) -> Result<CalendarStatus, String> {
        status(state.db_manager.pool()).await
    }

    #[tauri::command]
    pub async fn calendar_save_client(
        state: tauri::State<'_, AppState>,
        client_id: String,
        client_secret: Option<String>,
    ) -> Result<CalendarStatus, String> {
        let pool = state.db_manager.pool();
        let mut row = load_row(pool).await?;
        let id = client_id.trim();
        let secret = client_secret.as_deref().map(str::trim).unwrap_or("");
        let changed = row.client_id.as_deref().map(str::trim).unwrap_or("") != id;
        row.client_id = if id.is_empty() { None } else { Some(id.to_string()) };
        row.client_secret = if id.is_empty() || secret.is_empty() { None } else { Some(secret.to_string()) };
        if changed {
            // Tokens belong to the old client; force a reconnect.
            row.refresh_token = None;
            row.access_token = None;
            row.access_token_expires_at = None;
            row.account_email = None;
        }
        save_row(pool, &row).await?;
        Ok(build_status(&row))
    }

    #[tauri::command]
    pub async fn calendar_connect(state: tauri::State<'_, AppState>) -> Result<CalendarStatus, String> {
        connect(state.db_manager.pool()).await
    }

    #[tauri::command]
    pub async fn calendar_disconnect(state: tauri::State<'_, AppState>) -> Result<CalendarStatus, String> {
        disconnect(state.db_manager.pool()).await
    }

    #[tauri::command]
    pub async fn calendar_list_events(
        state: tauri::State<'_, AppState>,
        hours_ahead: Option<i64>,
    ) -> Result<Vec<CalendarEvent>, String> {
        let now = Utc::now();
        let hours = hours_ahead.unwrap_or(24).clamp(1, 24 * 31);
        upcoming_events(state.db_manager.pool(), now - ChronoDuration::hours(1), now + ChronoDuration::hours(hours)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_rfc7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn base64url_roundtrip_and_id_token_email() {
        for data in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0xff, 0xfe, 0xfd]] {
            assert_eq!(base64url_decode(&base64url(data)).unwrap(), data);
        }
        let payload = base64url(br#"{"email":"a@b.com"}"#);
        assert_eq!(email_from_id_token(&format!("h.{}.s", payload)).as_deref(), Some("a@b.com"));
    }

    #[test]
    fn sha256_known_vector() {
        let h = sha256(b"abc");
        let hex: String = h.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn random_verifier_shape() {
        assert_eq!(random_string(64).len(), 64);
    }

    fn ev(extra: serde_json::Value) -> serde_json::Value {
        let mut base = json!({
            "id": "e1", "summary": "Sync",
            "start": {"dateTime": "2026-11-20T10:00:00+05:30"},
            "end": {"dateTime": "2026-11-20T11:00:00+05:30"}
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn meeting_url_sources() {
        let e = parse_event(&ev(json!({"hangoutLink": "https://meet.google.com/abc-defg-hij"}))).unwrap();
        assert_eq!(e.meeting_url.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!(e.start.to_rfc3339(), "2026-11-20T04:30:00+00:00");

        let e = parse_event(&ev(json!({"conferenceData": {"entryPoints": [
            {"entryPointType": "phone", "uri": "tel:+1"},
            {"entryPointType": "video", "uri": "https://teams.microsoft.com/l/meetup-join/x"}]}})))
        .unwrap();
        assert_eq!(e.meeting_url.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/x"));

        let e = parse_event(&ev(json!({"description": "Join: <a href=\"https://acme.zoom.us/j/123?pwd=x\">link</a> thanks"})))
            .unwrap();
        assert_eq!(e.meeting_url.as_deref(), Some("https://acme.zoom.us/j/123?pwd=x"));

        let e = parse_event(&ev(json!({"description": "see https://example.com"}))).unwrap();
        assert!(e.meeting_url.is_none());
    }

    #[test]
    fn filtering() {
        assert!(parse_event(&ev(json!({"status": "cancelled"}))).is_none());
        assert!(parse_event(&json!({"id": "x", "start": {"date": "2026-11-20"}, "end": {"date": "2026-11-21"}})).is_none());
        let declined = ev(json!({"attendees": [
            {"email": "me@x.com", "self": true, "responseStatus": "declined"},
            {"email": "o@x.com"}]}));
        assert!(parse_event(&declined).is_none());
        let accepted = ev(json!({"summary": "", "attendees": [
            {"email": "me@x.com", "self": true, "responseStatus": "accepted"},
            {"email": "o@x.com", "displayName": "O"}]}));
        let e = parse_event(&accepted).unwrap();
        assert_eq!(e.title, "(No title)");
        assert_eq!(e.self_response.as_deref(), Some("accepted"));
        assert_eq!(e.attendees.len(), 2);
    }

    #[test]
    fn callback_parsing() {
        let (c, s, e) = parse_callback("GET /?code=abc&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!((c.as_deref(), s.as_deref(), e), (Some("abc"), Some("xyz"), None));
        assert!(parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n").is_none());
    }
}
