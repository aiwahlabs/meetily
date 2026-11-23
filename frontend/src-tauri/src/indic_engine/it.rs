//! Real-model integration tests. Ignored by default; run with
//! `INDIC_SCRATCH=<dir> cargo test --release -p meetily --lib -- indic_engine::it --ignored --nocapture --test-threads=1`
//! Layout of <dir>: `install/` (model files), `clips/` (*.f32 + refs.json), `whisper/ggml-*.bin`.

use super::*;
use std::path::PathBuf;
use std::time::Instant;

fn scratch() -> PathBuf {
    PathBuf::from(std::env::var("INDIC_SCRATCH").expect("set INDIC_SCRATCH"))
}

fn init_ort() {
    let dll = std::env::var("INDIC_ORT_DLL").expect("set INDIC_ORT_DLL");
    ort::init_from(dll).commit().expect("ort init");
}

fn rss_mb() -> f64 {
    use sysinfo::{Pid, System};
    let mut sys = System::new();
    let pid = Pid::from_u32(std::process::id());
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory() as f64 / 1048576.0).unwrap_or(0.0)
}

fn read_f32(path: &std::path::Path) -> Vec<f32> {
    std::fs::read(path)
        .unwrap()
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn normalize(s: &str) -> Vec<char> {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() || is_mark(c) { c } else { ' ' })
        .collect();
    cleaned
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect()
}

fn is_mark(c: char) -> bool {
    // Indic vowel signs / viramas / nukta / chillu (combining marks) are not alphanumeric in Rust.
    matches!(c as u32, 0x0900..=0x0DFF) || c == '\u{200c}' || c == '\u{200d}'
}

fn cer(hyp: &str, reference: &str) -> f64 {
    let (h, r) = (normalize(hyp), normalize(reference));
    if r.is_empty() {
        return 0.0;
    }
    let mut prev: Vec<usize> = (0..=h.len()).collect();
    for i in 1..=r.len() {
        let mut cur = vec![i; h.len() + 1];
        for j in 1..=h.len() {
            let sub = prev[j - 1] + (r[i - 1] != h[j - 1]) as usize;
            cur[j] = sub.min(prev[j] + 1).min(cur[j - 1] + 1);
        }
        prev = cur;
    }
    prev[h.len()] as f64 / r.len() as f64
}

#[tokio::test]
#[ignore]
async fn download_real_files() {
    let dir = scratch().join("install");
    let token = tokio_util::sync::CancellationToken::new();
    let t = Instant::now();
    let last = std::sync::atomic::AtomicU64::new(0);
    model::download(&dir, &token, |d, total| {
        let pct = d * 100 / total;
        if pct != last.swap(pct, std::sync::atomic::Ordering::Relaxed) && pct % 10 == 0 {
            println!("download {pct}% ({d}/{total})");
        }
    })
    .await
    .unwrap();
    println!("download took {:?}", t.elapsed());
    let s = model::status(&dir);
    println!("status: {:?}", s);
    assert!(s.installed);
    model::verify(&dir).unwrap();
}

#[test]
#[ignore]
fn transcribe_and_lid_real_clips() {
    init_ort();
    let root = scratch();
    let refs: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("clips/refs.json")).unwrap()).unwrap();
    let rss0 = rss_mb();
    let t = Instant::now();
    let skip_asr = std::env::var("INDIC_SKIP_ASR").is_ok();
    let eng = if skip_asr { None } else { Some(IndicEngine::load(&root.join("install")).expect("load engine")) };
    println!("engine load: {:?}, RSS {:.0} MB -> {:.0} MB", t.elapsed(), rss0, rss_mb());

    let lid_model = root.join(std::env::var("INDIC_LID").unwrap_or("whisper/ggml-base.bin".into()));
    let t = Instant::now();
    let det = LangDetector::new(&lid_model).expect("lid load");
    println!("lid model load: {:?}", t.elapsed());
    let allowed: Vec<&str> = SUPPORTED.iter().map(|(c, _)| *c).collect();

    let mut names: Vec<String> = refs.as_object().unwrap().keys().cloned().collect();
    names.sort();
    for name in names {
        let samples = read_f32(&root.join(format!("clips/{name}.f32")));
        let secs = samples.len() as f64 / 16000.0;
        let code = name.split('_').next().unwrap();
        let reference = refs[&name].as_str().unwrap();

        if code != "en" && !skip_asr {
            let eng = eng.as_ref().unwrap();
            let t = Instant::now();
            let text = eng.transcribe(&samples, code).expect("transcribe");
            let el = t.elapsed().as_secs_f64();
            println!(
                "[{name}] {secs:.1}s RTF {:.3} CER {:.3} RSS {:.0} MB\n  hyp: {text}\n  ref: {reference}",
                el / secs,
                cer(&text, reference),
                rss_mb()
            );
        }
        let t = Instant::now();
        let probs = det.detect(&samples).expect("lid");
        let top: Vec<String> = probs.iter().take(3).map(|(c, p)| format!("{c}={p:.2}")).collect();
        let r = route(&[probs.clone()], &allowed);
        println!("[{name}] LID top3 {:?} route {:?} ({:.2}s)", top, r, t.elapsed().as_secs_f64());
    }

    if skip_asr { return; }
    let eng = eng.as_ref().unwrap();
    // Long-audio chunking: concatenate all non-English clips (~35 s+) and a 2x repeat.
    let mut long = Vec::new();
    for n in ["ml_in_0", "ml_in_1", "ml_in_0", "ml_in_1", "ml_in_0", "ml_in_1"] {
        long.extend(read_f32(&root.join(format!("clips/{n}.f32"))));
    }
    let secs = long.len() as f64 / 16000.0;
    let t = Instant::now();
    let text = eng.transcribe(&long, "ml").unwrap();
    println!("[long ml] {secs:.1}s RTF {:.3} RSS {:.0} MB chars {}", t.elapsed().as_secs_f64() / secs, rss_mb(), text.chars().count());
}
