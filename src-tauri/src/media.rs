//! Audio decoding fallback for the audio viewer: WKWebView cannot decode every container (Ogg Vorbis, AIFF-C, ...),
//! so those are decoded here with symphonia and handed to the webview as 16-bit PCM WAV, which WebAudio always accepts.
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::ipc::Response;

pub fn decode_to_wav(data: Vec<u8>, ext: &str) -> Result<Vec<u8>, String> {
    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(data)), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported audio: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or("no audio track")?;
    let track_id = track.id;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("no audio codec parameters")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;
    let mut pcm: Vec<i16> = Vec::new();
    let mut buf: Vec<i16> = Vec::new();
    let (mut rate, mut channels) = (0u32, 0u16);
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::IoError(_)) => break,
            Err(e) => return Err(format!("decode: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(b) => {
                rate = b.spec().rate();
                channels = b.spec().channels().count() as u16;
                buf.resize(b.samples_interleaved(), 0);
                b.copy_to_slice_interleaved(&mut buf);
                pcm.extend_from_slice(&buf);
            }
            Err(Error::DecodeError(_)) => {}
            Err(_) => break,
        }
    }
    if rate == 0 || channels == 0 || pcm.is_empty() {
        return Err("no audio decoded".into());
    }
    let data_len = (pcm.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + pcm.len() * 2);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&channels.to_le_bytes());
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    w.extend_from_slice(&(channels * 2).to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        w.extend_from_slice(&s.to_le_bytes());
    }
    Ok(w)
}

fn body_and_ext(request: &tauri::ipc::Request<'_>) -> Result<(Vec<u8>, String), String> {
    let ext = request.headers().get("ext").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok((b.clone(), ext)),
        _ => Err("expected a raw body".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: u32,
    pub frames: Option<u64>,
    pub bits: Option<u32>,
}

/// Header-level facts (native sample rate, channels, frame count) straight from the container, no decoding. WebAudio's
/// decodeAudioData resamples to its context rate, so the viewer needs the real rate from here.
pub fn probe_info(data: Vec<u8>, ext: &str) -> Result<AudioInfo, String> {
    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(data)), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(ext);
    }
    let format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported audio: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or("no audio track")?;
    let p = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("no audio codec parameters")?;
    Ok(AudioInfo {
        sample_rate: p.sample_rate.ok_or("unknown sample rate")?,
        channels: p.channels.as_ref().map(|c| c.count() as u32).unwrap_or(0),
        frames: track.num_frames,
        bits: p.bits_per_sample,
    })
}

/// Raw file bytes in the request body (no second disk/ssh read), `ext` header = file extension.
#[tauri::command]
pub async fn audio_info(request: tauri::ipc::Request<'_>) -> Result<AudioInfo, String> {
    let (data, ext) = body_and_ext(&request)?;
    tauri::async_runtime::spawn_blocking(move || probe_info(data, &ext)).await.map_err(|e| e.to_string())?
}

/// Decode any audio symphonia understands (ogg/vorbis, aiff, flac, mp3, wav) into a PCM WAV for WebAudio.
#[tauri::command]
pub async fn audio_decode_wav(request: tauri::ipc::Request<'_>) -> Result<Response, String> {
    let (data, ext) = body_and_ext(&request)?;
    tauri::async_runtime::spawn_blocking(move || decode_to_wav(data, &ext).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wav_roundtrip() {
        // 8 frames mono 8 kHz 16-bit PCM wav -> decode -> same frame count
        let mut w = Vec::new();
        let pcm: Vec<i16> = (0..8).map(|i| i * 1000).collect();
        let dl = (pcm.len() * 2) as u32;
        w.extend_from_slice(b"RIFF"); w.extend_from_slice(&(36 + dl).to_le_bytes()); w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&8000u32.to_le_bytes()); w.extend_from_slice(&16000u32.to_le_bytes()); w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes()); w.extend_from_slice(b"data"); w.extend_from_slice(&dl.to_le_bytes());
        for s in &pcm { w.extend_from_slice(&s.to_le_bytes()); }
        let out = decode_to_wav(w, "wav").unwrap();
        assert_eq!(out.len(), 44 + 16);
        assert_eq!(u32::from_le_bytes(out[24..28].try_into().unwrap()), 8000);
    }
}
