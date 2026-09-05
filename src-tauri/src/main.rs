// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use std::net::TcpStream;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};

pub mod settings;
pub mod window_state;

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(OverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true,
        }
    })

    panel_event!(OverlayPanelEventHandler {
        window_did_move(notification: &tauri_nspanel::objc2_foundation::NSNotification) -> (),
        window_did_resize(notification: &tauri_nspanel::objc2_foundation::NSNotification) -> (),
    })
}

#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone)]
pub struct TrayToggleState(pub MenuItem<tauri::Wry>);

fn is_overlay_visible(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("overlay") {
            return panel.is_visible();
        }
    }

    if let Some(window) = app.get_webview_window("overlay") {
        return window.is_visible().unwrap_or(false);
    }
    false
}

pub fn update_tray_menu_text(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<TrayToggleState>() {
        let is_vis = is_overlay_visible(app);
        let label = if is_vis { "Hide Window" } else { "Show Window" };
        let _ = state.0.set_text(label);
    }
}


/// Configure the macOS floating overlay panel with partial opacity, vibrancy and non-activating window behavior
#[cfg(target_os = "macos")]
fn configure_overlay_panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri_nspanel::objc2_app_kit::{
        NSAutoresizingMaskOptions, NSTrackingArea, NSTrackingAreaOptions, NSView,
        NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use tauri_nspanel::objc2_foundation::NSRect;
    use tauri_nspanel::objc2::rc::Retained;
    use tauri_nspanel::objc2::ClassType;
    use tauri_nspanel::WebviewWindowExt;
    use tauri::Emitter;

    let panel = window.to_panel::<OverlayPanel>().map_err(|error| error.to_string())?;
    panel.set_level(4); // NSFloatingWindowLevel: floats above standard windows
    panel.set_style_mask(
        NSWindowStyleMask::Borderless | NSWindowStyleMask::Resizable | NSWindowStyleMask::NonactivatingPanel,
    );
    panel.set_collection_behavior(
        NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::CanJoinAllSpaces,
    );
    panel.set_becomes_key_only_if_needed(true);
    panel.set_floating_panel(true);
    panel.set_has_shadow(false);
    panel.set_transparent(true);
    panel.set_corner_radius(16.0);

    unsafe {
        let _: () = tauri_nspanel::objc2::msg_send![panel.as_panel(), setMovableByWindowBackground: true];

        let content_view: Retained<NSView> = tauri_nspanel::objc2::msg_send![panel.as_panel(), contentView];
        let bounds: NSRect = tauri_nspanel::objc2::msg_send![&content_view, bounds];

        let tracking_options = NSTrackingAreaOptions::ActiveAlways
            | NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::InVisibleRect;

        let alloc: *mut NSTrackingArea = tauri_nspanel::objc2::msg_send![
            NSTrackingArea::class(),
            alloc
        ];
        let area: *mut NSTrackingArea = tauri_nspanel::objc2::msg_send![
            alloc,
            initWithRect: bounds,
            options: tracking_options,
            owner: panel.as_panel(),
            userInfo: tauri_nspanel::objc2::ffi::nil
        ];
        let tracking_area = Retained::from_raw(area).unwrap();

        let resize_mask = NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable;
        let _: () = tauri_nspanel::objc2::msg_send![&content_view, setAutoresizingMask: resize_mask];
        let _: () = tauri_nspanel::objc2::msg_send![&content_view, addTrackingArea: &*tracking_area];
    }

    let handler = OverlayPanelEventHandler::new();
    let app_clone = window.app_handle().clone();

    let app_clone_entered = app_clone.clone();
    handler.on_mouse_entered(move |_event| {
        if let Some(overlay_window) = app_clone_entered.get_webview_window("overlay") {
            let _ = overlay_window.emit("overlay-entered", ());
        }
    });

    let app_clone_exited = app_clone.clone();
    handler.on_mouse_exited(move |_event| {
        if let Some(overlay_window) = app_clone_exited.get_webview_window("overlay") {
            let _ = overlay_window.emit("overlay-exited", ());
        }
    });

    panel.set_event_handler(Some(handler.as_ref()));

    Ok(())
}

