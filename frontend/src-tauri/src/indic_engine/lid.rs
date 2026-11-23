//! Spoken language identification used to route between English (Parakeet)
//! and Indic (IndicConformer) recognizers. Uses whisper.cpp's language
//! detector (encoder pass only, no decoding) on a multilingual ggml model.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use whisper_rs::{WhisperContext, WhisperContextParameters};

const SAMPLE_RATE: usize = 16_000;
const WINDOW: usize = 30 * SAMPLE_RATE;
/// Windows shorter than this are too short to identify anything.
const MIN_WINDOW: usize = SAMPLE_RATE; // 1 s
/// Indic is preferred when its averaged probability reaches this value
/// (English-Indic code-mixing pulls probability towards "en").
pub const INDIC_PREFER_THRESHOLD: f32 = 0.35;

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    English,
    Indic(String),
}

/// Reusable detector (loading the ggml model is the expensive part).
pub struct LangDetector {
    ctx: WhisperContext,
}

impl LangDetector {
    pub fn new(model_path: &Path) -> Result<Self> {
        let params = WhisperContextParameters {
            use_gpu: false,
            ..Default::default()
        };
        let ctx = WhisperContext::new_with_params(&model_path.to_string_lossy(), params)
            .map_err(|e| anyhow!("Failed to load language-id model: {}", e))?;
        Ok(Self { ctx })
    }

    /// Language probabilities for (up to) the first 30 s of `samples`, sorted descending.
    pub fn detect(&self, samples_16k_mono: &[f32]) -> Result<Vec<(String, f32)>> {
        let take = samples_16k_mono.len().min(WINDOW);
        if take < MIN_WINDOW {
            return Err(anyhow!("Audio too short for language identification"));
        }
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| anyhow!("whisper state: {}", e))?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(2);
        state
            .pcm_to_mel(&samples_16k_mono[..take], threads)
            .map_err(|e| anyhow!("whisper mel: {}", e))?;
        let (_, probs) = state
            .lang_detect(0, threads)
            .map_err(|e| anyhow!("whisper lang_detect: {}", e))?;
        let mut out: Vec<(String, f32)> = probs
            .iter()
            .enumerate()
            .filter_map(|(id, &p)| whisper_rs::get_lang_str(id as i32).map(|c| (c.to_string(), p)))
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(out)
    }

    /// Probabilities for up to 3 windows of 30 s taken from the beginning, middle
    /// and end of the audio (fewer windows for shorter audio; silent/too-short
    /// windows are skipped).
    pub fn detect_windows(&self, samples_16k_mono: &[f32]) -> Result<Vec<Vec<(String, f32)>>> {
        let mut result = Vec::new();
        for (a, b) in window_ranges(samples_16k_mono.len()) {
            if b - a < MIN_WINDOW {
                continue;
            }
            result.push(self.detect(&samples_16k_mono[a..b])?);
        }
        if result.is_empty() {
            return Err(anyhow!("Audio too short for language identification"));
        }
        Ok(result)
    }

    /// Convenience: sample windows, detect, and route.
    pub fn detect_route(&self, samples_16k_mono: &[f32], allowed_indic: &[&str]) -> Result<Route> {
        Ok(route(&self.detect_windows(samples_16k_mono)?, allowed_indic))
    }
}

/// Multilingual whisper.cpp models usable for language id, best-suited first.
/// (`.en` models cannot identify languages and are never used.)
const LID_MODEL_CANDIDATES: &[&str] = &[
    "ggml-base.bin",
    "ggml-base-q5_1.bin",
    "ggml-small.bin",
    "ggml-small-q5_1.bin",
    "ggml-tiny.bin",
    "ggml-tiny-q5_1.bin",
    "ggml-medium.bin",
    "ggml-medium-q5_0.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3.bin",
    "ggml-large-v3-q5_0.bin",
];

