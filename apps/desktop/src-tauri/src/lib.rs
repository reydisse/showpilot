use serde::Serialize;
use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    native: bool,
    platform: String,
    version: String,
    cache_path: Option<String>,
}

const MAX_SNAPSHOT_BYTES: usize = 5 * 1024 * 1024;

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

    let url = format!("https://showpilot.tech{}", spec.path)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            engine_info,
            cache_service,
            get_cached_service,
            open_companion_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running ShowPilot Desktop");
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
}