/// Initiate native window drag on the overlay panel
#[tauri::command]
fn native_overlay_start_drag(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.start_dragging().map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// Adjust overlay window opacity (0.0 transparent to 1.0 opaque)
#[tauri::command]
fn native_overlay_set_opacity(app: tauri::AppHandle, alpha: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("overlay") {
            unsafe {
                let _: () = tauri_nspanel::objc2::msg_send![panel.as_panel(), setAlphaValue: alpha];
            }
            return Ok(());
        }
    }

    let _ = (app, alpha);
    Ok(())
}

/// Pin or unpin the overlay window (floating HUD level above other windows)
#[tauri::command]
fn native_overlay_set_pinned(app: tauri::AppHandle, pinned: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("overlay") {
            panel.set_floating_panel(pinned);
            panel.set_level(if pinned { 4 } else { 0 });
            return Ok(pinned);
        }
    }

    if let Some(window) = app.get_webview_window("overlay") {
        window.set_always_on_top(pinned).map_err(|e| e.to_string())?;
        return Ok(pinned);
    }
    Ok(false)
}

/// Unified overlay window visibility control ("show", "hide", or "toggle")
#[tauri::command]
fn native_overlay_visibility(app: tauri::AppHandle, action: Option<String>) -> Result<bool, String> {
    let mode = action.as_deref().unwrap_or("toggle");

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("overlay") {
            let make_visible = match mode {
                "show" => true,
                "hide" => false,
                _ => !panel.is_visible(),
            };
            if make_visible {
                panel.show();
            } else {
                panel.hide();
            }
            update_tray_menu_text(&app);
            return Ok(make_visible);
        }
    }

    if let Some(window) = app.get_webview_window("overlay") {
        let currently_visible = window.is_visible().unwrap_or(false);
        let make_visible = match mode {
            "show" => true,
            "hide" => false,
            _ => !currently_visible,
        };
        if make_visible {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
        update_tray_menu_text(&app);
        return Ok(make_visible);
    }

    update_tray_menu_text(&app);
    Ok(false)
}

/// Dynamically resize the overlay window
#[tauri::command]
fn native_overlay_set_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        use tauri_nspanel::objc2_foundation::{NSPoint, NSRect, NSSize};
        if let Ok(panel) = app.get_webview_panel("overlay") {
            unsafe {
                let frame: NSRect = tauri_nspanel::objc2::msg_send![panel.as_panel(), frame];
                let new_y = frame.origin.y + (frame.size.height - height);
                let new_frame = NSRect::new(
                    NSPoint::new(frame.origin.x, new_y),
                    NSSize::new(width, height),
                );
                let _: () = tauri_nspanel::objc2::msg_send![
                    panel.as_panel(),
                    setFrame: new_frame,
                    display: true,
                    animate: false
                ];
            }
            return Ok(true);
        }
    }

    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// Get current logical size of the overlay window
#[tauri::command]
fn native_overlay_get_size(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        use tauri_nspanel::objc2_foundation::NSRect;
        if let Ok(panel) = app.get_webview_panel("overlay") {
            unsafe {
                let frame: NSRect = tauri_nspanel::objc2::msg_send![panel.as_panel(), frame];
                return Ok((frame.size.width, frame.size.height));
            }
        }
    }

    if let Some(window) = app.get_webview_window("overlay") {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.inner_size().map_err(|e| e.to_string())?;
        return Ok((size.width as f64 / scale, size.height as f64 / scale));
    }
    Ok((0.0, 0.0))
}

/// Open native Webview DevTools window
#[tauri::command]
fn open_devtools(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.open_devtools();
        return Ok(true);
    }
    Ok(false)
}

/// Dynamically update the system tray icon with RGBA bytes (e.g. AI icon with token bar) and tooltip/title
#[tauri::command]
fn native_tray_update_icon(
    app: tauri::AppHandle,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    tooltip: Option<String>,
    title: Option<String>,
) -> Result<bool, String> {
    if let Some(tray) = app.tray_by_id("tray") {
        if !rgba.is_empty() && width > 0 && height > 0 {
            let image = tauri::image::Image::new_owned(rgba, width, height);
            let _ = tray.set_icon(Some(image));
            #[cfg(target_os = "macos")]
            let _ = tray.set_icon_as_template(false);
        }
        if let Some(t) = tooltip {
            let _ = tray.set_tooltip(Some(t));
        }
        #[cfg(target_os = "macos")]
        if let Some(t) = title {
            let _ = tray.set_title(Some(t));
        }
        return Ok(true);
    }
    Ok(false)
}

