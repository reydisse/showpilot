use crate::ltc_decoder::{LtcDecoder, LtcFrame, LtcRate};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

pub const MTC: u8 = 1;
pub const LTC: u8 = 2;
const RESCAN: Duration = Duration::from_secs(2);
const MAX_AGE: Duration = Duration::from_millis(200);
const AUDIO_QUEUE_CAPACITY: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputConfig {
    pub device_id: String,
    pub device_name: String,
    pub channel: u16,
    pub rate: LtcRate,
}
impl InputConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.device_id.is_empty()
            || self.device_id.len() > 1000
            || self.device_name.is_empty()
            || self.device_name.len() > 300
            || !(1..=32).contains(&self.channel)
        {
            return Err(
                "Choose an audio input, a channel between 1 and 32, and the LTC frame rate.".into(),
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInput {
    pub id: String,
    pub name: String,
    pub channels: u16,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub selected: Option<InputConfig>,
    pub connected: bool,
    pub locked: bool,
    pub timecode: Option<String>,
    pub last_frame_age_ms: Option<u64>,
    pub level: f32,
    pub sample_rate: Option<u32>,
    pub error: Option<String>,
}
pub fn list_inputs() -> Result<Vec<AudioInput>, String> {
    let inputs = cpal::default_host()
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device.description().ok()?.name().to_owned();
            let channels = device
                .supported_input_configs()
                .ok()?
                .filter(|c| c.min_sample_rate() <= 192000 && c.max_sample_rate() >= 16000)
                .map(|c| c.channels())
                .max()?
                .min(32);
            Some(AudioInput { id, name, channels })
        })
        .collect();
    Ok(inputs)
}

struct Block {
    first: u64,
    samples: Vec<i16>,
    captured: Instant,
    level: f32,
}
struct Capture {
    _stream: Box<dyn Send>,
    device_id: String,
    blocks: mpsc::Receiver<Block>,
    error: mpsc::Receiver<String>,
    failed: Arc<AtomicBool>,
    decoder: LtcDecoder,
    sample_rate: u32,
}

fn device_present(id: &str) -> Result<bool, String> {
    Ok(cpal::default_host()
        .input_devices()
        .map_err(|error| error.to_string())?
        .any(|device| {
            device
                .id()
                .ok()
                .is_some_and(|value| value.to_string() == id)
        }))
}

fn input_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channel: u16,
    blocks: mpsc::SyncSender<Block>,
    errors: mpsc::SyncSender<String>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let selected = usize::from(channel - 1);
    let mut first = 0;
    device
        .build_input_stream(
            config,
            move |data: &[T], info| {
                let timestamp = info.timestamp();
                let age = timestamp.callback.duration_since(timestamp.capture);
                let count = (data.len() / channels) as u64;
                // Driver buffering counts toward signal age, not just our queue delay.
                let captured = Instant::now().checked_sub(age);
                let Some(captured) = captured.filter(|_| age <= MAX_AGE) else {
                    first += count;
                    return;
                };
                let mut level = 0f32;
                let samples: Vec<_> = data
                    .chunks_exact(channels)
                    .map(|frame| {
                        let value: f32 = cpal::Sample::from_sample(frame[selected]);
                        let value = if value.is_finite() {
                            value.clamp(-1., 1.)
                        } else {
                            0.
                        };
                        level = level.max(value.abs());
                        (value * 32767.).round() as i16
                    })
                    .collect();
                // Never block the audio callback on the sidecar, decoding or disk IO.
                let _ = blocks.try_send(Block {
                    first,
                    samples,
                    captured,
                    level,
                });
                first += count;
            },
            move |error| {
                failed.store(true, Ordering::Release);
                let _ = errors.try_send(error.to_string());
            },
            None,
        )
        .map_err(|e| e.to_string())
}

