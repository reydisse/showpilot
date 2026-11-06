use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Manager;

const MAX_LOG_LINES: usize = 80;
const LOCAL_DEVICE_CONFIRMATION_VERSION: u8 = 1;
const CREDENTIAL_SERVICE: &str = "tech.showpilot.desktop.bridge";

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    site: String,
    org: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    local_devices_enabled: bool,
    #[serde(default)]
    local_devices_confirmation_version: u8,
    #[serde(default)]
    propresenter_host: Option<String>,
    #[serde(default)]
    propresenter_port: Option<u16>,
    #[serde(default)]
    propresenter_api_port: Option<u16>,
    #[serde(default)]
    propresenter_password: Option<String>,
}

struct BridgeProcess {
    child: Child,
    observation: Arc<Mutex<BridgeObservation>>,
    local_control_token: String,
    _local_show_lock: fs::File,
}

struct BridgeObservation {
    connection: BridgeConnection,
    logs: VecDeque<String>,
    local_control_port: Option<u16>,
}

impl BridgeObservation {
    fn new() -> Self {
        Self {
            connection: BridgeConnection::Connecting,
            logs: VecDeque::new(),
            local_control_port: None,
        }
    }

    fn push(&mut self, line: String) {
        if let Some(port) = line.strip_prefix("[bridge-local-control] ") {
            self.local_control_port = port.parse::<u16>().ok().filter(|port| *port > 0);
            return;
        }
        self.connection = connection_from_log(self.connection, &line);
        self.logs.push_back(line);
        while self.logs.len() > MAX_LOG_LINES {
            self.logs.pop_front();
        }
    }
}

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct BridgeRuntime {
    process: Mutex<Option<BridgeProcess>>,
    auto_restart: AtomicBool,
    last_logs: Mutex<VecDeque<String>>,
}