/// Strictly functional HTTP proxy relay for the frontend JS plugins
/// Allows loopback HTTPS with self-signed certs and bypasses browser CORS
#[tauri::command]
async fn relay_fetch(
    client: tauri::State<'_, Client>,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<RelayResponse, String> {
    let req_method = match method.to_uppercase().as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => reqwest::Method::GET,
    };

    let mut req = client.request(req_method, &url);

    for (k, v) in headers {
        req = req.header(&k, &v);
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let req_timeout = if url.contains("127.0.0.1") || url.contains("localhost") {
        Duration::from_millis(3000)
    } else {
        Duration::from_secs(12)
    };
    req = req.timeout(req_timeout);

    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status().as_u16();
    let resp_text = resp.text().await.map_err(|e| format!("Failed to read response body: {e}"))?;

    Ok(RelayResponse {
        status,
        body: resp_text,
    })
}

#[derive(Debug, Serialize)]
pub struct ProcessInfo {
    pub is_running: bool,
    pub port: Option<u16>,
    pub ports: Vec<u16>,
    pub csrf_token: Option<String>,
}

/// Helper to scan whether Antigravity language server is listening on loopback
#[tauri::command]
async fn check_process(name: String) -> Result<ProcessInfo, String> {
    if name == "antigravity" || name == "agy" {
        let mut target_pid: Option<u32> = None;
        let mut csrf_token: Option<String> = None;

        let ps_bin = if std::path::Path::new("/bin/ps").exists() { "/bin/ps" } else { "ps" };

        // 1. Run `ps -ww -eo pid,command` to find the language_server process and extract its CSRF token
        if let Ok(output) = std::process::Command::new(ps_bin)
            .args(["-ww", "-eo", "pid,command"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut candidates: Vec<(u32, String, bool)> = Vec::new();

                for line in text.lines() {
                    if line.contains("language_server") && line.contains("--csrf_token") {
                        let parts: Vec<&str> = line.trim().split_whitespace().collect();
                        if let Some(pid_str) = parts.first() {
                            if let Ok(pid) = pid_str.parse::<u32>() {
                                if let Some(idx) = line.find("--csrf_token") {
                                    let sub = line[idx + 12..].trim_start_matches(|c| c == ' ' || c == '=');
                                    let token: String = sub.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
                                    if !token.is_empty() {
                                        let is_preferred = line.contains("subclient_type hub") || line.contains("Antigravity.app");
                                        candidates.push((pid, token, is_preferred));
                                    }
                                }
                            }
                        }
                    }
                }

                // Prioritize hub/Antigravity.app if present
                if let Some((pid, token, _)) = candidates.iter().find(|(_, _, pref)| *pref).or_else(|| candidates.first()) {
                    target_pid = Some(*pid);
                    csrf_token = Some(token.clone());
                }
            }
        }

        // 2. Discover listening ports via lsof
        let mut found_ports: Vec<u16> = Vec::new();
        let lsof_bin = if std::path::Path::new("/usr/sbin/lsof").exists() { "/usr/sbin/lsof" } else { "lsof" };
        let lsof_args = if let Some(pid) = target_pid {
            vec!["-a".to_string(), format!("-p{}", pid), "-iTCP".to_string(), "-sTCP:LISTEN".to_string(), "-P".to_string(), "-n".to_string()]
        } else {
            vec!["-iTCP".to_string(), "-sTCP:LISTEN".to_string(), "-P".to_string(), "-n".to_string(), "+c".to_string(), "40".to_string()]
        };

        if let Ok(output) = std::process::Command::new(lsof_bin)
            .args(&lsof_args)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if target_pid.is_some() || line.contains("language_server") {
                        let port_opt = line.split("127.0.0.1:").nth(1).or_else(|| line.split("*:").nth(1));
                        if let Some(port_str) = port_opt {
                            let port_digits: String = port_str.chars().take_while(|c| c.is_ascii_digit()).collect();
                            if let Ok(port) = port_digits.parse::<u16>() {
                                if !found_ports.contains(&port) {
                                    found_ports.push(port);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Fallback to standard ports if lsof was restricted
        if found_ports.is_empty() {
            let standard_ports = [56154, 56155, 58800, 58801, 58938, 58939, 54100, 54101];
            for port in standard_ports {
                let addr = format!("127.0.0.1:{}", port);
                if let Ok(stream) = TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    Duration::from_millis(80),
                ) {
                    drop(stream);
                    found_ports.push(port);
                }
            }
        }

        if !found_ports.is_empty() || csrf_token.is_some() {
            return Ok(ProcessInfo {
                is_running: true,
                port: found_ports.first().copied(),
                ports: found_ports,
                csrf_token,
            });
        }
    }

    Ok(ProcessInfo {
        is_running: false,
        port: None,
        ports: Vec::new(),
        csrf_token: None,
    })
}

/// Read user configuration with multi-source fallback
#[tauri::command]
fn get_config() -> Result<serde_json::Value, String> {
    let mut config = serde_json::json!({});

    let mut candidate_paths: Vec<std::path::PathBuf> = Vec::new();

    // 1. Current working directory config.json
    candidate_paths.push(std::path::PathBuf::from("config.json"));

    // 2. Parent directory config.json (e.g. running from src-tauri)
    candidate_paths.push(std::path::PathBuf::from("../config.json"));

    // 3. Executable directory config.json
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidate_paths.push(dir.join("config.json"));
            candidate_paths.push(dir.join("../config.json"));
            candidate_paths.push(dir.join("../../config.json"));
            candidate_paths.push(dir.join("../../../config.json"));
        }
    }

    // 4. HOME directory locations
    if let Ok(home) = std::env::var("HOME") {
        let home_path = std::path::Path::new(&home);
        candidate_paths.push(home_path.join(".llm-quota").join("config.json"));
        candidate_paths.push(home_path.join(".config").join("llm-quota").join("config.json"));
    }

    // Attempt to load general configs in order
    for p in candidate_paths {
        if let Ok(data) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                if let (Some(c_obj), Some(v_obj)) = (config.as_object_mut(), v.as_object()) {
                    for (k, val) in v_obj {
                        if !c_obj.contains_key(k) {
                            c_obj.insert(k.clone(), val.clone());
                        }
                    }
                }
            }
        }
    }

    // 5. Native ZCode config (~/.zcode/v2, ~/.zcode/cli, ~/.zcode)
    let zcode_has_key = config.get("zcode")
        .and_then(|z| z.get("apiKey"))
        .and_then(|k| k.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    if !zcode_has_key {
        if let Some(key) = settings::resolve_zcode_key_from_native_config() {
            if let Some(c_obj) = config.as_object_mut() {
                let zcode_val = c_obj.entry("zcode").or_insert_with(|| serde_json::json!({}));
                if let Some(z_obj) = zcode_val.as_object_mut() {
                    z_obj.insert("apiKey".to_string(), serde_json::Value::String(key));
                }
            }
        }
    }

    // 7. Environment variable overrides (ZCODE_API_KEY / ZAI_API_KEY)
    if let Ok(env_key) = std::env::var("ZCODE_API_KEY").or_else(|_| std::env::var("ZAI_API_KEY")) {
        if !env_key.is_empty() {
            if let Some(c_obj) = config.as_object_mut() {
                let zcode_val = c_obj.entry("zcode").or_insert_with(|| serde_json::json!({}));
                if let Some(z_obj) = zcode_val.as_object_mut() {
                    z_obj.insert("apiKey".to_string(), serde_json::Value::String(env_key));
                }
            }
        }
    }

    if let Ok(env_key) = std::env::var("OPENCODE_API_KEY").or_else(|_| std::env::var("OPENCODE_TOKEN")) {
        if !env_key.is_empty() {
            if let Some(c_obj) = config.as_object_mut() {
                let oc_val = c_obj.entry("opencode").or_insert_with(|| serde_json::json!({}));
                if let Some(oc_obj) = oc_val.as_object_mut() {
                    oc_obj.insert("apiKey".to_string(), serde_json::Value::String(env_key));
                }
            }
        }
    }

    // 8. User custom ~/.llm-gauge.json
    let user_settings = settings::get_settings_raw();
    if let Some(api_keys) = user_settings.get("apiKeys").and_then(|v| v.as_object()) {
        for (provider, key_val) in api_keys {
            if let Some(k) = key_val.as_str() {
                if !k.is_empty() {
                    if let Some(c_obj) = config.as_object_mut() {
                        let prov_obj = c_obj.entry(provider).or_insert_with(|| serde_json::json!({}));
                        if let Some(p_map) = prov_obj.as_object_mut() {
                            p_map.insert("apiKey".to_string(), serde_json::Value::String(k.to_string()));
                        }
                    }
                }
            }
        }
    }

    Ok(config)
}

