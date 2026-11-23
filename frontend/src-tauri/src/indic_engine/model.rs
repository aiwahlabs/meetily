//! Model-file management for the on-device Indic speech recognizer
//! (IndicConformer-600M, CTC head, 22 Indian languages).
//!
//! Files come from two Hugging Face repos, both pinned to an exact commit and
//! verified against a hard-coded SHA-256 before they are moved into place.
//! The encoder uses ONNX external data (`encoder-model.onnx.data`, 2.43 GB).

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

/// File names as stored locally (the engine looks them up by these names).
/// `encoder-model.onnx` references `encoder-model.onnx.data` by that exact
/// relative name, so the two must stay side by side.
pub const ENCODER_FILE: &str = "encoder-model.onnx";
pub const ENCODER_DATA_FILE: &str = "encoder-model.onnx.data";
pub const CTC_FILE: &str = "ctc_decoder-model.onnx";
pub const PREPROCESSOR_FILE: &str = "nemo128.onnx";
pub const VOCAB_FILE: &str = "vocab.txt";
pub const SPANS_FILE: &str = "language_spans.json";

#[derive(Debug, Clone, Copy)]
pub struct IndicFile {
    /// Local file name inside the model directory.
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

// NOTE: the int8 encoder (yashwork-byte/indic-conformer-600m-int8-onnx @ 9c590ef6,
// 652 MB) was evaluated first but cannot be loaded by the bundled ONNX Runtime 1.22
// CPU provider ("Could not find an implementation for ConvInteger(10)": its 77
// ConvInteger nodes use int8 weights). The fp32 encoder is used instead.

/// The exact set of files (fp32 encoder), all from
/// christopherthompson81/indicconformer-600m-onnx @ 938d2651895467cca6772ae8e9dadfbbae4ab670 (MIT).
pub const FILES: &[IndicFile] = &[
    IndicFile {
        name: ENCODER_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/encoder-model.onnx",
        size: 42_006_402,
        sha256: "c32924aff6c11fd1bbe20a44b08db0849972db5f8a11deb1beca7d2b51a5f89d",
    },
    IndicFile {
        name: ENCODER_DATA_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/encoder-model.onnx.data",
        size: 2_430_799_872,
        sha256: "bec5ca89ecc4d4cb8010131afe4efa1ec727489011920fbcbd206a4498dc424f",
    },
    IndicFile {
        name: CTC_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/ctc_decoder-model.onnx",
        size: 23_095_900,
        sha256: "ff9d6b85ae150e6fe5de378f18b01260c44af1d1eb20b73a56685d174db44729",
    },
    IndicFile {
        name: PREPROCESSOR_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/nemo128.onnx",
        size: 1_151_666,
        sha256: "8cce9f018b2594d3c8073156f819257415c843880cce1b4242eb7b06f7d947bf",
    },
    IndicFile {
        name: VOCAB_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/vocab.txt",
        size: 41_814,
        sha256: "10273f4ed61f96f732c724433d5a514a67b0d7e42fd8a805aebb11e0aaffc0cb",
    },
    IndicFile {
        name: SPANS_FILE,
        url: "https://huggingface.co/christopherthompson81/indicconformer-600m-onnx/resolve/938d2651895467cca6772ae8e9dadfbbae4ab670/language_spans.json",
        size: 1_397,
        sha256: "791764a37503edeea01f8261930c519e9a7076f7e4360e8805dac0961cb6d0c5",
    },
];

/// Total download size in bytes.
pub fn total_bytes() -> u64 {
    FILES.iter().map(|f| f.size).sum()
}

/// `<app_data>/models/indic-conformer`
pub fn model_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join("indic-conformer")
}

#[derive(Debug, Clone, Serialize)]
pub struct IndicModelStatus {
    pub installed: bool,
    pub bytes_on_disk: u64,
    pub total_bytes: u64,
    /// Local file names that are absent or have the wrong size.
    pub missing: Vec<String>,
}

/// Cheap check (existence + exact size). Full hashes are verified at download time.
pub fn status(dir: &Path) -> IndicModelStatus {
    let mut bytes_on_disk = 0u64;
    let mut missing = Vec::new();
    for f in FILES {
        match std::fs::metadata(dir.join(f.name)) {
            Ok(m) if m.len() == f.size => bytes_on_disk += m.len(),
            Ok(m) => {
                bytes_on_disk += m.len();
                missing.push(f.name.to_string());
            }
            Err(_) => missing.push(f.name.to_string()),
        }
    }
    // Partial downloads count toward progress shown to the user.
    for f in FILES {
        if let Ok(m) = std::fs::metadata(dir.join(format!("{}.part", f.name))) {
            bytes_on_disk += m.len();
        }
    }
    IndicModelStatus {
        installed: missing.is_empty(),
        bytes_on_disk,
        total_bytes: total_bytes(),
        missing,
    }
}

/// Remove the whole model directory.
pub fn delete(dir: &Path) -> Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| anyhow!("Failed to delete {}: {}", dir.display(), e))?;
    }
    Ok(())
}