fn open_capture(selected: &InputConfig) -> Result<Capture, String> {
    let host = cpal::default_host();
    let mut matches = Vec::new();
    let mut exact = None;
    for device in host.input_devices().map_err(|e| e.to_string())? {
        if device
            .id()
            .ok()
            .is_some_and(|id| id.to_string() == selected.device_id)
        {
            exact = Some(device);
            break;
        }
        if device
            .description()
            .ok()
            .is_some_and(|d| d.name() == selected.device_name)
        {
            matches.push(device);
        }
    }
    let device = exact.or_else(|| if matches.len() == 1 { matches.pop() } else { None })
        .ok_or("Selected audio input is unavailable or its name is ambiguous. Reconnect it or choose another input.")?;
    let supported = device.supported_input_configs().map_err(|e| e.to_string())?
        .filter(|c| c.channels() >= selected.channel && c.min_sample_rate() <= 192000 && c.max_sample_rate() >= 16000)
        .filter(|c| matches!(c.sample_format(), cpal::SampleFormat::F32 | cpal::SampleFormat::F64 | cpal::SampleFormat::I16 | cpal::SampleFormat::I32 | cpal::SampleFormat::U16))
        .min_by_key(|c| (c.channels(), if c.sample_format() == cpal::SampleFormat::F32 { 0 } else { 1 }))
        .ok_or("This input does not support the selected channel at an LTC-compatible sample format/rate.")?;
    let sample_rate = 48000u32.clamp(
        supported.min_sample_rate().max(16000),
        supported.max_sample_rate().min(192000),
    );
    let format = supported.sample_format();
    let config = supported.with_sample_rate(sample_rate).config();
    let (tx, blocks) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
    let (errors, error) = mpsc::sync_channel(1);
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match format {
        cpal::SampleFormat::F32 => input_stream::<f32>(
            &device,
            config,
            selected.channel,
            tx,
            errors,
            failed.clone(),
        ),
        cpal::SampleFormat::F64 => input_stream::<f64>(
            &device,
            config,
            selected.channel,
            tx,
            errors,
            failed.clone(),
        ),
        cpal::SampleFormat::I16 => input_stream::<i16>(
            &device,
            config,
            selected.channel,
            tx,
            errors,
            failed.clone(),
        ),
        cpal::SampleFormat::I32 => input_stream::<i32>(
            &device,
            config,
            selected.channel,
            tx,
            errors,
            failed.clone(),
        ),
        cpal::SampleFormat::U16 => input_stream::<u16>(
            &device,
            config,
            selected.channel,
            tx,
            errors,
            failed.clone(),
        ),
        _ => return Err("Unsupported audio sample format.".into()),
    }?;
    stream
        .play()
        .map_err(|e| format!("Audio capture could not start: {e}"))?;
    Ok(Capture {
        _stream: Box::new(stream),
        device_id: device.id().map_err(|error| error.to_string())?.to_string(),
        blocks,
        error,
        failed,
        decoder: LtcDecoder::new(sample_rate, selected.rate)?,
        sample_rate,
    })
}

type Reply = mpsc::Sender<Result<Status, String>>;
enum Command {
    Start(InputConfig, Arc<AtomicBool>, Reply),
    Restore(InputConfig),
    Stop(Reply),
    Shutdown,
}
enum DeviceOperation {
    Open(InputConfig),
    Present(String),
}
enum DeviceResult {
    Open(Result<Capture, String>),
    Present(Result<bool, String>),
}
enum PendingDevice {
    Start(InputConfig, Arc<AtomicBool>, Reply),
    Reconnect,
    Probe,
}
fn cancel_device(pending: &mut Option<PendingDevice>) {
    if let Some(PendingDevice::Start(_, cancelled, reply)) = pending.take() {
        cancelled.store(true, Ordering::Release);
        let _ = reply.send(Err("Audio input selection cancelled.".into()));
    }
}

