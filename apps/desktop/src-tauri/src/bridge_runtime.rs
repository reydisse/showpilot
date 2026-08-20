use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Manager;

const MAX_LOG_LINES: usize = 80;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    site: String,
    org: String,
    key: String,
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
    logs: Arc<Mutex<VecDeque<String>>>,
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
    running: bool,
    pid: Option<u32>,
    logs: Vec<String>,
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

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("desktop-bridge-config.json"))
}

fn read_config(app: &tauri::AppHandle) -> Result<Option<BridgeConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let payload = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config: BridgeConfig = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    validate_config(&config)?;
    Ok(Some(config))
}

fn save_config(app: &tauri::AppHandle, config: &BridgeConfig) -> Result<(), String> {
    validate_config(config)?;
    let path = config_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&payload)
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn append_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut entries) = logs.lock() {
        entries.push_back(line);
        while entries.len() > MAX_LOG_LINES {
            entries.pop_front();
        }
    }
}

fn capture_output<R: Read + Send + 'static>(reader: R, logs: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => append_log(&logs, line),
                Err(error) => {
                    append_log(&logs, format!("Device engine output error: {error}"));
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
        .env("SHOWPILOT_BRIDGE_KEY", config.key.trim());
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

fn spawn_process(config: &BridgeConfig) -> Result<BridgeProcess, String> {
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    let mut command = bridge_command(config)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start the local device engine: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        capture_output(stdout, Arc::clone(&logs));
    }
    if let Some(stderr) = child.stderr.take() {
        capture_output(stderr, Arc::clone(&logs));
    }
    Ok(BridgeProcess { child, logs })
}

fn replace_process(runtime: &BridgeRuntime, config: &BridgeConfig) -> Result<u32, String> {
    let active = spawn_process(config)?;
    let pid = active.child.id();
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    *process = Some(active);
    runtime.auto_restart.store(true, Ordering::Relaxed);
    Ok(pid)
}

#[tauri::command]
pub fn bridge_status(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    let configured = read_config(&app)?.is_some();
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    let mut running = false;
    let mut pid = None;
    let mut logs = Vec::new();

    if let Some(active) = process.as_mut() {
        running = active
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none();
        if running {
            pid = Some(active.child.id());
        }
        logs = active
            .logs
            .lock()
            .map_err(|_| "Device engine logs unavailable".to_string())?
            .iter()
            .cloned()
            .collect();
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

    Ok(BridgeStatus {
        configured,
        running,
        pid,
        logs,
    })
}

#[tauri::command]
pub fn start_bridge(
    app: tauri::AppHandle,
    config: BridgeConfig,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    let unchanged = read_config(&app)?.as_ref() == Some(&config);
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
    let pid = replace_process(&runtime, &config)?;
    Ok(BridgeStatus {
        configured: true,
        running: true,
        pid: Some(pid),
        logs: Vec::new(),
    })
}

#[tauri::command]
pub fn stop_bridge(runtime: tauri::State<'_, BridgeRuntime>) -> Result<(), String> {
    runtime.auto_restart.store(false, Ordering::Relaxed);
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Device engine state unavailable".to_string())?;
    *process = None;
    Ok(())
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
                Some(active) => active
                    .child
                    .try_wait()
                    .map(|status| status.is_some())
                    .unwrap_or(false),
                // bridge_status may already have reaped and cleared a dead child.
                None => true,
            })
            .unwrap_or(false);
        if !should_restart {
            continue;
        }
        if let Ok(Some(config)) = read_config(&app) {
            let _ = replace_process(&runtime, &config);
        }
    });
}

pub fn start_saved_bridge(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(config) = read_config(app)? else {
        return Ok(());
    };
    let runtime = app.state::<BridgeRuntime>();
    replace_process(&runtime, &config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(site: &str, org: &str, key: &str) -> BridgeConfig {
        BridgeConfig {
            site: site.into(),
            org: org.into(),
            key: key.into(),
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
}
