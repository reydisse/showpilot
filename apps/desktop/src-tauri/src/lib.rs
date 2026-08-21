use serde::Serialize;
use std::fs;
use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

mod bridge_runtime;
use bridge_runtime::{
    bridge_status, start_bridge, start_saved_bridge, start_supervisor, stop_bridge, BridgeRuntime,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    native: bool,
    platform: String,
    version: String,
    cache_path: Option<String>,
}

const MAX_SNAPSHOT_BYTES: usize = 5 * 1024 * 1024;
const PRODUCTION_ORIGIN: &str = "https://showpilot.tech";
const NOTIFICATION_POLL_SCRIPT: &str =
    "window.dispatchEvent(new Event('showpilot-desktop-notification-poll'))";

struct CompanionWindowSpec {
    label: String,
    title: &'static str,
    path: String,
    always_on_top: bool,
}

fn validate_snapshot(payload: &str) -> Result<(), String> {
    if payload.len() > MAX_SNAPSHOT_BYTES {
        return Err("Service snapshot exceeds the 5 MB desktop limit".to_string());
    }
    serde_json::from_str::<serde_json::Value>(payload)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn companion_window_spec(org_slug: &str, kind: &str) -> Result<CompanionWindowSpec, String> {
    let valid_slug = !org_slug.is_empty()
        && org_slug.len() <= 64
        && org_slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid_slug {
        return Err("Invalid organization slug".to_string());
    }

    let (label_prefix, title, path, always_on_top) = match kind {
        "timer" => (
            "timer",
            "ShowPilot Timer",
            format!("/timer/{org_slug}"),
            true,
        ),
        "show-board" => (
            "show-board",
            "ShowPilot Show Board",
            format!("/{org_slug}/board"),
            true,
        ),
        "check-in" => (
            "check-in",
            "ShowPilot Check-in",
            format!("/{org_slug}/checkin"),
            false,
        ),
        _ => return Err("Unknown desktop window type".to_string()),
    };

    Ok(CompanionWindowSpec {
        label: format!("{label_prefix}-{org_slug}"),
        title,
        path,
        always_on_top,
    })
}

fn validated_local_origin(origin: &str) -> Option<String> {
    let origin = origin.trim().trim_end_matches('/');
    let port = origin
        .strip_prefix("http://localhost:")
        .or_else(|| origin.strip_prefix("http://127.0.0.1:"))?;
    port.parse::<u16>().ok()?;
    Some(origin.to_string())
}

fn companion_origin() -> String {
    if cfg!(debug_assertions) {
        return std::env::var("SHOWPILOT_DESKTOP_WEB_URL")
            .ok()
            .and_then(|origin| validated_local_origin(&origin))
            .unwrap_or_else(|| "http://localhost:3001".to_string());
    }
    PRODUCTION_ORIGIN.to_string()
}

fn is_display_surface(label: &str, path: &str) -> bool {
    if label.starts_with("timer-") || label.starts_with("show-board-") {
        return true;
    }

    if path.starts_with("/timer/") {
        return true;
    }

    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    segments.len() == 2 && segments[1] == "board"
}

fn ensure_display_surface(window: &tauri::WebviewWindow) -> Result<(), String> {
    let path = window
        .url()
        .map_err(|error| error.to_string())?
        .path()
        .to_string();
    if is_display_surface(window.label(), &path) {
        return Ok(());
    }
    Err("Fullscreen is available only on ShowPilot display windows".to_string())
}

fn service_cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("active-service.json"))
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
fn cache_service(app: tauri::AppHandle, payload: String) -> Result<String, String> {
    validate_snapshot(&payload)?;
    let path = service_cache_path(&app)?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temp_path = path.with_extension(format!("json.{suffix}.tmp"));
    let mut file = fs::File::create(&temp_path).map_err(|error| error.to_string())?;
    file.write_all(payload.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temp_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })?;
    Ok(format!("Cached locally · {}", path.display()))
}

