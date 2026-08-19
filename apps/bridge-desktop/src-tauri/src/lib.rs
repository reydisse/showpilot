use serde::Deserialize;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    native: bool,
    platform: String,
    version: String,
    cache_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfig {
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

struct BridgeRuntime {
    process: Mutex<Option<BridgeProcess>>,
    auto_restart: AtomicBool,
    last_logs: Mutex<VecDeque<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    configured: bool,
    running: bool,
    pid: Option<u32>,
    logs: Vec<String>,
}

fn bridge_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("bridge-config.json"))
}

fn read_bridge_config(app: &tauri::AppHandle) -> Result<Option<BridgeConfig>, String> {
    let path = bridge_config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let payload = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn append_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut entries) = logs.lock() {
        entries.push_back(line);
        while entries.len() > 80 {
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
                    append_log(&logs, format!("Bridge output error: {error}"));
                    break;
                }
            }
        }
    });
}

fn bridge_command(app: &tauri::AppHandle, config: &BridgeConfig) -> Result<Command, String> {
    // Production installers can ship a compiled `showpilot-bridge` sidecar.
    // Development falls back to the TypeScript bridge with the local Node runtime.
    let resource_binary = app.path().resource_dir().ok().and_then(|path| {
        [
            path.join("binaries/showpilot-bridge"),
            path.join("binaries/showpilot-bridge.exe"),
            path.join("showpilot-bridge"),
            path.join("showpilot-bridge.exe"),
        ]
        .into_iter()
        .find(|candidate| candidate.exists())
    });

    if config.site.trim().is_empty() || config.org.trim().is_empty() || config.key.trim().is_empty()
    {
        return Err("Site, organization, and bridge key are required".to_string());
    }

    // Both the packaged sidecar and the development Node process need the
    // same configuration. Keep this setup after command selection so a
    // packaged install does not start briefly and then exit in configure mode.
    let mut command = if let Some(path) = resource_binary.filter(|path| path.exists()) {
        let mut command = Command::new(path);
        command.args(["--no-open", "--desktop"]);
        command
    } else {
        let bridge_script = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join("../bridge/dist/index.js");
        if !bridge_script.exists() {
            return Err("ShowPilot Bridge is not installed with this desktop build".to_string());
        }

        let mut command = Command::new("node");
        command.arg(&bridge_script).args(["--no-open", "--desktop"]);
        command.current_dir(
            bridge_script
                .parent()
                .ok_or_else(|| "Invalid bridge installation path".to_string())?,
        );
        command
    };

    // The compiled Bun sidecar is a console executable on Windows. Keep it
    // attached to the desktop supervisor without opening a second terminal
    // window for operators.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    command
        .env("SHOWPILOT_SITE_URL", config.site.trim())
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

#[tauri::command]
fn engine_info(app: tauri::AppHandle) -> EngineInfo {
    let cache_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|path| path.display().to_string());
    EngineInfo {
        native: true,
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        cache_path,
    }
}

#[tauri::command]
fn get_bridge_config(app: tauri::AppHandle) -> Result<Option<BridgeConfig>, String> {
    read_bridge_config(&app)
}

#[tauri::command]
fn save_bridge_config(app: tauri::AppHandle, config: BridgeConfig) -> Result<(), String> {
    if config.site.trim().is_empty() || config.org.trim().is_empty() || config.key.trim().is_empty()
    {
        return Err("Site, organization, and bridge key are required".to_string());
    }
    let path = bridge_config_path(&app)?;
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new();
    file.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    let mut handle = file.open(&temporary).map_err(|error| error.to_string())?;
    handle
        .write_all(&payload)
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn spawn_bridge_process(
    app: &tauri::AppHandle,
    config: &BridgeConfig,
) -> Result<BridgeProcess, String> {
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    let mut command = bridge_command(app, config)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start bridge: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        capture_output(stdout, Arc::clone(&logs));
    }
    if let Some(stderr) = child.stderr.take() {
        capture_output(stderr, Arc::clone(&logs));
    }
    Ok(BridgeProcess { child, logs })
}

