use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const RESCAN: Duration = Duration::from_secs(2);
const LEASE: Duration = Duration::from_secs(8);
type Reply = mpsc::Sender<Result<Status, String>>;
type Sink = Arc<dyn Fn(Event) -> bool + Send + Sync>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Port {
    pub id: String,
    pub name: Option<String>,
    pub manufacturer: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    session_id: String,
    revision: u64,
    generation: u64,
    inputs: Vec<Port>,
    outputs: Vec<Port>,
    input_connected: bool,
    output_connected: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Ports {
        status: Status,
    },
    Message {
        #[serde(rename = "sessionId")]
        session_id: String,
        generation: u64,
        data: Vec<u8>,
    },
}

enum Command {
    Open {
        id: String,
        sink: Sink,
        reply: Reply,
    },
    Select {
        id: String,
        revision: u64,
        input: Option<Port>,
        output: Option<Port>,
        reply: Reply,
    },
    Refresh {
        id: String,
        reply: Reply,
    },
    Feedback {
        id: String,
        revision: u64,
        messages: BTreeMap<u8, [u8; 3]>,
        reply: Reply,
    },
    Close {
        id: String,
        reply: Reply,
    },
    Shutdown,
}

pub struct MidiControllerRuntime {
    sender: mpsc::SyncSender<Command>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl MidiControllerRuntime {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel(64);
        let worker = std::thread::spawn(move || {
            let mut session: Option<Session> = None;
            let mut next_scan = Instant::now() + RESCAN;
            loop {
                let command =
                    receiver.recv_timeout(next_scan.saturating_duration_since(Instant::now()));
                if session.as_ref().is_some_and(|current| !current.alive()) {
                    session = None;
                }
                match command {
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(Command::Open { id, sink, reply }) => {
                        if session.as_ref().is_some_and(|current| current.id == id) {
                            let _ = reply.send(Err("MIDI session is already open.".into()));
                            continue;
                        }
                        session = None; // Drop old connections and lights before accepting a new window session.
                        let mut current = Session::new(id, sink);
                        let result = current.refresh();
                        if result.is_ok() {
                            session = Some(current);
                        }
                        let _ = reply.send(result);
                    }
                    Ok(Command::Close { id, reply }) => {
                        if session.as_ref().is_some_and(|current| current.id == id) {
                            session = None;
                        }
                        let _ = reply.send(Ok(Status::empty(id)));
                    }
                    Ok(command) => {
                        let (id, reply) = match &command {
                            Command::Select { id, reply, .. }
                            | Command::Refresh { id, reply }
                            | Command::Feedback { id, reply, .. } => (id.clone(), reply.clone()),
                            _ => unreachable!(),
                        };
                        let Some(current) = session.as_mut().filter(|current| current.id == id)
                        else {
                            let _ = reply.send(Err(
                                "MIDI session expired. Connect and arm the controller again."
                                    .into(),
                            ));
                            continue;
                        };
                        current.seen = Instant::now();
                        let result = match command {
                            Command::Select {
                                revision,
                                input,
                                output,
                                ..
                            } => current.select(revision, input, output),
                            Command::Refresh { .. } => current.refresh(),
                            Command::Feedback {
                                revision, messages, ..
                            } => current.feedback(revision, messages),
                            _ => unreachable!(),
                        };
                        let _ = reply.send(result);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if Instant::now() >= next_scan {
                    if let Some(current) = session.as_mut() {
                        if !current.alive() || current.refresh().is_err() {
                            session = None;
                        }
                    }
                    next_scan = Instant::now() + RESCAN;
                }
            }
            drop(session);
        });
        Self {
            sender,
            worker: Mutex::new(Some(worker)),
        }
    }
    pub fn shutdown(&self) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(worker) = worker.take() {
            let _ = self.sender.send(Command::Shutdown);
            // Finish clearing owned LEDs before the application process exits.
            let _ = worker.join();
        }
    }
}
impl Drop for MidiControllerRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Status {
    fn empty(session_id: String) -> Self {
        Self {
            session_id,
            revision: 0,
            generation: 0,
            inputs: vec![],
            outputs: vec![],
            input_connected: false,
            output_connected: false,
            error: None,
        }
    }
}

struct Session {
    id: String,
    revision: u64,
    generation: u64,
    selected_input: Option<Port>,
    selected_output: Option<Port>,
    input: Option<(String, MidiInputConnection<()>)>,
    output: Option<(String, MidiOutputConnection)>,
    desired: BTreeMap<u8, [u8; 3]>,
    sent: BTreeMap<u8, [u8; 3]>,
    status: Status,
    sink: Sink,
    seen: Instant,
}
impl Session {
    fn new(id: String, sink: Sink) -> Self {
        Self {
            status: Status::empty(id.clone()),
            id,
            revision: 0,
            generation: 0,
            selected_input: None,
            selected_output: None,
            input: None,
            output: None,
            desired: BTreeMap::new(),
            sent: BTreeMap::new(),
            sink,
            seen: Instant::now(),
        }
    }
    fn alive(&self) -> bool {
        self.seen.elapsed() < LEASE
    }
    fn clear_output(&mut self) {
        if let Some((_, output)) = self.output.as_mut() {
            for note in self.sent.keys() {
                let _ = output.send(&[0x90, *note, 0]);
            }
        }
        self.sent.clear();
        self.output = None;
    }
    fn select(
        &mut self,
        revision: u64,
        input: Option<Port>,
        output: Option<Port>,
    ) -> Result<Status, String> {
        if revision <= self.revision {
            return Ok(self.status.clone());
        }
        self.revision = revision;
        if self.selected_input != input {
            self.input = None;
            self.generation += 1;
        }
        if self.selected_output != output {
            self.clear_output();
            self.desired.clear();
        }
        self.selected_input = input;
        self.selected_output = output;
        self.refresh()
    }
    fn refresh(&mut self) -> Result<Status, String> {
        let input = MidiInput::new("ShowPilot controller discovery").map_err(|e| e.to_string())?;
        let output = MidiOutput::new("ShowPilot feedback discovery").map_err(|e| e.to_string())?;
        let input_ports = input.ports();
        let output_ports = output.ports();
        let inputs: Vec<Port> = input_ports
            .iter()
            .filter_map(|port| {
                input.port_name(port).ok().map(|name| Port {
                    id: format!("native:{}", port.id()),
                    name: Some(name),
                    manufacturer: None,
                })
            })
            .collect();
        let outputs: Vec<Port> = output_ports
            .iter()
            .filter_map(|port| {
                output.port_name(port).ok().map(|name| Port {
                    id: format!("native:{}", port.id()),
                    name: Some(name),
                    manufacturer: None,
                })
            })
            .collect();
        let selected_input = resolve_port(&inputs, self.selected_input.as_ref()).cloned();
        let selected_output = resolve_port(&outputs, self.selected_output.as_ref()).cloned();
        let mut error = None;
        if self.input.as_ref().map(|(id, _)| id) != selected_input.as_ref().map(|port| &port.id) {
            self.input = None;
            self.generation += 1;
            if let Some(selected) = selected_input {
                if let Some(port) = input_ports
                    .iter()
                    .find(|port| format!("native:{}", port.id()) == selected.id)
                {
                    let mut reader =
                        MidiInput::new("ShowPilot controller").map_err(|e| e.to_string())?;
                    reader.ignore(Ignore::None);
                    let sink = self.sink.clone();
                    let id = self.id.clone();
                    let generation = self.generation;
                    match reader.connect(
                        port,
                        "ShowPilot controller input",
                        move |_, data, _| {
                            if controller_message(data) {
                                sink(Event::Message {
                                    session_id: id.clone(),
                                    generation,
                                    data: data.to_vec(),
                                });
                            }
                        },
                        (),
                    ) {
                        Ok(connection) => self.input = Some((selected.id, connection)),
                        Err(e) => error = Some(format!("Could not open controller input: {e}")),
                    }
                }
            }
        }
        if self.output.as_ref().map(|(id, _)| id) != selected_output.as_ref().map(|port| &port.id) {
            self.clear_output();
            if let Some(selected) = selected_output {
                if let Some(port) = output_ports
                    .iter()
                    .find(|port| format!("native:{}", port.id()) == selected.id)
                {
                    match MidiOutput::new("ShowPilot feedback")
                        .map_err(|e| e.to_string())?
                        .connect(port, "ShowPilot controller feedback")
                    {
                        Ok(connection) => self.output = Some((selected.id, connection)),
                        Err(e) => error = Some(format!("Could not open feedback output: {e}")),
                    }
                }
            }
        }
        if let Err(message) = self.flush() {
            error = Some(message);
            self.clear_output();
        }
        self.status = Status {
            session_id: self.id.clone(),
            revision: self.revision,
            generation: self.generation,
            inputs,
            outputs,
            input_connected: self.input.is_some(),
            output_connected: self.output.is_some(),
            error,
        };
        if !(self.sink)(Event::Ports {
            status: self.status.clone(),
        }) {
            return Err("MIDI workspace closed.".into());
        }
        Ok(self.status.clone())
    }
    fn feedback(
        &mut self,
        revision: u64,
        desired: BTreeMap<u8, [u8; 3]>,
    ) -> Result<Status, String> {
        if revision != self.revision {
            return Ok(self.status.clone());
        }
        self.desired = desired;
        self.flush()?;
        Ok(self.status.clone())
    }
    fn flush(&mut self) -> Result<(), String> {
        let Some((_, output)) = self.output.as_mut() else {
            return Ok(());
        };
        let removed: Vec<_> = self
            .sent
            .keys()
            .filter(|note| !self.desired.contains_key(note))
            .copied()
            .collect();
        for note in removed {
            output.send(&[0x90, note, 0]).map_err(|e| e.to_string())?;
            self.sent.remove(&note);
        }
        for (note, message) in &self.desired {
            if self.sent.get(note) != Some(message) {
                output.send(message).map_err(|e| e.to_string())?;
                // Keep ownership if a later write fails partway through a bank.
                self.sent.insert(*note, *message);
            }
        }
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.clear_output();
        self.input = None;
    }
}

fn resolve_port<'a>(ports: &'a [Port], selected: Option<&Port>) -> Option<&'a Port> {
    let selected = selected?;
    if let Some(port) = ports.iter().find(|port| port.id == selected.id) {
        return Some(port);
    }
    let name = selected.name.as_ref()?;
    let matches: Vec<_> = ports
        .iter()
        .filter(|port| port.name.as_ref() == Some(name))
        .collect();
    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}