pub struct AudioRuntime {
    sender: mpsc::SyncSender<Command>,
    status: Arc<Mutex<Status>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    discovery: Mutex<()>,
}
impl AudioRuntime {
    pub fn new(stdin: crate::sidecar_input::SharedInput, source: Arc<AtomicU8>) -> Self {
        Self::with_capture_factory(stdin, source, open_capture, device_present, RESCAN)
    }

    fn with_capture_factory(
        stdin: crate::sidecar_input::SharedInput,
        source: Arc<AtomicU8>,
        open: impl Fn(&InputConfig) -> Result<Capture, String> + Send + 'static,
        present: impl Fn(&str) -> Result<bool, String> + Send + 'static,
        rescan: Duration,
    ) -> Self {
        let (sender, commands) = mpsc::sync_channel(8);
        let status = Arc::new(Mutex::new(Status::default()));
        let shared = status.clone();
        // Keep at most one driver operation in flight. A permission dialog or
        // stalled driver cannot hold the audio command loop or app shutdown.
        // OS device calls have no portable cancellation API; on shutdown the
        // single operation is detached and its eventual result is discarded.
        let (device_requests, requests) = mpsc::sync_channel(1);
        let (device_results, results) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            while let Ok(operation) = requests.recv() {
                let result = match operation {
                    DeviceOperation::Open(config) => DeviceResult::Open(open(&config)),
                    DeviceOperation::Present(id) => DeviceResult::Present(present(&id)),
                };
                if device_results.send(result).is_err() {
                    break;
                }
            }
        });
        let worker = std::thread::spawn(move || {
            let mut capture: Option<Capture> = None;
            let mut device_busy = false;
            let mut pending_device: Option<PendingDevice> = None;
            let mut current = Status::default();
            let mut next_scan = Instant::now();
            let mut last_frame: Option<Instant> = None;
            let mut last_level: Option<Instant> = None;
            loop {
                match commands.recv_timeout(Duration::from_millis(10)) {
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(Command::Start(config, cancelled, reply)) => {
                        if cancelled.load(Ordering::Acquire) {
                            continue;
                        }
                        if device_busy {
                            let _ = reply.send(Err(
                                "Audio device access is still pending. Retry after it completes."
                                    .into(),
                            ));
                            continue;
                        }
                        if device_requests
                            .try_send(DeviceOperation::Open(config.clone()))
                            .is_err()
                        {
                            let _ = reply.send(Err("Audio device worker unavailable.".into()));
                            continue;
                        }
                        device_busy = true;
                        pending_device = Some(PendingDevice::Start(config, cancelled, reply));
                    }
                    Ok(Command::Restore(config)) => {
                        cancel_device(&mut pending_device);
                        capture = None;
                        last_frame = None;
                        last_level = None;
                        current = Status {
                            selected: Some(config),
                            ..Status::default()
                        };
                        source.store(LTC, Ordering::Release);
                        next_scan = Instant::now();
                    }
                    Ok(Command::Stop(reply)) => {
                        cancel_device(&mut pending_device);
                        capture = None;
                        last_frame = None;
                        last_level = None;
                        current = Status::default();
                        let _ =
                            source.compare_exchange(LTC, 0, Ordering::AcqRel, Ordering::Acquire);
                        *shared.lock().unwrap_or_else(|e| e.into_inner()) = current.clone();
                        let _ = reply.send(Ok(current.clone()));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if let Ok(result) = results.try_recv() {
                    device_busy = false;
                    match (pending_device.take(), result) {
                        (
                            Some(PendingDevice::Start(config, cancelled, reply)),
                            DeviceResult::Open(result),
                        ) => {
                            if cancelled.load(Ordering::Acquire) {
                                let _ = reply.send(Err("Audio input selection expired. Retry when device access is ready.".into()));
                            } else {
                                match result {
                                    Ok(candidate) => {
                                        current = Status {
                                            selected: Some(config),
                                            connected: true,
                                            sample_rate: Some(candidate.sample_rate),
                                            ..Status::default()
                                        };
                                        capture = Some(candidate);
                                        last_frame = None;
                                        last_level = None;
                                        source.store(LTC, Ordering::Release);
                                        *shared.lock().unwrap_or_else(|e| e.into_inner()) =
                                            current.clone();
                                        let _ = reply.send(Ok(current.clone()));
                                    }
                                    Err(error) => {
                                        let _ = reply.send(Err(error));
                                    }
                                }
                            }
                        }
                        (Some(PendingDevice::Reconnect), DeviceResult::Open(result))
                            if source.load(Ordering::Acquire) == LTC =>
                        {
                            match result {
                                Ok(active) => {
                                    current.sample_rate = Some(active.sample_rate);
                                    current.connected = true;
                                    current.locked = false;
                                    current.error = None;
                                    capture = Some(active);
                                }
                                Err(error) => current.error = Some(error),
                            }
                        }
                        (Some(PendingDevice::Probe), DeviceResult::Present(result)) => match result
                        {
                            Ok(false) => {
                                capture = None;
                                current.connected = false;
                                current.locked = false;
                                current.level = 0.;
                                current.error =
                                    Some("Audio input disconnected. Waiting to reconnect.".into());
                            }
                            Err(error) => {
                                current.error = Some(format!("Cannot check audio input: {error}"))
                            }
                            Ok(true) => {}
                        },
                        _ => {} // Stop/Restore cancelled this operation while the driver was busy.
                    }
                    next_scan = Instant::now() + rescan;
                }
                if let Some(active) = capture.as_mut() {
                    if active.failed.load(Ordering::Acquire) {
                        current.error = Some(active.error.try_recv().unwrap_or_else(|_| {
                            "Audio input disconnected. Waiting to reconnect.".into()
                        }));
                        current.connected = false;
                        current.locked = false;
                        current.level = 0.;
                        capture = None;
                    } else {
                        // Revisit Stop and source-selection commands even if audio keeps arriving.
                        for block in active.blocks.try_iter().take(AUDIO_QUEUE_CAPACITY) {
                            if block.captured.elapsed() > MAX_AGE {
                                continue;
                            }
                            current.level = block.level;
                            last_level = Some(block.captured);
                            for frame in active.decoder.feed(block.first, &block.samples) {
                                last_frame = Some(block.captured);
                                current.locked = true;
                                current.timecode = Some(frame.display());
                                current.error = None;
                                if let Err(error) = send_frame(&stdin, &source, &frame) {
                                    current.error = Some(error);
                                }
                            }
                        }
                    }
                }
                if !device_busy && Instant::now() >= next_scan {
                    let operation = if let Some(active) = capture.as_ref() {
                        Some((
                            DeviceOperation::Present(active.device_id.clone()),
                            PendingDevice::Probe,
                        ))
                    } else if source.load(Ordering::Acquire) == LTC {
                        current
                            .selected
                            .clone()
                            .map(|config| (DeviceOperation::Open(config), PendingDevice::Reconnect))
                    } else {
                        None
                    };
                    if let Some((operation, pending)) = operation {
                        if device_requests.try_send(operation).is_ok() {
                            device_busy = true;
                            pending_device = Some(pending);
                        } else {
                            current.error = Some("Audio device worker unavailable.".into());
                        }
                    }
                    next_scan = Instant::now() + rescan;
                }
                current.last_frame_age_ms =
                    last_frame.map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64);
                current.locked = current.connected
                    && current.locked
                    && current.last_frame_age_ms.is_some_and(|age| age < 500);
                if last_level.is_none_or(|at| at.elapsed() > MAX_AGE) {
                    current.level = 0.;
                }
                *shared.lock().unwrap_or_else(|e| e.into_inner()) = current.clone();
            }
            cancel_device(&mut pending_device);
            drop(capture);
        });
        Self {
            sender,
            status,
            worker: Mutex::new(Some(worker)),
            discovery: Mutex::new(()),
        }
    }
    pub fn inputs(&self) -> Result<Vec<AudioInput>, String> {
        // UI retries must not create more driver scans if one is still hung.
        let _scan = self.discovery.try_lock().map_err(|_| {
            "Audio input scan is still pending. Check device access before retrying."
        })?;
        list_inputs()
    }
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn start(&self, config: InputConfig) -> Result<Status, String> {
        config.validate()?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = cancelled.clone();
        let result = self.request(|reply| Command::Start(config, request_cancelled, reply));
        if result.is_err() {
            cancelled.store(true, Ordering::Release);
        }
        result
    }
    pub fn restore(&self, config: InputConfig) -> Result<(), String> {
        config.validate()?;
        self.sender
            .try_send(Command::Restore(config))
            .map_err(|_| "Audio engine busy or unavailable.".into())
    }
    pub fn stop(&self) -> Result<Status, String> {
        self.request(Command::Stop)
    }
    fn request(&self, command: impl FnOnce(Reply) -> Command) -> Result<Status, String> {
        let (reply, response) = mpsc::channel();
        self.sender
            .try_send(command(reply))
            .map_err(|_| "Audio engine busy or unavailable.")?;
        response
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| {
                "Audio engine did not respond. Check microphone permission and the selected device."
            })?
    }
    pub fn shutdown(&self) {
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = self.sender.send(Command::Shutdown);
            let _ = worker.join();
        }
    }
}
impl Drop for AudioRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn send_frame(
    stdin: &crate::sidecar_input::SharedInput,
    source: &Arc<AtomicU8>,
    frame: &LtcFrame,
) -> Result<(), String> {
    let payload = serde_json::json!({ "type": "timecode-feed", "source": "ltc-bridge", "timecode": frame.timecode, "format": frame.format, "totalFrames": frame.total_frames });
    crate::sidecar_input::send(stdin, source, LTC, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StreamGuard(Arc<AtomicBool>);
    impl Drop for StreamGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    struct TestInput {
        frames: mpsc::SyncSender<Block>,
        dropped: Arc<AtomicBool>,
    }
    fn selected(id: &str) -> InputConfig {
        InputConfig {
            device_id: id.into(),
            device_name: id.into(),
            channel: 1,
            rate: LtcRate::Fps30,
        }
    }
    fn capture(config: &InputConfig) -> (Capture, TestInput) {
        let (frames, blocks) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let (_, error) = mpsc::sync_channel(1);
        let dropped = Arc::new(AtomicBool::new(false));
        (
            Capture {
                _stream: Box::new(StreamGuard(dropped.clone())),
                device_id: config.device_id.clone(),
                blocks,
                error,
                failed: Arc::new(AtomicBool::new(false)),
                decoder: LtcDecoder::new(48000, config.rate).unwrap(),
                sample_rate: 48000,
            },
            TestInput { frames, dropped },
        )
    }
    fn wait_for(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "Audio worker did not reach the expected state"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn runtime(
        source: Arc<AtomicU8>,
        available: Arc<AtomicBool>,
    ) -> (AudioRuntime, mpsc::Receiver<TestInput>) {
        let (opened, inputs) = mpsc::channel();
        let can_open = available.clone();
        let runtime = AudioRuntime::with_capture_factory(
            Arc::new(Mutex::new(None)),
            source,
            move |config| {
                if !can_open.load(Ordering::Acquire) || config.device_id == "rejected" {
                    return Err("Audio access unavailable".into());
                }
                let (capture, input) = capture(config);
                opened.send(input).unwrap();
                Ok(capture)
            },
            move |_| Ok(available.load(Ordering::Acquire)),
            Duration::from_millis(20),
        );
        (runtime, inputs)
    }

    #[test]
    fn failed_selection_preserves_the_running_mtc_or_ltc_input() {
        let source = Arc::new(AtomicU8::new(MTC));
        let (runtime, inputs) = runtime(source.clone(), Arc::new(AtomicBool::new(true)));
        assert!(runtime.start(selected("rejected")).is_err());
        assert_eq!(source.load(Ordering::Acquire), MTC);
        assert!(runtime.status().selected.is_none());
        runtime.start(selected("audio")).unwrap();
        let original = inputs.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(runtime.start(selected("rejected")).is_err());
        assert_eq!(runtime.status().selected, Some(selected("audio")));
        assert!(runtime.status().connected);
        assert!(!original.dropped.load(Ordering::Acquire));
        runtime.stop().unwrap();
        assert!(original.dropped.load(Ordering::Acquire));
        assert_eq!(source.load(Ordering::Acquire), 0);
    }

    #[test]
    fn restores_an_unplugged_input_reacquires_after_replug_and_stops_without_reopening() {
        let source = Arc::new(AtomicU8::new(0));
        let available = Arc::new(AtomicBool::new(false));
        let (runtime, inputs) = runtime(source.clone(), available.clone());
        runtime.restore(selected("audio")).unwrap();
        wait_for(|| runtime.status().error.is_some());
        assert_eq!(runtime.status().selected, Some(selected("audio")));
        available.store(true, Ordering::Release);
        let first = inputs.recv_timeout(Duration::from_secs(1)).unwrap();
        wait_for(|| runtime.status().connected);
        let labels: Vec<_> = (0..20).map(|frame| [0, 0, 1, frame]).collect();
        let pcm = crate::ltc_decoder::tests::waveform(&labels, 48000, 30., false);
        for (index, chunk) in pcm.chunks(512).enumerate() {
            first
                .frames
                .send(Block {
                    first: (index * 512) as u64,
                    samples: chunk.to_vec(),
                    captured: Instant::now(),
                    level: 0.5,
                })
                .unwrap();
        }
        wait_for(|| runtime.status().locked);
        available.store(false, Ordering::Release);
        wait_for(|| !runtime.status().connected);
        assert!(first.dropped.load(Ordering::Acquire));
        assert!(!runtime.status().locked);
        assert_eq!(runtime.status().level, 0.);
        let age = runtime.status().last_frame_age_ms.unwrap();
        wait_for(|| runtime.status().last_frame_age_ms.unwrap() > age + 15);
        available.store(true, Ordering::Release);
        let second = inputs.recv_timeout(Duration::from_secs(1)).unwrap();
        wait_for(|| runtime.status().connected);
        assert!(
            !runtime.status().locked,
            "A new stream must acquire fresh LTC before claiming lock"
        );
        assert!(
            runtime.status().timecode.is_some(),
            "The held position remains visible"
        );
        runtime.stop().unwrap();
        assert!(second.dropped.load(Ordering::Acquire));
        std::thread::sleep(Duration::from_millis(80));
        assert!(inputs.try_recv().is_err());
        assert!(runtime.status().selected.is_none());
        assert_eq!(source.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_cancelled_device_open_cannot_take_over_a_newer_mtc_selection() {
        let source = Arc::new(AtomicU8::new(MTC));
        let (entered, did_enter) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        let resumed = Mutex::new(resumed);
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = dropped.clone();
        let runtime = AudioRuntime::with_capture_factory(
            Arc::new(Mutex::new(None)),
            source.clone(),
            move |config| {
                entered.send(()).unwrap();
                resumed
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
                let (mut capture, _input) = capture(config);
                capture._stream = Box::new(StreamGuard(guard.clone()));
                Ok(capture)
            },
            |_| Ok(true),
            RESCAN,
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let (reply, response) = mpsc::channel();
        runtime
            .sender
            .send(Command::Start(selected("audio"), cancelled.clone(), reply))
            .unwrap();
        did_enter.recv_timeout(Duration::from_secs(1)).unwrap();
        cancelled.store(true, Ordering::Release);
        source.store(MTC, Ordering::Release);
        resume.send(()).unwrap();
        assert!(response
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        wait_for(|| dropped.load(Ordering::Acquire));
        assert_eq!(source.load(Ordering::Acquire), MTC);
        assert!(runtime.status().selected.is_none());
    }
    #[test]
    fn stop_and_shutdown_remain_responsive_while_device_open_is_blocked() {
        let source = Arc::new(AtomicU8::new(MTC));
        let (entered, did_enter) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        let resumed = Mutex::new(resumed);
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = dropped.clone();
        let runtime = AudioRuntime::with_capture_factory(
            Arc::new(Mutex::new(None)),
            source.clone(),
            move |config| {
                entered.send(()).unwrap();
                resumed
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
                let (mut capture, _) = capture(config);
                capture._stream = Box::new(StreamGuard(guard.clone()));
                Ok(capture)
            },
            |_| Ok(true),
            RESCAN,
        );
        let (reply, response) = mpsc::channel();
        runtime
            .sender
            .send(Command::Start(
                selected("blocked"),
                Arc::new(AtomicBool::new(false)),
                reply,
            ))
            .unwrap();
        did_enter.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        let stop = runtime.stop();
        runtime.shutdown();
        let elapsed = started.elapsed();
        resume.send(()).unwrap();
        wait_for(|| dropped.load(Ordering::Acquire));
        assert!(stop.is_ok());
        assert!(
            elapsed < Duration::from_millis(250),
            "device driver held Stop or shutdown for {elapsed:?}"
        );
        assert!(response
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        assert_eq!(source.load(Ordering::Acquire), MTC);
    }
    #[test]
    #[ignore = "Run through apps/bridge/scripts/check-native-timecode.mjs with a local WebSocket fixture"]
    fn decoded_pcm_reaches_compiled_sidecar() {
        use std::io::{BufRead, BufReader};
        use std::process::{Child, Command as ProcessCommand, Stdio};
        struct ChildGuard {
            child: Child,
            writer: crate::sidecar_input::Writer,
        }
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                self.writer.finish_after_child_exit();
            }
        }
        let binary = std::env::var("SHOWPILOT_TIMECODE_PROBE_BINARY").expect("sidecar executable");
        let mut child = ProcessCommand::new(binary)
            .args(["--desktop", "--no-open"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (input, writer) = crate::sidecar_input::Writer::new(child.stdin.take().unwrap());
        let stdout = child.stdout.take().unwrap();
        let _child = ChildGuard { child, writer };
        let (ready, readiness) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("ACTIVE. This installation controls venue devices.") {
                    let _ = ready.send(());
                }
            }
        });
        readiness
            .recv_timeout(Duration::from_secs(10))
            .expect("sidecar must authenticate and become active");
        let (opened, inputs) = mpsc::channel();
        let runtime = AudioRuntime::with_capture_factory(
            Arc::new(Mutex::new(Some(input))),
            Arc::new(AtomicU8::new(0)),
            move |config| {
                let (capture, input) = capture(config);
                opened.send(input).unwrap();
                Ok(capture)
            },
            |_| Ok(true),
            RESCAN,
        );
        runtime.start(selected("PCM fixture")).unwrap();
        let input = inputs.recv_timeout(Duration::from_secs(1)).unwrap();
        let labels: Vec<_> = (0..24).map(|frame| [0, 0, 1, frame]).collect();
        let pcm = crate::ltc_decoder::tests::waveform(&labels, 48000, 30., false);
        for (index, chunk) in pcm.chunks(480).enumerate() {
            input
                .frames
                .send(Block {
                    first: (index * 480) as u64,
                    samples: chunk.to_vec(),
                    captured: Instant::now(),
                    level: 0.5,
                })
                .unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        wait_for(|| runtime.status().timecode.as_deref() == Some("00:00:01:22"));
        assert!(runtime.status().locked);
        assert!(
            runtime.status().error.is_none(),
            "{:?}",
            runtime.status().error
        );
        runtime.stop().unwrap();
        assert!(input.dropped.load(Ordering::Acquire));
        std::thread::sleep(Duration::from_millis(80));
    }
}