fn restart_configured_bridge(
    app: &tauri::AppHandle,
    runtime: &BridgeRuntime,
) -> Result<(), String> {
    let config = read_bridge_config(app)?
        .ok_or_else(|| "Configure the bridge before starting it".to_string())?;
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Bridge state unavailable".to_string())?;
    if let Some(mut active) = process.take() {
        let _ = active.child.kill();
        let _ = active.child.wait();
    }
    let active = spawn_bridge_process(app, &config)?;
    *process = Some(active);
    runtime.auto_restart.store(true, Ordering::Relaxed);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    let configured = read_bridge_config(&app)?.is_some();
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Bridge state unavailable".to_string())?;
    let mut running = false;
    let mut pid = None;
    let mut logs = Vec::new();

    if let Some(active) = process.as_mut() {
        match active.child.try_wait() {
            Ok(None) => {
                running = true;
                pid = Some(active.child.id());
            }
            Ok(Some(status)) => {
                append_log(&active.logs, format!("Bridge stopped ({status})"));
            }
            Err(error) => append_log(&active.logs, format!("Bridge status error: {error}")),
        }
        if let Some(active) = process.as_ref() {
            logs = active
                .logs
                .lock()
                .map_err(|_| "Bridge logs unavailable".to_string())?
                .iter()
                .cloned()
                .collect();
        }
        if !running {
            if let Ok(mut previous_logs) = runtime.last_logs.lock() {
                previous_logs.clear();
                previous_logs.extend(logs.iter().cloned());
            }
            *process = None;
        }
    }

    if logs.is_empty() {
        logs = runtime
            .last_logs
            .lock()
            .map_err(|_| "Bridge logs unavailable".to_string())?
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
fn start_bridge(
    app: tauri::AppHandle,
    config: BridgeConfig,
    runtime: tauri::State<'_, BridgeRuntime>,
) -> Result<BridgeStatus, String> {
    save_bridge_config(app.clone(), config.clone())?;
    runtime.auto_restart.store(true, Ordering::Relaxed);
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Bridge state unavailable".to_string())?;
    if let Some(mut active) = process.take() {
        let _ = active.child.kill();
        let _ = active.child.wait();
    }

    let active = spawn_bridge_process(&app, &config)?;
    let pid = active.child.id();
    let current_logs = active
        .logs
        .lock()
        .map_err(|_| "Bridge logs unavailable".to_string())?
        .iter()
        .cloned()
        .collect();
    *process = Some(active);
    Ok(BridgeStatus {
        configured: true,
        running: true,
        pid: Some(pid),
        logs: current_logs,
    })
}

#[tauri::command]
fn stop_bridge(runtime: tauri::State<'_, BridgeRuntime>) -> Result<(), String> {
    runtime.auto_restart.store(false, Ordering::Relaxed);
    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Bridge state unavailable".to_string())?;
    if let Some(mut active) = process.take() {
        let _ = active.child.kill();
        let _ = active.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn cache_service(app: tauri::AppHandle, payload: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&payload).map_err(|error| error.to_string())?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("active-service.json");
    fs::write(&path, payload).map_err(|error| error.to_string())?;
    Ok(format!("Cached locally · {}", path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("ShowPilot Bridge")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BridgeRuntime {
            process: Mutex::new(None),
            auto_restart: AtomicBool::new(false),
            last_logs: Mutex::new(VecDeque::new()),
        })
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open ShowPilot Bridge", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart bridge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit ShowPilot Bridge", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::new(app)?;
            menu.append(&open)?;
            menu.append(&restart)?;
            menu.append(&separator)?;
            menu.append(&quit)?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ShowPilot Bridge")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "restart" => {
                        let runtime = app.state::<BridgeRuntime>();
                        if let Err(error) = restart_configured_bridge(app, &runtime) {
                            eprintln!("[bridge] Tray restart failed: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window.hide();
                    }
                });
            }

            if let Ok(Some(config)) = read_bridge_config(app.handle()) {
                let runtime = app.state::<BridgeRuntime>();
                match spawn_bridge_process(app.handle(), &config) {
                    Ok(active) => {
                        runtime.auto_restart.store(true, Ordering::Relaxed);
                        if let Ok(mut process) = runtime.process.lock() {
                            *process = Some(active);
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    Err(error) => eprintln!("[desktop] Unable to restore bridge: {error}"),
                }
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(std::time::Duration::from_secs(5));
                let runtime = app_handle.state::<BridgeRuntime>();
                let should_restart = runtime.auto_restart.load(Ordering::Relaxed);
                let mut process = match runtime.process.lock() {
                    Ok(process) => process,
                    Err(_) => continue,
                };
                let exited = process
                    .as_mut()
                    .and_then(|active| active.child.try_wait().ok())
                    .is_some();
                if !exited || !should_restart {
                    continue;
                }
                *process = None;
                drop(process);
                if let Ok(Some(config)) = read_bridge_config(&app_handle) {
                    match spawn_bridge_process(&app_handle, &config) {
                        Ok(active) => {
                            if let Ok(mut process) = runtime.process.lock() {
                                *process = Some(active);
                            }
                        }
                        Err(error) => eprintln!("[desktop] Bridge restart failed: {error}"),
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            cache_service,
            get_bridge_config,
            save_bridge_config,
            bridge_status,
            start_bridge,
            stop_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running ShowPilot Desktop");
}