/// Hash every installed file and compare with the pinned SHA-256 (slow: ~0.7 GB).
pub fn verify(dir: &Path) -> Result<()> {
    for f in FILES {
        let got = sha256_file(&dir.join(f.name))?;
        if got != f.sha256 {
            return Err(anyhow!("{} failed checksum verification", f.name));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| anyhow!("Failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Debug, thiserror::Error)]
#[error("Download cancelled by user")]
pub struct IndicDownloadCancelled;

pub fn is_download_cancelled(error: &anyhow::Error) -> bool {
    error.downcast_ref::<IndicDownloadCancelled>().is_some()
}

/// Download every missing file into `dir`.
///
/// - `progress(downloaded, total)` is called with cumulative bytes across all
///   files (already-complete files count immediately).
/// - Each file is written to `<name>.part` (resumed with an HTTP Range request
///   if a previous attempt left one), SHA-256 checked, then renamed atomically.
/// - Cancel with `cancel.cancel()`; partial files are kept so a retry resumes.
pub async fn download(
    dir: &Path,
    cancel: &CancellationToken,
    progress: impl Fn(u64, u64),
) -> Result<()> {
    fs::create_dir_all(dir)
        .await
        .map_err(|e| anyhow!("Failed to create model directory: {}", e))?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Meetily/", env!("CARGO_PKG_VERSION")))
        .tcp_nodelay(true)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

    let total = total_bytes();
    let mut done = 0u64;
    progress(0, total);

    for f in FILES {
        if cancel.is_cancelled() {
            return Err(IndicDownloadCancelled.into());
        }
        let final_path = dir.join(f.name);
        if let Ok(m) = fs::metadata(&final_path).await {
            if m.len() == f.size {
                done += f.size;
                progress(done, total);
                continue;
            }
        }
        let part_path = dir.join(format!("{}.part", f.name));
        download_one(&client, f, &part_path, cancel, |n| progress(done + n, total)).await?;

        // Verify checksum off the async runtime, then publish atomically.
        let part_for_hash = part_path.clone();
        let got = tokio::task::spawn_blocking(move || sha256_file(&part_for_hash))
            .await
            .map_err(|e| anyhow!("Hash task failed: {}", e))??;
        if got != f.sha256 {
            let _ = fs::remove_file(&part_path).await;
            return Err(anyhow!(
                "Checksum mismatch for {} (the file was discarded; try again)",
                f.name
            ));
        }
        fs::rename(&part_path, &final_path)
            .await
            .map_err(|e| anyhow!("Failed to finalize {}: {}", f.name, e))?;
        done += f.size;
        progress(done, total);
    }
    Ok(())
}

async fn download_one(
    client: &reqwest::Client,
    f: &IndicFile,
    part_path: &Path,
    cancel: &CancellationToken,
    on_bytes: impl Fn(u64),
) -> Result<()> {
    let mut have = match fs::metadata(part_path).await {
        Ok(m) if m.len() <= f.size => m.len(),
        _ => 0,
    };
    // A .part that is already full length goes straight to hash verification.
    if have == f.size {
        on_bytes(have);
        return Ok(());
    }

    let mut request = client.get(f.url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(IndicDownloadCancelled.into()),
        r = request.send() => r.map_err(|e| anyhow!("Failed to start download of {}: {}", f.name, e))?,
    };
    let append = match response.status() {
        reqwest::StatusCode::PARTIAL_CONTENT if have > 0 => true,
        reqwest::StatusCode::OK => {
            have = 0; // server ignored Range: restart this file
            false
        }
        s => return Err(anyhow!("Download of {} failed with status {}", f.name, s)),
    };
    if let Some(len) = response.content_length() {
        if have + len != f.size {
            return Err(anyhow!(
                "{} has unexpected size {} (expected {})",
                f.name,
                have + len,
                f.size
            ));
        }
    }

    let file = if append {
        fs::OpenOptions::new().append(true).open(part_path).await
    } else {
        fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(part_path)
            .await
    }
    .map_err(|e| anyhow!("Failed to open {}: {}", part_path.display(), e))?;
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
    let mut stream = response.bytes_stream();
    let mut written = have;
    let mut last_report = std::time::Instant::now();

    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = writer.flush().await;
                return Err(IndicDownloadCancelled.into());
            }
            c = timeout(Duration::from_secs(30), stream.next()) => c,
        };
        let chunk = match next {
            Err(_) => {
                let _ = writer.flush().await;
                return Err(anyhow!("Download timeout for {}: no data for 30 seconds", f.name));
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                let _ = writer.flush().await;
                return Err(anyhow!("Download of {} interrupted: {}", f.name, e));
            }
            Ok(Some(Ok(c))) => c,
        };
        written += chunk.len() as u64;
        if written > f.size {
            let _ = writer.flush().await;
            return Err(anyhow!("{} is larger than expected", f.name));
        }
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| anyhow!("Failed to write {}: {}", f.name, e))?;
        if last_report.elapsed() >= Duration::from_millis(250) {
            on_bytes(written);
            last_report = std::time::Instant::now();
        }
    }
    writer.flush().await?;
    drop(writer);
    on_bytes(written);
    if written != f.size {
        // Keep the partial file so the next attempt resumes.
        return Err(anyhow!(
            "{} ended early ({} of {} bytes)",
            f.name,
            written,
            f.size
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_missing_and_exact_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let s = status(dir.path());
        assert!(!s.installed);
        assert_eq!(s.missing.len(), FILES.len());
        assert_eq!(s.total_bytes, total_bytes());

        // Wrong-size file is still "missing".
        std::fs::write(dir.path().join(VOCAB_FILE), b"x").unwrap();
        let s = status(dir.path());
        assert!(s.missing.iter().any(|m| m == VOCAB_FILE));
        assert_eq!(s.bytes_on_disk, 1);
    }

    #[test]
    fn urls_are_pinned_to_commits() {
        for f in FILES {
            assert!(f.url.contains("/resolve/"));
            let rev = f.url.split("/resolve/").nth(1).unwrap().split('/').next().unwrap();
            assert_eq!(rev.len(), 40, "{} not pinned to a commit hash", f.name);
            assert_eq!(f.sha256.len(), 64);
        }
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("indic");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a"), b"1").unwrap();
        delete(&sub).unwrap();
        delete(&sub).unwrap();
        assert!(!sub.exists());
    }
}
