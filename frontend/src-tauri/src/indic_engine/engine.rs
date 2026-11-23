//! IndicConformer-600M (CTC) inference on ONNX Runtime (CPU).
//!
//! Pipeline per <=30 s chunk: 16 kHz mono f32 -> `nemo128.onnx` (log-mel, 80 bins)
//! -> encoder -> CTC decoder (5633 logits/frame) -> restrict to the language's
//! 256-token span + the shared blank -> greedy CTC -> detokenize.

use super::model::{CTC_FILE, ENCODER_FILE, PREPROCESSOR_FILE, SPANS_FILE, VOCAB_FILE};
use anyhow::{anyhow, Context, Result};
use ndarray::{Array1, Array2, ArrayD};
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// (language code, English name) for the 22 supported languages.
pub const SUPPORTED: &[(&str, &str)] = &[
    ("as", "Assamese"),
    ("bn", "Bengali"),
    ("brx", "Bodo"),
    ("doi", "Dogri"),
    ("gu", "Gujarati"),
    ("hi", "Hindi"),
    ("kn", "Kannada"),
    ("kok", "Konkani"),
    ("ks", "Kashmiri"),
    ("mai", "Maithili"),
    ("ml", "Malayalam"),
    ("mni", "Manipuri"),
    ("mr", "Marathi"),
    ("ne", "Nepali"),
    ("or", "Odia"),
    ("pa", "Punjabi"),
    ("sa", "Sanskrit"),
    ("sat", "Santali"),
    ("sd", "Sindhi"),
    ("ta", "Tamil"),
    ("te", "Telugu"),
    ("ur", "Urdu"),
];

const SAMPLE_RATE: usize = 16_000;
/// Maximum audio per model call.
const MAX_CHUNK: usize = 30 * SAMPLE_RATE;
/// A split point is searched for in the last part of a window.
const SPLIT_SEARCH: usize = 5 * SAMPLE_RATE;
/// Anything shorter than this is not worth running (25 ms = one STFT window).
const MIN_SAMPLES: usize = 400;

pub struct IndicEngine {
    preprocessor: Mutex<Session>,
    encoder: Mutex<Session>,
    ctc: Mutex<Session>,
    enc_in: (String, String),
    enc_out: (String, String),
    ctc_in: String,
    ctc_out: String,
    /// Global vocab: index -> piece (with U+2581 mapped to a space).
    vocab: Vec<String>,
    /// lang -> (start, len) inside the global vocab / logits.
    spans: HashMap<String, (usize, usize)>,
    blank: usize,
}

fn build_session(path: &Path) -> Result<Session> {
    crate::ensure_onnx_runtime_available()?;
    let session = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_execution_providers(vec![CPUExecutionProvider::default().build()])?
        .commit_from_file(path)
        .with_context(|| format!("Failed to load {}", path.display()))?;
    Ok(session)
}