#[tauri::command]
fn get_cached_service(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = service_cache_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_companion_window(
    app: tauri::AppHandle,
    org_slug: String,
    kind: String,
) -> Result<(), String> {
    let spec = companion_window_spec(&org_slug, &kind)?;
    if let Some(window) = app.get_webview_window(&spec.label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let url = format!("{}{}", companion_origin(), spec.path)
        .parse()
        .map_err(|error| format!("Invalid ShowPilot URL: {error}"))?;
    tauri::WebviewWindowBuilder::new(&app, spec.label, tauri::WebviewUrl::External(url))
        .title(spec.title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(760.0, 520.0)
        .resizable(true)
        .always_on_top(spec.always_on_top)
        .build()
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "ShowPilot main window is unavailable".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn start_notification_pulse(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(NOTIFICATION_POLL_SCRIPT);
        }
    });
}

#[tauri::command]
fn display_fullscreen_state(window: tauri::WebviewWindow) -> Result<bool, String> {
    ensure_display_surface(&window)?;
    window.is_fullscreen().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_display_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    ensure_display_surface(&window)?;
    let next = !window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(next)
        .map_err(|error| error.to_string())?;
    Ok(next)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(BridgeRuntime::new())
        .setup(|app| {
            let open = MenuItem::with_id(app, "showpilot-open", "Open ShowPilot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "showpilot-quit", "Quit ShowPilot", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ShowPilot")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "showpilot-open" => {
                        let _ = show_main_window(app.clone());
                    }
                    "showpilot-quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            start_saved_bridge(app.handle())?;
            start_supervisor(app.handle().clone());
            start_notification_pulse(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            cache_service,
            get_cached_service,
            open_companion_window,
            display_fullscreen_state,
            toggle_display_fullscreen,
            bridge_status,
            start_bridge,
            stop_bridge
        ])
        .build(tauri::generate_context!())
        .expect("error while building ShowPilot Desktop");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            let _ = show_main_window(app.clone());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_json_snapshots() {
        assert!(validate_snapshot(r#"{"version":1,"items":[]}"#).is_ok());
    }

    #[test]
    fn rejects_invalid_or_oversized_snapshots() {
        assert!(validate_snapshot("not-json").is_err());
        assert!(validate_snapshot(&"x".repeat(MAX_SNAPSHOT_BYTES + 1)).is_err());
    }

    #[test]
    fn builds_only_known_companion_routes() {
        let timer = companion_window_spec("faithfire-production", "timer").unwrap();
        assert_eq!(timer.label, "timer-faithfire-production");
        assert_eq!(timer.path, "/timer/faithfire-production");
        assert!(timer.always_on_top);

        let check_in = companion_window_spec("faithfire-production", "check-in").unwrap();
        assert_eq!(check_in.path, "/faithfire-production/checkin");
        assert!(!check_in.always_on_top);

        assert!(companion_window_spec("faithfire-production", "unknown").is_err());
    }

    #[test]
    fn rejects_untrusted_organization_slugs() {
        for slug in ["", "../admin", "org/name", "org?redirect=evil"] {
            assert!(companion_window_spec(slug, "timer").is_err());
        }
        assert!(companion_window_spec(&"a".repeat(65), "timer").is_err());
    }

    #[test]
    fn accepts_only_explicit_local_development_origins() {
        assert_eq!(
            validated_local_origin("http://localhost:3001/"),
            Some("http://localhost:3001".to_string())
        );
        assert_eq!(
            validated_local_origin("http://127.0.0.1:5173"),
            Some("http://127.0.0.1:5173".to_string())
        );
        for origin in [
            "https://showpilot.tech",
            "http://localhost.evil:3001",
            "http://localhost:3001/path",
            "file:///tmp/showpilot",
        ] {
            assert!(validated_local_origin(origin).is_none());
        }
    }

    #[test]
    fn limits_native_fullscreen_to_display_surfaces() {
        assert!(is_display_surface("timer-faithfire", "/loading"));
        assert!(is_display_surface("show-board-faithfire", "/loading"));
        assert!(is_display_surface("main", "/timer/faithfire"));
        assert!(is_display_surface("main", "/faithfire/board"));
        assert!(!is_display_surface("main", "/faithfire/show"));
        assert!(!is_display_surface(
            "check-in-faithfire",
            "/faithfire/checkin"
        ));
        assert!(!is_display_surface("main", "/faithfire/board/settings"));
    }
}