impl BridgeRuntime {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            auto_restart: AtomicBool::new(false),
            last_logs: Mutex::new(VecDeque::new()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    configured: bool,
    configured_site: Option<String>,
    configured_org: Option<String>,
    secure_credentials: bool,
    local_devices_enabled: bool,
    running: bool,
    connection: BridgeConnection,
    pid: Option<u32>,
    logs: Vec<String>,
    last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeConnection {
    Offline,
    Connecting,
    Connected,
    Disconnected,
    Unauthorized,
    Error,
}

fn connection_from_log(current: BridgeConnection, line: &str) -> BridgeConnection {
    let normalized = line.to_ascii_lowercase();
    if !normalized.starts_with("[bridge]") {
        return current;
    }
    if normalized.contains("authentication failed")
        || normalized.contains("unexpected server response: 401")
    {
        BridgeConnection::Unauthorized
    } else if normalized.contains("websocket error")
        || normalized.contains("connection rejected")
        || normalized.contains("unable to start")
        || normalized.contains("output error")
    {
        BridgeConnection::Error
    } else if normalized.contains("connected to showpilot") {
        BridgeConnection::Connected
    } else if normalized.contains("connecting to") {
        BridgeConnection::Connecting
    } else if normalized.contains("disconnected") {
        if matches!(
            current,
            BridgeConnection::Unauthorized | BridgeConnection::Error
        ) {
            current
        } else {
            BridgeConnection::Disconnected
        }
    } else {
        current
    }
}

#[cfg(test)]
fn connection_from_logs(logs: &[String]) -> BridgeConnection {
    let mut connection = BridgeConnection::Offline;
    for line in logs {
        connection = connection_from_log(connection, line);
    }
    connection
}

fn last_error_from_logs(logs: &[String]) -> Option<String> {
    logs.iter().rev().find_map(|line| {
        let trimmed = line.trim();
        let normalized = trimmed.to_ascii_lowercase();
        if normalized.starts_with("[pp-bridge]") {
            None
        } else if normalized.starts_with("error:")
            || normalized.contains("authentication failed")
            || normalized.contains("connection rejected")
            || normalized.contains("websocket error")
            || normalized.contains("unable to start")
            || normalized.contains("output error")
        {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

fn validate_config(config: &BridgeConfig) -> Result<(), String> {
    let site = config.site.trim().trim_end_matches('/');
    let trusted_site = site.starts_with("https://")
        || site.starts_with("http://localhost:")
        || site.starts_with("http://127.0.0.1:");
    if !trusted_site {
        return Err("Bridge site must use HTTPS or an explicit localhost development port".into());
    }
    if config.org.is_empty()
        || config.org.len() > 64
        || !config
            .org
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid organization slug".into());
    }
    if !config.key.starts_with("sp_") || config.key.len() > 256 {
        return Err("A valid ShowPilot API key is required".into());
    }
    Ok(())
}

fn has_confirmed_local_device_ownership(config: &BridgeConfig) -> bool {
    config.local_devices_enabled
        && config.local_devices_confirmation_version == LOCAL_DEVICE_CONFIRMATION_VERSION
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("desktop-bridge-config.json"))
}

fn read_config(app: &tauri::AppHandle) -> Result<Option<BridgeConfig>, String> {
    let config: Option<BridgeConfig> =
        showpilot_native_credentials::load(&config_path(app)?, CREDENTIAL_SERVICE)?;
    if let Some(config) = &config {
        validate_config(config)?;
    }
    Ok(config)
}

fn save_config(app: &tauri::AppHandle, config: &BridgeConfig) -> Result<(), String> {
    validate_config(config)?;
    showpilot_native_credentials::save(&config_path(app)?, CREDENTIAL_SERVICE, config)
}

fn append_log(observation: &Arc<Mutex<BridgeObservation>>, line: String) {
    if let Ok(mut observation) = observation.lock() {
        observation.push(line);
    }
}

fn capture_output<R: Read + Send + 'static>(
    reader: R,
    observation: Arc<Mutex<BridgeObservation>>,
    key: String,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => append_log(
                    &observation,
                    showpilot_native_credentials::redact(&line, &key),
                ),
                Err(error) => {
                    append_log(
                        &observation,
                        format!("[bridge] Device engine output error: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn bridge_command(config: &BridgeConfig) -> Result<Command, String> {
    validate_config(config)?;
    let packaged_binary = std::env::current_exe().ok().and_then(|path| {
        let directory = path.parent()?;
        [
            directory.join("showpilot-bridge"),
            directory.join("showpilot-bridge.exe"),
        ]
        .into_iter()
        .find(|candidate| candidate.exists())
    });

    let mut command = if let Some(path) = packaged_binary {
        let mut command = Command::new(path);
        command.args(["--no-open", "--desktop"]);
        command
    } else {
        let script = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join("../bridge/dist/index.js");
        if !script.exists() {
            return Err("The ShowPilot device engine has not been built".into());
        }
        let mut command = Command::new("node");
        command.arg(&script).args(["--no-open", "--desktop"]);
        command.current_dir(
            script
                .parent()
                .ok_or_else(|| "Invalid device engine path".to_string())?,
        );
        command
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .env(
            "SHOWPILOT_SITE_URL",
            config.site.trim().trim_end_matches('/'),
        )
        .env("SHOWPILOT_ORG", config.org.trim())
        .env("SHOWPILOT_BRIDGE_KEY", config.key.trim())
        .env("SHOWPILOT_PARENT_PID", std::process::id().to_string());
    if let Some(host) = &config.propresenter_host {
        command.env("SHOWPILOT_PROPRESENTER_HOST", host);
    }
    if let Some(port) = config.propresenter_port {
        command.env("SHOWPILOT_PROPRESENTER_PORT", port.to_string());
    }
    if let Some(port) = config.propresenter_api_port {
        command.env("SHOWPILOT_PROPRESENTER_API_PORT", port.to_string());
    }
    if let Some(password) = &config.propresenter_password {
        command.env("SHOWPILOT_PROPRESENTER_PASSWORD", password);
    }
    Ok(command)
}

fn lock_local_show_directory(directory: &std::path::Path) -> Result<fs::File, String> {
    fs::create_dir_all(directory).map_err(|_| "Unable to create local show storage".to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("owner.lock"))
        .map_err(|_| "Unable to open local show ownership lock".to_string())?;
    file.try_lock().map_err(|_| "Another ShowPilot Desktop instance owns local show control. Close it before starting this engine.".to_string())?;
    Ok(file)
}

fn spawn_process(
    config: &BridgeConfig,
    local_directory: &std::path::Path,
) -> Result<BridgeProcess, String> {
    let local_show_lock = lock_local_show_directory(local_directory)?;
    let observation = Arc::new(Mutex::new(BridgeObservation::new()));
    let mut command = bridge_command(config)?;
    let local_control_token = uuid::Uuid::new_v4().simple().to_string();
    command.env("SHOWPILOT_LOCAL_CONTROL_TOKEN", &local_control_token);
    command.env("SHOWPILOT_LOCAL_SHOW_DIRECTORY", local_directory);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start the local device engine: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        capture_output(stdout, Arc::clone(&observation), config.key.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        capture_output(stderr, Arc::clone(&observation), config.key.clone());
    }
    Ok(BridgeProcess {
        child,
        observation,
        local_control_token,
        _local_show_lock: local_show_lock,
    })
}

fn replace_process(
    runtime: &BridgeRuntime,
    config: &BridgeConfig,
    app: &tauri::AppHandle,
) -> Result<u32, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("local-shows");
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    // One sidecar owns the local device sockets and encrypted show journal.
    // Reap the previous child before a replacement can open either resource.
    if let Some(mut previous) = process.take() {
        if previous
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            previous
                .child
                .kill()
                .map_err(|error| format!("Unable to stop the previous device engine: {error}"))?;
        }
        previous
            .child
            .wait()
            .map_err(|error| format!("Unable to reap the previous device engine: {error}"))?;
    }
    let active = spawn_process(config, &directory)?;
    let pid = active.child.id();
    *process = Some(active);
    runtime.auto_restart.store(true, Ordering::Relaxed);
    Ok(pid)
}

#[tauri::command]
pub fn bridge_status(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    let saved_config = read_config(&app)?;
    let configured = saved_config.is_some();
    let local_devices_enabled = saved_config
        .as_ref()
        .is_some_and(has_confirmed_local_device_ownership);
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    let mut running = false;
    let mut pid = None;
    let mut logs = Vec::new();
    let mut observed_connection = BridgeConnection::Offline;

    if let Some(active) = process.as_mut() {
        running = active
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none();
        if running {
            pid = Some(active.child.id());
        }
        let snapshot = {
            let observation = active
                .observation
                .lock()
                .map_err(|_| "Device engine status unavailable".to_string())?;
            (
                observation.connection,
                observation.logs.iter().cloned().collect::<Vec<_>>(),
            )
        };
        observed_connection = snapshot.0;
        logs = snapshot.1;
        if !running {
            if let Ok(mut previous) = runtime.last_logs.lock() {
                previous.clear();
                previous.extend(logs.iter().cloned());
            }
            *process = None;
        }
    }
    if logs.is_empty() {
        logs = runtime
            .last_logs
            .lock()
            .map_err(|_| "Device engine logs unavailable".to_string())?
            .iter()
            .cloned()
            .collect();
    }

    let connection = if running {
        observed_connection
    } else {
        BridgeConnection::Offline
    };
    let last_error = if matches!(
        connection,
        BridgeConnection::Unauthorized | BridgeConnection::Error
    ) || !running
    {
        last_error_from_logs(&logs)
    } else {
        None
    };

    Ok(BridgeStatus {
        configured,
        configured_site: saved_config.as_ref().map(|config| config.site.clone()),
        configured_org: saved_config.as_ref().map(|config| config.org.clone()),
        secure_credentials: true,
        local_devices_enabled,
        running,
        connection,
        pid,
        last_error,
        logs,
    })
}

#[tauri::command]
pub fn start_bridge(
    app: tauri::AppHandle,
    mut config: BridgeConfig,
    confirmed_local_network: bool,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    if !confirmed_local_network {
        return Err(
            "Confirm that this computer is connected to the equipment network before enabling local devices"
                .to_string(),
        );
    }
    config.local_devices_enabled = true;
    config.local_devices_confirmation_version = LOCAL_DEVICE_CONFIRMATION_VERSION;
    let saved = read_config(&app)?;
    showpilot_native_credentials::reuse_key(
        &config.site,
        &config.org,
        &mut config.key,
        saved
            .as_ref()
            .map(|saved| (saved.site.as_str(), saved.org.as_str(), saved.key.as_str())),
    )?;
    let unchanged = saved.as_ref() == Some(&config);
    if unchanged {
        let running = runtime
            .process
            .lock()
            .map_err(|_| "Device engine state unavailable".to_string())?
            .as_mut()
            .map(|active| active.child.try_wait().map(|status| status.is_none()))
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if running {
            return bridge_status(app, runtime);
        }
    }
    save_config(&app, &config)?;
    let pid = replace_process(&runtime, &config, &app)?;
    Ok(BridgeStatus {
        configured: true,
        configured_site: Some(config.site.clone()),
        configured_org: Some(config.org.clone()),
        secure_credentials: true,
        local_devices_enabled: true,
        running: true,
        connection: BridgeConnection::Connecting,
        pid: Some(pid),
        logs: Vec::new(),
        last_error: None,
    })
}

#[tauri::command]
pub fn stop_bridge(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<(), String> {
    runtime.auto_restart.store(false, Ordering::Relaxed);
    if let Some(mut config) = read_config(&app)? {
        config.local_devices_enabled = false;
        save_config(&app, &config)?;
    }
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    *process = None;
    Ok(())
}

fn request_local_show(
    port: u16,
    token: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body =
        serde_json::to_vec(&request).map_err(|_| "Invalid local show request".to_string())?;
    if body.len() > 65_536 {
        return Err("Local show request is too large".into());
    }
    // The updater enables reqwest's rustls-no-provider feature. Supply this
    // client's provider explicitly, without changing the updater's global TLS
    // configuration. This client only connects to the fixed loopback HTTP URL.
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "Unable to configure local control transport".to_string())?
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    let client = reqwest::blocking::Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(1))
        .timeout(std::time::Duration::from_secs(16))
        .build()
        .map_err(|_| "Unable to initialize native local control".to_string())?;
    let response = client.post(format!("http://127.0.0.1:{port}/local-show"))
        .bearer_auth(token).header("Content-Type", "application/json").body(body).send()
        .map_err(|_| "The local device engine did not confirm the request. Refresh its status before retrying.".to_string())?;
    let mut bytes = Vec::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            "The local device engine response was interrupted. Refresh its status before retrying."
                .to_string()
        })?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Local show response exceeded its size limit".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid local device engine response".to_string())?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .filter(|message| message.len() <= 1000)
            .unwrap_or(
                "The local device engine rejected this action. Refresh its status before retrying.",
            )
            .to_string());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "Missing local show result".to_string())
}