impl IndicEngine {
    /// Load all sessions from a model directory (see `model::download`).
    pub fn load(dir: &Path) -> Result<Self> {
        let preprocessor = build_session(&dir.join(PREPROCESSOR_FILE))?;
        let encoder = build_session(&dir.join(ENCODER_FILE))?;
        let ctc = build_session(&dir.join(CTC_FILE))?;

        let in_names = |s: &Session| s.inputs.iter().map(|i| i.name.clone()).collect::<Vec<_>>();
        let out_names = |s: &Session| s.outputs.iter().map(|o| o.name.clone()).collect::<Vec<_>>();
        let e_in = in_names(&encoder);
        let e_out = out_names(&encoder);
        let c_in = in_names(&ctc);
        let c_out = out_names(&ctc);
        if e_in.len() != 2 || e_out.len() != 2 || c_in.len() != 1 || c_out.is_empty() {
            return Err(anyhow!(
                "Unexpected model signatures: encoder {:?}->{:?}, ctc {:?}->{:?}",
                e_in,
                e_out,
                c_in,
                c_out
            ));
        }

        let vocab_text = std::fs::read_to_string(dir.join(VOCAB_FILE))?;
        // One piece per line, line index == id. Do not trim: pieces may be significant.
        let vocab: Vec<String> = vocab_text
            .split('\n')
            .map(|l| l.trim_end_matches('\r').replace('\u{2581}', " "))
            .collect();
        let vocab = if vocab.last().map(|l| l.is_empty()).unwrap_or(false) {
            vocab[..vocab.len() - 1].to_vec()
        } else {
            vocab
        };

        let spans_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SPANS_FILE))?)?;
        let blank = spans_json["blank_token_id"]
            .as_u64()
            .ok_or_else(|| anyhow!("language_spans.json: missing blank_token_id"))? as usize;
        let total = spans_json["total_vocab_size"].as_u64().unwrap_or(0) as usize;
        if vocab.len() != total {
            return Err(anyhow!(
                "vocab.txt has {} entries, expected {}",
                vocab.len(),
                total
            ));
        }
        let mut spans = HashMap::new();
        for (code, v) in spans_json["languages"]
            .as_object()
            .ok_or_else(|| anyhow!("language_spans.json: missing languages"))?
        {
            let start = v["start"].as_u64().unwrap_or(0) as usize;
            let len = v["length"].as_u64().unwrap_or(0) as usize;
            if start + len > total {
                return Err(anyhow!("language span for {code} is out of range"));
            }
            spans.insert(code.clone(), (start, len));
        }

        Ok(Self {
            preprocessor: Mutex::new(preprocessor),
            encoder: Mutex::new(encoder),
            ctc: Mutex::new(ctc),
            enc_in: (e_in[0].clone(), e_in[1].clone()),
            enc_out: (e_out[0].clone(), e_out[1].clone()),
            ctc_in: c_in[0].clone(),
            ctc_out: c_out[0].clone(),
            vocab,
            spans,
            blank,
        })
    }

    /// Transcribe 16 kHz mono f32 audio in `lang` (one of `SUPPORTED`).
    /// Long audio is processed in chunks of at most 30 s; results are joined with spaces.
    pub fn transcribe(&self, samples_16k_mono: &[f32], lang: &str) -> Result<String> {
        let &(start, len) = self
            .spans
            .get(lang)
            .ok_or_else(|| anyhow!("Unsupported Indic language: {lang}"))?;
        let mut parts: Vec<String> = Vec::new();
        for (a, b) in plan_chunks(samples_16k_mono) {
            let chunk = &samples_16k_mono[a..b];
            if chunk.len() < MIN_SAMPLES {
                continue;
            }
            let text = self.transcribe_chunk(chunk, start, len)?;
            if !text.is_empty() {
                parts.push(text);
            }
        }
        Ok(parts.join(" "))
    }

    fn transcribe_chunk(&self, pcm: &[f32], span_start: usize, span_len: usize) -> Result<String> {
        let n = pcm.len();
        let wave = Array2::from_shape_vec((1, n), pcm.to_vec())?.into_dyn();
        let wave_len = Array1::from_vec(vec![n as i64]).into_dyn();

        // 1. log-mel features
        let (features, features_lens): (ArrayD<f32>, ArrayD<i64>) = {
            let mut s = self.preprocessor.lock().map_err(|_| anyhow!("poisoned"))?;
            let out = s.run(inputs![
                "waveforms" => TensorRef::from_array_view(wave.view())?,
                "waveforms_lens" => TensorRef::from_array_view(wave_len.view())?,
            ])?;
            let f = out
                .get("features")
                .ok_or_else(|| anyhow!("preprocessor: no 'features' output"))?
                .try_extract_array::<f32>()?
                .to_owned();
            let l = out
                .get("features_lens")
                .ok_or_else(|| anyhow!("preprocessor: no 'features_lens' output"))?
                .try_extract_array::<i64>()?
                .to_owned();
            (f, l)
        };

        // 2. encoder -> [1, 1024, T']
        let (encoded, encoded_len): (ArrayD<f32>, i64) = {
            let mut s = self.encoder.lock().map_err(|_| anyhow!("poisoned"))?;
            let out = s.run(inputs![
                self.enc_in.0.as_str() => TensorRef::from_array_view(features.view())?,
                self.enc_in.1.as_str() => TensorRef::from_array_view(features_lens.view())?,
            ])?;
            let e = out
                .get(self.enc_out.0.as_str())
                .ok_or_else(|| anyhow!("encoder: missing output {}", self.enc_out.0))?
                .try_extract_array::<f32>()?
                .to_owned();
            let l = out
                .get(self.enc_out.1.as_str())
                .ok_or_else(|| anyhow!("encoder: missing output {}", self.enc_out.1))?
                .try_extract_array::<i64>()?
                .iter()
                .copied()
                .next()
                .unwrap_or(0);
            (e, l)
        };

        // 3. CTC head -> [1, T', 5633]
        let logits: ArrayD<f32> = {
            let mut s = self.ctc.lock().map_err(|_| anyhow!("poisoned"))?;
            let out = s.run(inputs![
                self.ctc_in.as_str() => TensorRef::from_array_view(encoded.view())?,
            ])?;
            out.get(self.ctc_out.as_str())
                .ok_or_else(|| anyhow!("ctc: missing output {}", self.ctc_out))?
                .try_extract_array::<f32>()?
                .to_owned()
        };

        let shape = logits.shape().to_vec();
        if shape.len() != 3 || shape[2] <= self.blank {
            return Err(anyhow!("Unexpected CTC output shape {:?}", shape));
        }
        let frames = (encoded_len.max(0) as usize).min(shape[1]);
        let flat = logits
            .as_slice()
            .ok_or_else(|| anyhow!("CTC output is not contiguous"))?;
        let vocab_dim = shape[2];

        let ids = greedy_ctc(
            (0..frames).map(|t| &flat[t * vocab_dim..(t + 1) * vocab_dim]),
            span_start,
            span_len,
            self.blank,
        );
        Ok(self.detokenize(&ids))
    }

    fn detokenize(&self, ids: &[usize]) -> String {
        let mut text = String::new();
        for &id in ids {
            if let Some(piece) = self.vocab.get(id) {
                if piece == "<unk>" {
                    continue;
                }
                text.push_str(piece);
            }
        }
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

/// Greedy CTC over per-frame logits restricted to `[start, start+len)` plus `blank`.
/// Returns global token ids with repeats collapsed and blanks dropped.
fn greedy_ctc<'a>(
    frames: impl Iterator<Item = &'a [f32]>,
    start: usize,
    len: usize,
    blank: usize,
) -> Vec<usize> {
    let mut out = Vec::new();
    let mut prev: Option<usize> = None;
    for row in frames {
        let mut best = blank;
        let mut best_v = row[blank];
        for (k, &v) in row[start..start + len].iter().enumerate() {
            if v > best_v {
                best_v = v;
                best = start + k;
            }
        }
        if best != blank && prev != Some(best) {
            out.push(best);
        }
        prev = Some(best);
    }
    out
}

