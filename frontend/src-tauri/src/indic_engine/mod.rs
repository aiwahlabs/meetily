//! On-device Indian-language speech recognition (IndicConformer-600M, int8, CTC).
//!
//! - `model`:  pinned/hashed model files, status / download / delete
//! - `engine`: ONNX Runtime inference (`IndicEngine::load`, `transcribe`)
//! - `lid`:    spoken-language identification + English/Indic routing

pub mod engine;
pub mod lid;
pub mod model;

pub use engine::{IndicEngine, SUPPORTED};
pub use lid::{detect as detect_language, route, LangDetector, Route};
pub use model::{
    delete as delete_model, download as download_model, is_download_cancelled, model_dir,
    status as model_status, total_bytes as model_total_bytes, IndicModelStatus,
};

#[cfg(test)]
mod it;