#[tauri::command]
pub async fn local_show_command(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, BridgeRuntime>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Local show control is only available in the main operator window".into());
    }
    let (pid, port, token) = {
        let mut process = runtime
            .process
            .lock()
            .map_err(|_| "Device engine state unavailable".to_string())?;
        let active = process.as_mut().ok_or_else(|| {
            "Start the local device engine before using local show control".to_string()
        })?;
        if active
            .child
            .try_wait()
            .map_err(|_| "Unable to inspect the local device engine".to_string())?
            .is_some()
        {
            return Err(
                "The local device engine stopped. Wait for it to restart and refresh its status."
                    .into(),
            );
        }
        let port = active
            .observation
            .lock()
            .map_err(|_| "Local control status unavailable".to_string())?
            .local_control_port
            .ok_or_else(|| {
                "Local show control is still starting. Refresh its status in a moment.".to_string()
            })?;
        (active.child.id(), port, active.local_control_token.clone())
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || request_local_show(port, &token, request))
            .await
            .map_err(|_| "Native local show request did not finish".to_string())?;
    let process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    if process.as_ref().map(|active| active.child.id()) != Some(pid) {
        return Err("The local device engine restarted during this request. Refresh its saved state before retrying.".into());
    }
    result
}

pub fn start_supervisor(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(std::time::Duration::from_secs(5));
        let runtime = app.state::<BridgeRuntime>();
        if !runtime.auto_restart.load(Ordering::Relaxed) {
            continue;
        }
        let should_restart = runtime
            .process
            .lock()
            .map(|mut process| match process.as_mut() {
                Some(active) => {
                    let stopped = active
                        .child
                        .try_wait()
                        .map(|status| status.is_some())
                        .unwrap_or(false);
                    if stopped {
                        if let (Ok(logs), Ok(mut previous)) =
                            (active.observation.lock(), runtime.last_logs.lock())
                        {
                            previous.clear();
                            previous.extend(logs.logs.iter().cloned());
                        }
                        *process = None;
                    }
                    stopped
                }
                // bridge_status may already have reaped and cleared a dead child.
                None => true,
            })
            .unwrap_or(false);
        if !should_restart {
            continue;
        }
        if let Ok(Some(config)) = read_config(&app) {
            let _ = replace_process(&runtime, &config, &app);
        }
    });
}

