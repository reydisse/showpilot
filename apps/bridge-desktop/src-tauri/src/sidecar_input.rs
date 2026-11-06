//! Bounded native-to-sidecar delivery. Audio/MIDI callbacks never write to a pipe.
use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_AGE: Duration = Duration::from_millis(200);
const CAPACITY: usize = 8;
pub type SharedInput = Arc<Mutex<Option<Input>>>;

struct Message {
    payload: String,
    created: Instant,
    source: Arc<AtomicU8>,
    expected_source: u8,
}
#[derive(Clone)]
pub struct Input {
    sender: mpsc::SyncSender<Message>,
}
pub struct Writer {
    shutdown: Arc<AtomicBool>,
    writing_since: Arc<Mutex<Option<Instant>>>,
    worker: Option<JoinHandle<()>>,
}
impl Writer {
    pub fn new(mut stdin: ChildStdin) -> (Input, Self) {
        let (sender, receiver) = mpsc::sync_channel::<Message>(CAPACITY);
        let shutdown = Arc::new(AtomicBool::new(false));
        let writing_since = Arc::new(Mutex::new(None));
        let closing = shutdown.clone();
        let busy = writing_since.clone();
        let worker = thread::spawn(move || {
            while !closing.load(Ordering::Acquire) {
                let message = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                if message.created.elapsed() >= MAX_AGE
                    || message.source.load(Ordering::Acquire) != message.expected_source
                {
                    continue;
                }
                *busy.lock().unwrap() = Some(Instant::now());
                let result = writeln!(stdin, "{}", message.payload).and_then(|_| stdin.flush());
                *busy.lock().unwrap() = None;
                if result.is_err() {
                    break;
                }
            }
        });
        (
            Input { sender },
            Self {
                shutdown,
                writing_since,
                worker: Some(worker),
            },
        )
    }

    pub fn stalled(&self) -> bool {
        self.writing_since
            .lock()
            .unwrap()
            .is_some_and(|started| started.elapsed() >= MAX_AGE)
    }

    // The owner must kill/wait for the child BEFORE joining: closing the read
    // end releases an in-flight write even if the child stopped reading stdin.
    pub fn finish_after_child_exit(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn send(
    input: &SharedInput,
    source: &Arc<AtomicU8>,
    expected_source: u8,
    mut payload: serde_json::Value,
) -> Result<(), String> {
    if source.load(Ordering::Acquire) != expected_source {
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable")?;
    // The sidecar also checks the deadline. Bytes already in an OS pipe must
    // not become fresh timecode when a suspended process finally resumes.
    payload["expiresAt"] = serde_json::json!((now + MAX_AGE).as_millis() as u64);
    let message = Message {
        payload: payload.to_string(),
        created: Instant::now(),
        source: source.clone(),
        expected_source,
    };
    let sender = input
        .lock()
        .map_err(|_| "Bridge input unavailable")?
        .as_ref()
        .map(|input| input.sender.clone())
        .ok_or("Start the Bridge to send timecode to ShowPilot.")?;
    sender.try_send(message).map_err(|error| match error {
        mpsc::TrySendError::Full(_) => {
            "Bridge input is not keeping up; timecode frame dropped.".into()
        }
        mpsc::TrySendError::Disconnected(_) => "Bridge input disconnected.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn nonreading_child() {
        if std::env::var_os("SHOWPILOT_TEST_NONREADING_CHILD").is_some() {
            thread::sleep(Duration::from_secs(10));
        }
    }

    #[test]
    fn blocked_pipe_does_not_block_producers_and_child_exit_releases_writer() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sidecar_input::tests::nonreading_child",
                "--nocapture",
            ])
            .env("SHOWPILOT_TEST_NONREADING_CHILD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (input, mut writer) = Writer::new(child.stdin.take().unwrap());
        let source = Arc::new(AtomicU8::new(2));
        // Larger than the pipe capacity on every supported OS, forcing the
        // real writer to block without relying on a particular audio rate.
        input
            .sender
            .send(Message {
                payload: "x".repeat(4 * 1024 * 1024),
                created: Instant::now(),
                source: source.clone(),
                expected_source: 2,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !writer.stalled() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let stalled = writer.stalled();
        let shared = Arc::new(Mutex::new(Some(input)));
        let started = Instant::now();
        let mut full = false;
        for _ in 0..CAPACITY + 1 {
            full |= send(
                &shared,
                &source,
                2,
                serde_json::json!({ "type": "timecode-feed" }),
            )
            .is_err();
        }
        let producer_time = started.elapsed();
        // Cleanup precedes assertions so a failed test cannot leak its child.
        child.kill().unwrap();
        child.wait().unwrap();
        writer.finish_after_child_exit();
        assert!(stalled, "real unread pipe should hit the delivery deadline");
        assert!(full, "queue must be bounded");
        assert!(producer_time < Duration::from_millis(100));
    }
}