fn controller_message(data: &[u8]) -> bool {
    data.len() == 3
        && matches!(data[0] & 0xf0, 0x80 | 0x90 | 0xb0)
        && data[1] < 128
        && data[2] < 128
}
fn feedback_messages(messages: Vec<Vec<u8>>) -> Result<BTreeMap<u8, [u8; 3]>, String> {
    if messages.len() > 128 {
        return Err("Too many MIDI feedback messages.".into());
    }
    let mut desired = BTreeMap::new();
    for message in messages {
        if message.len() != 3 || message[0] & 0xf0 != 0x90 || message[1] > 127 || message[2] > 127 {
            return Err("Only three-byte note feedback is allowed.".into());
        }
        if desired
            .insert(message[1], [message[0], message[1], message[2]])
            .is_some()
        {
            return Err("Duplicate feedback note.".into());
        }
    }
    Ok(desired)
}
fn validate_session(window: &str, id: &str) -> Result<(), String> {
    if window != "main" {
        return Err("MIDI controllers are available only in the main workspace.".into());
    }
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid MIDI session.".into());
    }
    Ok(())
}
fn validate_port(port: &Option<Port>) -> Result<(), String> {
    if port.as_ref().is_some_and(|p| {
        p.id.is_empty()
            || p.id.len() > 300
            || p.name.as_ref().is_some_and(|v| v.len() > 300)
            || p.manufacturer.as_ref().is_some_and(|v| v.len() > 300)
    }) {
        return Err("Invalid MIDI port selection.".into());
    }
    Ok(())
}
async fn request(
    sender: mpsc::SyncSender<Command>,
    make: impl FnOnce(Reply) -> Command + Send + 'static,
) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, response) = mpsc::channel();
        sender
            .try_send(make(reply))
            .map_err(|_| "MIDI engine busy or unavailable.".to_string())?;
        response
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "MIDI engine did not respond.".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn midi_controller_open(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MidiControllerRuntime>,
    session_id: String,
    channel: tauri::ipc::Channel<Event>,
) -> Result<Status, String> {
    validate_session(window.label(), &session_id)?;
    request(runtime.sender.clone(), move |reply| Command::Open {
        id: session_id,
        sink: Arc::new(move |event| channel.send(event).is_ok()),
        reply,
    })
    .await
}
#[tauri::command]
pub async fn midi_controller_select(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MidiControllerRuntime>,
    session_id: String,
    revision: u64,
    input: Option<Port>,
    output: Option<Port>,
) -> Result<Status, String> {
    validate_session(window.label(), &session_id)?;
    validate_port(&input)?;
    validate_port(&output)?;
    request(runtime.sender.clone(), move |reply| Command::Select {
        id: session_id,
        revision,
        input,
        output,
        reply,
    })
    .await
}
#[tauri::command]
pub async fn midi_controller_refresh(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MidiControllerRuntime>,
    session_id: String,
) -> Result<Status, String> {
    validate_session(window.label(), &session_id)?;
    request(runtime.sender.clone(), move |reply| Command::Refresh {
        id: session_id,
        reply,
    })
    .await
}
#[tauri::command]
pub async fn midi_controller_feedback(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MidiControllerRuntime>,
    session_id: String,
    revision: u64,
    messages: Vec<Vec<u8>>,
) -> Result<Status, String> {
    validate_session(window.label(), &session_id)?;
    let messages = feedback_messages(messages)?;
    request(runtime.sender.clone(), move |reply| Command::Feedback {
        id: session_id,
        revision,
        messages,
        reply,
    })
    .await
}
#[tauri::command]
pub async fn midi_controller_close(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MidiControllerRuntime>,
    session_id: String,
) -> Result<Status, String> {
    validate_session(window.label(), &session_id)?;
    request(runtime.sender.clone(), move |reply| Command::Close {
        id: session_id,
        reply,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(id: &str, name: &str) -> Port {
        Port {
            id: id.into(),
            name: Some(name.into()),
            manufacturer: None,
        }
    }

    #[test]
    fn accepts_controller_messages_without_consuming_timecode_or_system_messages() {
        for data in [[0x90, 63, 127], [0x8f, 1, 42], [0xb0, 48, 0]] {
            assert!(controller_message(&data));
        }
        for data in [
            vec![0xf1, 0x71],
            vec![0xf2, 0, 0],
            vec![0xfa],
            vec![0xfb],
            vec![0xfc],
            vec![0xf8],
            vec![0x90, 128, 1],
            vec![0x90, 0, 255],
            vec![0x90, 0],
            vec![0xf0, 0, 0xf7],
        ] {
            assert!(!controller_message(&data));
        }
    }

    #[test]
    fn only_bounded_note_led_feedback_crosses_the_native_boundary() {
        assert!(feedback_messages(vec![vec![0x96, 63, 13], vec![0x90, 100, 2]]).is_ok());
        for messages in [
            vec![vec![0xf0, 0, 0xf7]],
            vec![vec![0xb0, 48, 127]],
            vec![vec![0x90, 0, 128]],
            vec![vec![0x90, 128, 0]],
            vec![vec![0x90, 0]],
            vec![vec![0x90, 0, 1]; 129],
            vec![vec![0x90, 0, 1], vec![0x96, 0, 2]],
        ] {
            assert!(feedback_messages(messages).is_err());
        }
    }

    #[test]
    fn main_window_permission_and_session_validation_are_both_required() {
        assert!(validate_session("main", "window-123_abc").is_ok());
        for window in [
            "confidence-org",
            "timer-org",
            "show-board-org",
            "check-in-org",
            "other",
        ] {
            assert!(validate_session(window, "valid").is_err());
        }
        for id in ["", "../session", "has space", &"a".repeat(101)] {
            assert!(validate_session("main", id).is_err());
        }
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/midi-controller.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["remote"]["urls"],
            serde_json::json!(["https://showpilot.tech/*", "https://app.showpilot.tech/*"])
        );
        assert!(validate_port(&Some(port("", "bad"))).is_err());
        assert!(validate_port(&Some(port("native:id", &"n".repeat(301)))).is_err());
    }

    #[test]
    fn replug_uses_exact_identity_then_only_an_unambiguous_name() {
        let saved = port("native:old", "APC");
        let a = port("native:a", "APC");
        let b = port("native:b", "APC");
        assert_eq!(resolve_port(&[a.clone()], Some(&saved)), Some(&a));
        assert_eq!(resolve_port(&[a.clone(), b], Some(&saved)), None);
        assert_eq!(
            resolve_port(&[a.clone(), saved.clone()], Some(&saved)),
            Some(&saved)
        );
        assert_eq!(resolve_port(&[a], None), None);
    }

    #[test]
    fn idle_webview_session_expires_and_stale_selections_do_not_overwrite_newer_ones() {
        let mut session = Session::new("test".into(), Arc::new(|_| true));
        assert!(session.alive());
        session.seen = Instant::now() - LEASE;
        assert!(!session.alive());
        session.revision = 8;
        session.selected_input = Some(port("native:new", "New"));
        session
            .select(7, Some(port("native:old", "Old")), None)
            .unwrap();
        assert_eq!(session.selected_input.as_ref().unwrap().id, "native:new");
    }

    /// Run explicitly on a Mac with CoreMIDI. These are real OS ports, not mocked midir handles.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the macOS CoreMIDI service; run with --ignored"]
    fn coremidi_controller_input_feedback_replug_and_session_cleanup() {
        use midir::os::unix::{VirtualInput, VirtualOutput};
        fn call(runtime: &MidiControllerRuntime, make: impl FnOnce(Reply) -> Command) -> Status {
            let (tx, rx) = mpsc::channel();
            runtime.sender.send(make(tx)).unwrap();
            rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()
        }
        fn receive_message(rx: &mpsc::Receiver<Event>) -> (u64, Vec<u8>) {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap()
                {
                    Event::Message {
                        generation, data, ..
                    } => return (generation, data),
                    Event::Ports { .. } => {}
                }
            }
        }
        let suffix = format!("ShowPilot probe {}", std::process::id());
        let input_name = format!("{suffix} pads");
        let output_name = format!("{suffix} lights");
        let mut pads = MidiOutput::new(&input_name)
            .unwrap()
            .create_virtual(&input_name)
            .unwrap();
        let (led_tx, led_rx) = mpsc::channel();
        let replacement_led_tx = led_tx.clone();
        let lights = MidiInput::new(&output_name)
            .unwrap()
            .create_virtual(
                &output_name,
                move |_, data, _| {
                    led_tx.send(data.to_vec()).unwrap();
                },
                (),
            )
            .unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let runtime = MidiControllerRuntime::new();
        let sink: Sink = Arc::new(move |event| event_tx.send(event).is_ok());
        let opened = call(&runtime, |reply| Command::Open {
            id: "first".into(),
            sink: sink.clone(),
            reply,
        });
        let input = opened
            .inputs
            .iter()
            .find(|p| p.name.as_ref().is_some_and(|n| n.contains(&input_name)))
            .unwrap()
            .clone();
        let output = opened
            .outputs
            .iter()
            .find(|p| p.name.as_ref().is_some_and(|n| n.contains(&output_name)))
            .unwrap()
            .clone();
        let selected = call(&runtime, |reply| Command::Select {
            id: "first".into(),
            revision: 1,
            input: Some(input.clone()),
            output: Some(output.clone()),
            reply,
        });
        assert!(selected.input_connected && selected.output_connected);
        pads.send(&[0x90, 4, 127]).unwrap();
        assert_eq!(
            receive_message(&event_rx),
            (selected.generation, vec![0x90, 4, 127])
        );
        for data in [
            &[0xf1, 0x71][..],
            &[0xf2, 0, 0],
            &[0xfa],
            &[0xfb],
            &[0xfc],
            &[0xf8],
        ] {
            pads.send(data).unwrap();
        }
        pads.send(&[0xb0, 48, 11]).unwrap();
        assert_eq!(receive_message(&event_rx).1, vec![0xb0, 48, 11]);
        let feedback = || feedback_messages(vec![vec![0x96, 4, 13]]).unwrap();
        call(&runtime, |reply| Command::Feedback {
            id: "first".into(),
            revision: 1,
            messages: feedback(),
            reply,
        });
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x96, 4, 13]
        );
        call(&runtime, |reply| Command::Feedback {
            id: "first".into(),
            revision: 1,
            messages: feedback(),
            reply,
        });
        assert!(led_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(pads);
        let disconnected = call(&runtime, |reply| Command::Refresh {
            id: "first".into(),
            reply,
        });
        assert!(!disconnected.input_connected);
        let mut pads = MidiOutput::new(&input_name)
            .unwrap()
            .create_virtual(&input_name)
            .unwrap();
        let reconnected = call(&runtime, |reply| Command::Refresh {
            id: "first".into(),
            reply,
        });
        assert!(reconnected.input_connected);
        assert!(reconnected.generation > selected.generation);
        pads.send(&[0x90, 4, 127]).unwrap();
        assert_eq!(
            receive_message(&event_rx),
            (reconnected.generation, vec![0x90, 4, 127])
        );
        drop(lights);
        let disconnected = call(&runtime, |reply| Command::Refresh {
            id: "first".into(),
            reply,
        });
        assert!(!disconnected.output_connected);
        let _lights = MidiInput::new(&output_name)
            .unwrap()
            .create_virtual(
                &output_name,
                move |_, data, _| {
                    let _ = replacement_led_tx.send(data.to_vec());
                },
                (),
            )
            .unwrap();
        let reconnected = call(&runtime, |reply| Command::Refresh {
            id: "first".into(),
            reply,
        });
        assert!(reconnected.output_connected);
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x96, 4, 13]
        );
        call(&runtime, |reply| Command::Open {
            id: "second".into(),
            sink,
            reply,
        });
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x90, 4, 0]
        );
        call(&runtime, |reply| Command::Close {
            id: "first".into(),
            reply,
        });
        let second = call(&runtime, |reply| Command::Select {
            id: "second".into(),
            revision: 2,
            input: Some(input),
            output: Some(output),
            reply,
        });
        assert!(second.input_connected && second.output_connected);
        call(&runtime, |reply| Command::Select {
            id: "second".into(),
            revision: 1,
            input: None,
            output: None,
            reply,
        });
        call(&runtime, |reply| Command::Feedback {
            id: "second".into(),
            revision: 1,
            messages: feedback(),
            reply,
        });
        assert!(led_rx.recv_timeout(Duration::from_millis(50)).is_err());
        call(&runtime, |reply| Command::Feedback {
            id: "second".into(),
            revision: 2,
            messages: feedback(),
            reply,
        });
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x96, 4, 13]
        );
        // No keepalive: the worker itself releases the light and connection.
        assert_eq!(
            led_rx
                .recv_timeout(LEASE + RESCAN + Duration::from_secs(2))
                .unwrap(),
            vec![0x90, 4, 0]
        );
        let (tx, rx) = mpsc::channel();
        runtime
            .sender
            .send(Command::Refresh {
                id: "second".into(),
                reply: tx,
            })
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap().is_err());
        let third = call(&runtime, |reply| Command::Open {
            id: "shutdown".into(),
            sink: Arc::new(|_| true),
            reply,
        });
        let output = third
            .outputs
            .into_iter()
            .find(|p| p.name.as_ref().is_some_and(|n| n.contains(&output_name)))
            .unwrap();
        call(&runtime, |reply| Command::Select {
            id: "shutdown".into(),
            revision: 1,
            input: None,
            output: Some(output),
            reply,
        });
        call(&runtime, |reply| Command::Feedback {
            id: "shutdown".into(),
            revision: 1,
            messages: feedback(),
            reply,
        });
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x96, 4, 13]
        );
        runtime.shutdown();
        assert_eq!(
            led_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            vec![0x90, 4, 0]
        );
        runtime.shutdown(); // Repeated shutdown and Drop must be harmless.
    }
}