pub fn start_saved_bridge(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(config) = read_config(app)? else {
        return Ok(());
    };
    // Venue Bridge mode is the safe default. Automatically starting an
    // embedded Bridge on every operator's Desktop would evict the one active
    // venue agent from the organization's relay.
    if !has_confirmed_local_device_ownership(&config) {
        return Ok(());
    }
    let runtime = app.state::<BridgeRuntime>();
    replace_process(&runtime, &config, app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_control_port_is_private_and_validated() {
        let mut observation = BridgeObservation::new();
        observation.push("[bridge-local-control] 12345".into());
        assert_eq!(observation.local_control_port, Some(12345));
        assert!(observation.logs.is_empty());
        for malformed in ["0", "65536", "123 bad", "-1"] {
            observation.push(format!("[bridge-local-control] {malformed}"));
            assert_eq!(observation.local_control_port, None);
        }
    }

    #[test]
    fn only_one_engine_can_own_a_local_show_directory() {
        let directory =
            std::env::temp_dir().join(format!("showpilot-local-lock-{}", uuid::Uuid::new_v4()));
        let owner = lock_local_show_directory(&directory).unwrap();
        assert!(lock_local_show_directory(&directory).is_err());
        drop(owner);
        let replacement = lock_local_show_directory(&directory).unwrap();
        drop(replacement);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_local_control_authenticates_and_preserves_operator_errors() {
        use std::io::Write;
        use std::net::TcpListener;
        for (status, body, expected) in [
            (
                200,
                r#"{"ok":true,"result":{"mode":"prepared","sequence":0}}"#,
                Ok(serde_json::json!({"mode":"prepared","sequence":0})),
            ),
            (
                409,
                r#"{"ok":false,"error":"Local show changed. Refresh its state."}"#,
                Err("Local show changed. Refresh its state.".to_string()),
            ),
        ] {
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = server.local_addr().unwrap().port();
            let receiver = thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let headers = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                assert!(headers.starts_with("post /local-show http/1.1"));
                assert!(headers.contains("authorization: bearer fixture-native-token\r\n"));
                write!(socket,"HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            assert_eq!(
                request_local_show(
                    port,
                    "fixture-native-token",
                    serde_json::json!({"operation":"status"})
                ),
                expected
            );
            receiver.join().unwrap();
        }
        assert!(request_local_show(
            1,
            "fixture-native-token",
            serde_json::json!({"padding":"x".repeat(65536)})
        )
        .unwrap_err()
        .contains("too large"));
    }

    fn config(site: &str, org: &str, key: &str) -> BridgeConfig {
        BridgeConfig {
            site: site.into(),
            org: org.into(),
            key: key.into(),
            local_devices_enabled: false,
            local_devices_confirmation_version: 0,
            propresenter_host: None,
            propresenter_port: None,
            propresenter_api_port: None,
            propresenter_password: None,
        }
    }

    #[test]
    fn accepts_production_and_explicit_local_sites() {
        assert!(validate_config(&config(
            "https://showpilot.tech",
            "faithfire-production",
            "sp_test"
        ))
        .is_ok());
        assert!(validate_config(&config("http://localhost:3001", "test-peeps", "sp_test")).is_ok());
    }

    #[test]
    fn rejects_untrusted_sites_slugs_and_keys() {
        assert!(validate_config(&config("http://showpilot.tech", "faithfire", "sp_test")).is_err());
        assert!(
            validate_config(&config("https://showpilot.tech", "../faithfire", "sp_test")).is_err()
        );
        assert!(validate_config(&config("https://showpilot.tech", "faithfire", "wrong")).is_err());
    }

    #[test]
    fn requires_the_current_explicit_local_device_confirmation() {
        let mut bridge = config("https://showpilot.tech", "faithfire-production", "sp_test");
        bridge.local_devices_enabled = true;
        assert!(!has_confirmed_local_device_ownership(&bridge));

        bridge.local_devices_confirmation_version = LOCAL_DEVICE_CONFIRMATION_VERSION;
        assert!(has_confirmed_local_device_ownership(&bridge));
    }

    #[test]
    fn derives_cloud_connection_from_the_latest_bridge_log() {
        let connected = vec![
            "[bridge] Connecting to ShowPilot".to_string(),
            "[bridge] Connected to ShowPilot".to_string(),
        ];
        assert_eq!(
            connection_from_logs(&connected),
            BridgeConnection::Connected
        );

        let disconnected = vec![
            "[bridge] Connected to ShowPilot".to_string(),
            "[bridge] Disconnected (code 1006)".to_string(),
        ];
        assert_eq!(
            connection_from_logs(&disconnected),
            BridgeConnection::Disconnected
        );
    }

    #[test]
    fn keeps_authentication_and_transport_failures_distinct() {
        let unauthorized = vec![
            "[bridge] Connecting to ShowPilot".to_string(),
            "[bridge] Authentication failed (HTTP 401)".to_string(),
            "[bridge] Disconnected (code 1006)".to_string(),
        ];
        assert_eq!(
            connection_from_logs(&unauthorized),
            BridgeConnection::Unauthorized
        );

        let error = vec!["[bridge] WebSocket error: DNS lookup failed".to_string()];
        assert_eq!(connection_from_logs(&error), BridgeConnection::Error);
    }

    #[test]
    fn ignores_local_device_logs_when_deriving_cloud_connection() {
        let logs = vec![
            "[bridge] Connected to ShowPilot".to_string(),
            "[pp-bridge] Connecting to ws://192.168.2.48:50001/stagedisplay".to_string(),
            "[pp-bridge] Disconnected from ProPresenter".to_string(),
        ];
        assert_eq!(connection_from_logs(&logs), BridgeConnection::Connected);
        assert_eq!(last_error_from_logs(&logs), None);
    }

    #[test]
    fn keeps_connection_state_after_the_connection_log_rolls_out() {
        let observation = Arc::new(Mutex::new(BridgeObservation::new()));
        append_log(&observation, "[bridge] Connected to ShowPilot".to_string());
        for index in 0..2_000 {
            append_log(&observation, format!("[pp-bridge] Forwarded slide {index}"));
        }

        let observation = observation.lock().expect("observation lock");
        assert_eq!(observation.logs.len(), MAX_LOG_LINES);
        assert!(!observation
            .logs
            .iter()
            .any(|line| line.contains("Connected to ShowPilot")));
        assert_eq!(observation.connection, BridgeConnection::Connected);
    }

    #[test]
    fn preserves_a_crash_reason_for_the_desktop_status_bar() {
        let logs = vec![
            "stack frame".to_string(),
            "error: native addon could not load".to_string(),
            "Bun v1.4.0".to_string(),
        ];
        assert_eq!(
            last_error_from_logs(&logs).as_deref(),
            Some("error: native addon could not load")
        );
    }
}
