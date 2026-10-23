//! Local output assignments belong to this computer, never the organization DB.
//! NDI can later share the clean output source, with its own start/stop adapter.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OutputTarget {
    Monitor { id: String },
    Decklink { id: String, mode: u32 },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveOutput {
    org_slug: String,
    label: String,
    target: OutputTarget,
    ready: bool,
}
#[derive(Default)]
pub struct OutputRuntime {
    active: Mutex<Option<ActiveOutput>>,
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};
    extern "C" {
        fn sp_decklink_inventory() -> *mut c_char;
        fn sp_decklink_status() -> *mut c_char;
        fn sp_decklink_start(key: *const c_char, mode: u32, window: *mut c_void);
        fn sp_decklink_stop();
        fn sp_decklink_free(value: *mut c_char);
    }
    unsafe fn read(value: *mut c_char) -> Result<Value, String> {
        if value.is_null() {
            return Err("Native video engine did not respond".into());
        }
        let result =
            serde_json::from_slice(CStr::from_ptr(value).to_bytes()).map_err(|e| e.to_string());
        sp_decklink_free(value);
        result
    }
    pub fn inventory() -> Result<Value, String> {
        unsafe { read(sp_decklink_inventory()) }
    }
    pub fn status() -> Result<Value, String> {
        unsafe { read(sp_decklink_status()) }
    }
    pub fn stop() {
        unsafe { sp_decklink_stop() }
    }
    pub fn start(id: &str, mode: u32, window: &tauri::WebviewWindow) -> Result<(), String> {
        let key = CString::new(id).map_err(|_| "Invalid device identifier")?;
        let pointer = window.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            sp_decklink_start(key.as_ptr(), mode, pointer);
        }
        Ok(())
    }
}
#[cfg(not(target_os = "macos"))]
mod native {
    use super::*;
    pub fn inventory() -> Result<Value, String> {
        Ok(json!({"devices":[],"error":"DeckLink output is available in ShowPilot for macOS."}))
    }
    pub fn status() -> Result<Value, String> {
        Ok(json!({"state":"stopped","message":"Output disabled"}))
    }
    pub fn stop() {}
    pub fn start(_: &str, _: u32, _: &tauri::WebviewWindow) -> Result<(), String> {
        Err("DeckLink output requires macOS".into())
    }
}

fn require_operator(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Configure outputs from the main ShowPilot window".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    let trusted = url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("app.showpilot.tech" | "showpilot.tech")
        );
    let local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if !trusted && !local {
        return Err("Open your ShowPilot workspace to configure outputs".into());
    }
    Ok(())
}
fn monitor_id(monitor: &tauri::Monitor) -> String {
    format!(
        "{}:{}:{}",
        monitor.name().map(String::as_str).unwrap_or("Display"),
        monitor.position().x,
        monitor.position().y
    )
}

#[tauri::command]
pub async fn confidence_outputs(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
) -> Result<Value, String> {
    require_operator(&window)?;
    let monitors: Vec<_> = app.available_monitors().map_err(|e| e.to_string())?.iter().map(|m| json!({
        "id": monitor_id(m), "name": m.name(), "width": m.size().width, "height": m.size().height,
    })).collect();
    let active = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?
        .clone();
    Ok(json!({"monitors": monitors, "decklink": native::inventory()?, "active": active}))
}

#[tauri::command]
pub async fn confidence_output_status(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
) -> Result<Value, String> {
    require_operator(&window)?;
    let active = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?
        .clone();
    if let Some(selected) = &active {
        let missing_window = window
            .app_handle()
            .get_webview_window(&selected.label)
            .is_none();
        let missing_monitor = if let OutputTarget::Monitor { id } = &selected.target {
            !window
                .available_monitors()
                .map_err(|e| e.to_string())?
                .iter()
                .any(|m| monitor_id(m) == *id)
        } else {
            false
        };
        if missing_window || missing_monitor {
            let mut guard = runtime
                .active
                .lock()
                .map_err(|_| "Output state unavailable")?;
            if guard
                .as_ref()
                .is_some_and(|current| current.label == selected.label)
            {
                native::stop();
                *guard = None;
                if let Some(output) = window.app_handle().get_webview_window(&selected.label) {
                    let _ = output.close();
                }
            }
            return Ok(
                json!({"state":"stopped","message":if missing_monitor { "The assigned display was disconnected." } else { "The output window was closed." }}),
            );
        }
    }
    match active {
        None => Ok(json!({"state":"stopped","message":"Output disabled"})),
        Some(active) if !active.ready => Ok(
            json!({"state":"starting","message":"Loading the confidence screen…","orgSlug":active.org_slug}),
        ),
        Some(active) => match active.target {
            OutputTarget::Monitor { .. } => Ok(
                json!({"state":"running","message":"Display output enabled","orgSlug":active.org_slug}),
            ),
            OutputTarget::Decklink { .. } => {
                let mut status = native::status()?;
                status["orgSlug"] = json!(active.org_slug);
                Ok(status)
            }
        },
    }
}

