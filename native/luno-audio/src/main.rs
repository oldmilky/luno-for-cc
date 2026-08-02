//! Microphone capture, as a program rather than a module.
//!
//! Writes raw linear16 — 16 kHz, mono, little-endian — to stdout for as long
//! as it runs, which is exactly what `rec` and `arecord` do and exactly what
//! the speech endpoint is opened for. That is the point: the extension already
//! has a capture path that spawns a recorder and reads its stdout, so this
//! ships as one more recorder rather than as a new mechanism.
//!
//! A device is almost never willing to produce that format directly. Windows
//! hands out 44.1 or 48 kHz float, stereo as often as not, so the conversion
//! down to what the endpoint wants happens here, once, in the process that is
//! allowed to die if a driver misbehaves.

use std::io::{self, ErrorKind, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{InputCallbackInfo, SampleFormat, StreamConfig};

const TARGET_RATE: f64 = 16_000.0;

/// Long enough not to spin, short enough that a device failing silently is
/// noticed rather than waited on forever.
const POLL: Duration = Duration::from_millis(250);

fn main() {
    match run() {
        Ok(()) => {}
        Err(message) => {
            // stderr, because stdout is the audio. The extension surfaces this
            // verbatim, so it has to read as a sentence.
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device is available.")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("The default input device refused to describe itself: {e}"))?;

    let sample_format = config.sample_format();
    let channels = config.channels() as usize;
    let stream_config: StreamConfig = config.into();
    let ratio = f64::from(stream_config.sample_rate.0) / TARGET_RATE;

    // The audio thread must never block on a pipe. It converts and hands the
    // frames over; this thread does the writing and is the one allowed to
    // stall. Both senders are cloned per arm below because each arm builds its
    // own callback, and a closure that captures them moves them.
    let (frames, incoming) = mpsc::channel::<Vec<i16>>();
    let (failures, errors) = mpsc::channel::<String>();

    macro_rules! input_stream {
        ($sample:ty, $to_unit:expr) => {{
            let mut down = Downmix::new(channels, ratio);
            let frames = frames.clone();
            let failures = failures.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[$sample], _: &InputCallbackInfo| {
                    let _ = frames.send(down.feed(data.iter().copied().map($to_unit)));
                },
                move |e: cpal::StreamError| {
                    let _ = failures.send(format!("The microphone stopped: {e}"));
                },
                None,
            )
        }};
    }

    let stream = match sample_format {
        SampleFormat::F32 => input_stream!(f32, |s: f32| s),
        SampleFormat::I16 => input_stream!(i16, |s: i16| f32::from(s) / 32768.0),
        SampleFormat::U16 => input_stream!(u16, |s: u16| (f32::from(s) - 32768.0) / 32768.0),
        other => return Err(format!("Unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("The microphone would not open: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("The microphone opened but would not start: {e}"))?;

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut bytes = Vec::with_capacity(4096);

    loop {
        // A device that fails reports on its own channel and then sends no
        // more frames, so waiting on frames alone would wait forever.
        if let Ok(failure) = errors.try_recv() {
            return Err(failure);
        }
        let chunk = match incoming.recv_timeout(POLL) {
            Ok(chunk) => chunk,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        if chunk.is_empty() {
            continue;
        }
        bytes.clear();
        for sample in &chunk {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        // A closed pipe means the extension stopped listening, which is how
        // this program is meant to end. Anything else is worth reporting.
        match out.write_all(&bytes).and_then(|()| out.flush()) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(format!("Could not write audio: {e}")),
        }
    }
}

/// Many channels at the device's rate, in; one channel at 16 kHz, out.
///
/// The resampling is a box average rather than a windowed filter: it consumes
/// `ratio` input samples per output sample and emits their mean. For the rates
/// a microphone actually reports — 44.1 and 48 kHz against 16 — that averages
/// three-ish samples, which both decimates and takes the edge off the aliasing
/// a bare "keep every third sample" would fold into the speech band.
struct Downmix {
    channels: usize,
    ratio: f64,
    position: f64,
    sum: f32,
    count: u32,
}

impl Downmix {
    fn new(channels: usize, ratio: f64) -> Self {
        Self {
            channels: channels.max(1),
            ratio: ratio.max(1.0),
            position: 0.0,
            sum: 0.0,
            count: 0,
        }
    }

    fn feed(&mut self, samples: impl Iterator<Item = f32>) -> Vec<i16> {
        let mut out = Vec::new();
        let mut frame = 0.0f32;
        let mut in_frame = 0usize;

        for sample in samples {
            frame += sample;
            in_frame += 1;
            if in_frame < self.channels {
                continue;
            }
            self.push(frame / self.channels as f32, &mut out);
            frame = 0.0;
            in_frame = 0;
        }
        out
    }

    fn push(&mut self, mono: f32, out: &mut Vec<i16>) {
        self.sum += mono;
        self.count += 1;
        self.position += 1.0;
        if self.position < self.ratio {
            return;
        }
        self.position -= self.ratio;
        let mean = self.sum / self.count as f32;
        out.push((mean.clamp(-1.0, 1.0) * 32767.0) as i16);
        self.sum = 0.0;
        self.count = 0;
    }
}