fn main() {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(12))
        .build()
        .expect("failed to initialize reqwest client");

    let builder = tauri::Builder::default();

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .manage(client)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(window) = app.get_webview_window("overlay") {
                #[cfg(target_os = "macos")]
                if let Err(err) = configure_overlay_panel(&window) {
                    eprintln!("Failed to configure overlay panel: {err}");
                }

                // Restore custom window geometry & monitor bounds check (timeflow pattern)
                window_state::restore_window(&window);

                // Wire up automatic state persistence on move/resize (500ms debounce)
                window_state::watch_window(&window);
            }

            // System Tray Menu with Show/Hide Window (depending on state) and Quit
            let is_vis = is_overlay_visible(app.handle());
            let toggle_label = if is_vis { "Hide Window" } else { "Show Window" };
            let toggle_i = MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

            app.manage(TrayToggleState(toggle_i.clone()));

            let mut tray_builder = TrayIconBuilder::with_id("tray")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => {
                        let _ = native_overlay_visibility(app.clone(), Some("toggle".to_string()));
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        update_tray_menu_text(tray.app_handle());
                    }
                });

            let tray_rgba = include_bytes!("../icons/tray_icon.rgba");
            let tray_img = tauri::image::Image::new(tray_rgba, 48, 44);
            tray_builder = tray_builder.icon(tray_img);
            #[cfg(target_os = "macos")]
            {
                tray_builder = tray_builder.icon_as_template(false);
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            relay_fetch,
            check_process,
            native_overlay_start_drag,
            native_overlay_set_size,
            native_overlay_get_size,
            native_overlay_set_opacity,
            native_overlay_set_pinned,
            native_overlay_visibility,
            native_tray_update_icon,
            open_devtools,
            settings::get_user_settings,
            settings::save_user_settings,
            settings::save_api_key,
            window_state::set_window_expanded_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_antigravity_discovery_and_fetch() {
        let res = check_process("antigravity".to_string()).await.unwrap();
        println!("check_process res: {:?}", res);
        if !res.is_running || res.csrf_token.is_none() || res.ports.is_empty() {
            println!("Antigravity process or CSRF token not available in this test environment; skipping live RPC check.");
            return;
        }

        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(6))
            .build()
            .unwrap();

        let port = res.ports[0];
        let token = res.csrf_token.unwrap();
        let url = format!("https://127.0.0.1:{}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", port);

        let mut req = client.post(&url);
        req = req.header("Content-Type", "application/json");
        req = req.header("Connect-Protocol-Version", "1");
        req = req.header("X-Codeium-Csrf-Token", &token);
        req = req.body(r#"{"request":{},"forceRefresh":true}"#);

        let send_res = req.send().await;
        println!("send_res: {:?}", send_res);
        let resp = send_res.expect("HTTP request must succeed");
        assert_eq!(resp.status().as_u16(), 200);
        let text = resp.text().await.unwrap();
        println!("resp text length: {}", text.len());
        assert!(text.contains("groups"));
    }

    #[test]
    fn test_get_config() {
        let cfg = get_config().unwrap();
        println!("Loaded config: {:?}", cfg);
        assert!(cfg.get("zcode").is_some(), "zcode config should be loaded: {:?}", cfg);
    }
}