#[tauri::command]
pub async fn identify_confidence_monitor(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    require_operator(&window)?;
    let monitor = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| monitor_id(m) == id)
        .ok_or("This display is no longer connected")?;
    let label = format!(
        "identify-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let output = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App("identify-output.html".into()),
    )
    .title("Identify ShowPilot display")
    .decorations(false)
    .focused(false)
    .position(
        monitor.position().x as f64 / monitor.scale_factor(),
        monitor.position().y as f64 / monitor.scale_factor(),
    )
    .inner_size(
        monitor.size().width as f64 / monitor.scale_factor(),
        monitor.size().height as f64 / monitor.scale_factor(),
    )
    .fullscreen(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let _ = output.close();
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_confidence_output(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
) -> Result<(), String> {
    require_operator(&window)?;
    let mut guard = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?;
    native::stop();
    if let Some(active) = guard.take() {
        if let Some(output) = app.get_webview_window(&active.label) {
            output.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_confidence_output(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
    org_slug: String,
    target: OutputTarget,
) -> Result<(), String> {
    require_operator(&window)?;
    super::companion_window_spec(&org_slug, "timer")?;
    let mut guard = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?;
    if guard.is_some() {
        return Err("Disable the current output before changing its assignment".into());
    }
    let mut dimensions = (1280.0, 720.0);
    let mut video_size: Option<tauri::PhysicalSize<u32>> = None;
    let monitor = match &target {
        OutputTarget::Monitor { id } => Some(
            app.available_monitors()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| monitor_id(m) == *id)
                .ok_or("This display is no longer connected")?,
        ),
        OutputTarget::Decklink { id, mode } => {
            let inventory = native::inventory()?;
            let found = inventory
                .get("devices")
                .and_then(Value::as_array)
                .and_then(|devices| {
                    devices
                        .iter()
                        .find(|d| d.get("id").and_then(Value::as_str) == Some(id))
                })
                .and_then(|device| device.get("modes"))
                .and_then(Value::as_array)
                .and_then(|modes| {
                    modes
                        .iter()
                        .find(|m| m.get("id").and_then(Value::as_u64) == Some(*mode as u64))
                })
                .ok_or("This DeckLink format is no longer available. Refresh outputs.")?;
            let width = found
                .get("width")
                .and_then(Value::as_f64)
                .ok_or("Invalid video width")?;
            let height = found
                .get("height")
                .and_then(Value::as_f64)
                .ok_or("Invalid video height")?;
            let scale = app
                .primary_monitor()
                .map_err(|e| e.to_string())?
                .map(|m| m.scale_factor())
                .unwrap_or(1.0);
            dimensions = (width / scale, height / scale);
            video_size = Some(tauri::PhysicalSize::new(width as u32, height as u32));
            None
        }
    };
    let label = format!(
        "confidence-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let url: tauri::Url = format!(
        "{}/timer/{org_slug}?output=clean",
        super::companion_origin()
    )
    .parse()
    .map_err(|_| "Invalid confidence URL")?;
    let allowed = url.clone();
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
            .title("ShowPilot Confidence Output")
            .inner_size(dimensions.0, dimensions.1)
            .decorations(false)
            .resizable(false)
            .focused(false)
            .background_color(tauri::window::Color(9, 10, 11, 255))
            .on_navigation(move |next| {
                next.origin() == allowed.origin()
                    && next.path() == allowed.path()
                    && next.query() == allowed.query()
            });
    if let Some(monitor) = &monitor {
        let factor = monitor.scale_factor();
        builder = builder
            .position(
                monitor.position().x as f64 / factor,
                monitor.position().y as f64 / factor,
            )
            .inner_size(
                monitor.size().width as f64 / factor,
                monitor.size().height as f64 / factor,
            )
            .fullscreen(true);
    }
    let output = builder.build().map_err(|e| e.to_string())?;
    if let Some(size) = video_size {
        if let Err(error) = output.set_size(size) {
            let _ = output.close();
            return Err(error.to_string());
        }
    }
    *guard = Some(ActiveOutput {
        org_slug,
        label: label.clone(),
        target,
        ready: false,
    });
    // A failed page load must not leave a misleading permanent "starting" state.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let state = handle.state::<OutputRuntime>();
        let Ok(mut guard) = state.active.lock() else {
            return;
        };
        if guard
            .as_ref()
            .is_some_and(|active| active.label == label && !active.ready)
        {
            *guard = None;
            let _ = output.close();
        }
    });
    Ok(())
}

/// Called by the clean public display only after its show data is available.
#[tauri::command]
pub async fn confidence_output_ready(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
) -> Result<(), String> {
    let mut guard = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?;
    let active = guard.as_mut().ok_or("No output is assigned")?;
    if active.label != window.label() {
        return Err("This is not the assigned output window".into());
    }
    if active.ready {
        return Ok(());
    }
    if let OutputTarget::Decklink { id, mode } = &active.target {
        native::start(id, *mode, &window)?;
    }
    active.ready = true;
    Ok(())
}

#[tauri::command]
pub async fn close_confidence_output_window(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, OutputRuntime>,
) -> Result<(), String> {
    let mut guard = runtime
        .active
        .lock()
        .map_err(|_| "Output state unavailable")?;
    if !guard
        .as_ref()
        .is_some_and(|active| active.label == window.label())
    {
        return Err("This is not the assigned output window".into());
    }
    native::stop();
    *guard = None;
    window.close().map_err(|e| e.to_string())
}

pub fn window_closed(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<OutputRuntime>();
    // Start/stop already owns cleanup when its own close emits this event.
    if let Ok(mut guard) = state.active.try_lock() {
        if guard.as_ref().is_some_and(|active| active.label == label) {
            *guard = None;
            native::stop();
        }
    };
}
pub fn shutdown() {
    native::stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets_require_a_channel_and_real_mode() {
        assert!(
            serde_json::from_value::<OutputTarget>(json!({"kind":"decklink","id":"1:0"})).is_err()
        );
        assert!(serde_json::from_value::<OutputTarget>(
            json!({"kind":"decklink","id":"1:0","mode":-1})
        )
        .is_err());
        assert!(
            serde_json::from_value::<OutputTarget>(json!({"kind":"ndi","id":"camera"})).is_err()
        );
    }
    #[test]
    fn installed_driver_inventory_is_read_only() {
        let inventory = native::inventory().unwrap();
        assert!(inventory["devices"].is_array());
        // No EnableVideoOutput, profile switch, or screen-capture request.
    }
}