/// Find an already-downloaded multilingual Whisper model under `<app_data>/models`
/// (the folder the Whisper engine downloads into) or its `whisper` subfolder.
pub fn find_model(app_data_dir: &Path) -> Option<PathBuf> {
    let root = app_data_dir.join("models");
    for dir in [root.clone(), root.join("whisper")] {
        for name in LID_MODEL_CANDIDATES {
            let p = dir.join(name);
            if p.is_file() && std::fs::metadata(&p).map(|m| m.len() > 1_000_000).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

/// Language-id model path for this app install, if one is available.
pub fn model_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    find_model(&app.path().app_data_dir().ok()?)
}

/// Blocking: sample up to 3 windows of `samples_16k_mono`, detect, and route.
/// Error is a user-presentable string.
pub fn route_audio(
    samples_16k_mono: &[f32],
    model_path: &Path,
    allowed_indic: &[&str],
) -> Result<Route, String> {
    let det = LangDetector::new(model_path).map_err(|e| e.to_string())?;
    det.detect_route(samples_16k_mono, allowed_indic)
        .map_err(|e| e.to_string())
}

/// One-shot detection (loads the model each call; prefer `LangDetector`).
pub fn detect(samples_16k_mono: &[f32], model_path: &Path) -> Result<Vec<(String, f32)>> {
    LangDetector::new(model_path)?.detect(samples_16k_mono)
}

/// Window boundaries: whole audio if <= 30 s, else 30 s at the start, middle and end.
fn window_ranges(n: usize) -> Vec<(usize, usize)> {
    if n <= WINDOW {
        return vec![(0, n)];
    }
    if n <= 2 * WINDOW {
        return vec![(0, WINDOW), (n - WINDOW, n)];
    }
    let mid = (n - WINDOW) / 2;
    vec![(0, WINDOW), (mid, mid + WINDOW), (n - WINDOW, n)]
}

/// Decide English vs Indic from per-window probability lists (as returned by `detect`).
///
/// Probabilities are averaged per language over windows, restricted to
/// {"en"} + `allowed_indic`. Indic wins when the best allowed Indic language
/// has averaged probability >= 0.35 (code-mixed speech) or beats English
/// outright; otherwise English.
pub fn route(window_probs: &[Vec<(String, f32)>], allowed_indic: &[&str]) -> Route {
    if window_probs.is_empty() {
        return Route::English;
    }
    let n = window_probs.len() as f32;
    let avg = |code: &str| -> f32 {
        window_probs
            .iter()
            .map(|w| w.iter().find(|(c, _)| c == code).map(|(_, p)| *p).unwrap_or(0.0))
            .sum::<f32>()
            / n
    };
    let p_en = avg("en");
    let mut best: Option<(&str, f32)> = None;
    for &code in allowed_indic {
        let p = avg(code);
        if best.map(|(_, bp)| p > bp).unwrap_or(true) {
            best = Some((code, p));
        }
    }
    match best {
        Some((code, p)) if p >= INDIC_PREFER_THRESHOLD || p > p_en => Route::Indic(code.to_string()),
        _ => Route::English,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(pairs: &[(&str, f32)]) -> Vec<(String, f32)> {
        pairs.iter().map(|(c, p)| (c.to_string(), *p)).collect()
    }

    #[test]
    fn clear_english() {
        let r = route(&[w(&[("en", 0.9), ("hi", 0.05)]), w(&[("en", 0.8), ("ml", 0.1)])], &["hi", "ml"]);
        assert_eq!(r, Route::English);
    }

    #[test]
    fn clear_indic() {
        let r = route(&[w(&[("ml", 0.8), ("en", 0.1)]), w(&[("ml", 0.9), ("en", 0.05)])], &["hi", "ml"]);
        assert_eq!(r, Route::Indic("ml".into()));
    }

    #[test]
    fn code_mixed_prefers_indic_at_threshold() {
        // en 0.55 vs ml 0.36 averaged: Malayalam with many English words.
        let r = route(&[w(&[("en", 0.6), ("ml", 0.32)]), w(&[("en", 0.5), ("ml", 0.40)])], &["ml"]);
        assert_eq!(r, Route::Indic("ml".into()));
    }

    #[test]
    fn below_threshold_stays_english() {
        let r = route(&[w(&[("en", 0.6), ("ml", 0.30)])], &["ml"]);
        assert_eq!(r, Route::English);
    }

    #[test]
    fn disallowed_languages_are_ignored() {
        let r = route(&[w(&[("en", 0.3), ("hi", 0.6)])], &["ta"]);
        assert_eq!(r, Route::English);
    }

    #[test]
    fn averages_across_windows_and_picks_best_indic() {
        let r = route(
            &[w(&[("en", 0.1), ("ta", 0.5), ("hi", 0.3)]), w(&[("en", 0.1), ("ta", 0.1), ("hi", 0.7)]), w(&[("hi", 0.6), ("ta", 0.2)])],
            &["ta", "hi"],
        );
        assert_eq!(r, Route::Indic("hi".into()));
    }

    #[test]
    fn indic_beats_english_even_below_threshold() {
        let r = route(&[w(&[("en", 0.1), ("ta", 0.2)])], &["ta"]);
        assert_eq!(r, Route::Indic("ta".into()));
    }

    #[test]
    fn empty_is_english() {
        assert_eq!(route(&[], &["ta"]), Route::English);
    }

    #[test]
    fn window_layout() {
        assert_eq!(window_ranges(10 * SAMPLE_RATE), vec![(0, 10 * SAMPLE_RATE)]);
        assert_eq!(window_ranges(45 * SAMPLE_RATE).len(), 2);
        let r = window_ranges(300 * SAMPLE_RATE);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].0, 0);
        assert_eq!(r[2].1, 300 * SAMPLE_RATE);
        assert!(r[1].0 > r[0].1 && r[1].1 < r[2].0);
    }
}