/// Split into windows of at most 30 s, preferring to cut at the quietest 50 ms
/// frame within the last 5 s of each window.
fn plan_chunks(samples: &[f32]) -> Vec<(usize, usize)> {
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let n = samples.len();
    while start < n {
        let hard_end = (start + MAX_CHUNK).min(n);
        if hard_end == n {
            chunks.push((start, n));
            break;
        }
        let end = quietest_point(samples, hard_end.saturating_sub(SPLIT_SEARCH).max(start + 1), hard_end);
        chunks.push((start, end));
        start = end;
    }
    chunks
}

fn quietest_point(samples: &[f32], from: usize, to: usize) -> usize {
    const FRAME: usize = SAMPLE_RATE / 20; // 50 ms
    if to <= from + FRAME {
        return to;
    }
    let mut best_pos = to;
    let mut best_energy = f32::MAX;
    let mut pos = from;
    while pos + FRAME <= to {
        let e: f32 = samples[pos..pos + FRAME].iter().map(|s| s * s).sum();
        if e < best_energy {
            best_energy = e;
            best_pos = pos + FRAME / 2;
        }
        pos += FRAME / 2;
    }
    best_pos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_has_22_languages() {
        assert_eq!(SUPPORTED.len(), 22);
    }

    #[test]
    fn greedy_ctc_collapses_repeats_and_blanks() {
        // vocab dim 8: span [2,5) = ids 2,3,4 ; blank = 7
        let rows: Vec<Vec<f32>> = vec![
            vec![0., 0., 5., 0., 0., 0., 0., 1.], // 2
            vec![0., 0., 5., 0., 0., 0., 0., 1.], // 2 (repeat)
            vec![0., 0., 0., 0., 0., 0., 0., 9.], // blank
            vec![0., 0., 5., 0., 0., 0., 0., 1.], // 2 (after blank -> emitted)
            vec![9., 0., 0., 0., 0., 0., 0., 1.], // id 0 outside span: ignored -> blank
            vec![0., 0., 0., 0., 6., 0., 0., 1.], // 4
        ];
        let ids = greedy_ctc(rows.iter().map(|r| r.as_slice()), 2, 3, 7);
        assert_eq!(ids, vec![2, 2, 4]);
    }

    #[test]
    fn chunks_cover_audio_and_respect_limit() {
        let n = 95 * SAMPLE_RATE + 123;
        let mut audio = vec![0.3f32; n];
        // quiet gap at ~27 s
        for s in audio[27 * SAMPLE_RATE..27 * SAMPLE_RATE + 4000].iter_mut() {
            *s = 0.0;
        }
        let chunks = plan_chunks(&audio);
        assert_eq!(chunks.first().unwrap().0, 0);
        assert_eq!(chunks.last().unwrap().1, n);
        for w in chunks.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        for (a, b) in &chunks {
            assert!(b - a <= MAX_CHUNK && b > a);
        }
        let first_end = chunks[0].1;
        assert!(first_end >= 27 * SAMPLE_RATE && first_end <= 27 * SAMPLE_RATE + 4000);
    }

    #[test]
    fn short_audio_is_single_chunk() {
        assert_eq!(plan_chunks(&vec![0.0; 1000]), vec![(0, 1000)]);
        assert!(plan_chunks(&[]).is_empty());
    }
}
