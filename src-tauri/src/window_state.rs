//! Custom window state persistence mirroring timeflow architecture.
//! Stores logical coordinates, size, and monitor validation to ~/.llm-gauge.json.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{LogicalPosition, LogicalSize, Position, Size, WebviewWindow};

static TEMPORARY_EXPANDED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

pub fn set_temporary_expanded(expanded: bool) {
    TEMPORARY_EXPANDED.store(expanded, Ordering::Relaxed);
}

pub fn is_temporary_expanded() -> bool {
    TEMPORARY_EXPANDED.load(Ordering::Relaxed)
}

pub fn load_window_geometry() -> Option<WindowGeometry> {
    let raw = crate::settings::get_settings_raw();
    let win_val = raw.get("window")?;
    serde_json::from_value(win_val.clone()).ok()
}

pub fn save_window_geometry(geo: &WindowGeometry) {
    if let Ok(val) = serde_json::to_value(geo) {
        let mut raw = crate::settings::get_settings_raw();
        if let Some(obj) = raw.as_object_mut() {
            obj.insert("window".to_string(), val);
        }
        let _ = crate::settings::save_settings_raw(&raw);
    }
}

pub fn restore_window(window: &WebviewWindow) {
    let Some(geo) = load_window_geometry() else {
        // First launch default: top-right corner of primary monitor
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let screen_size = monitor.size();
            let scale = monitor.scale_factor();
            let win_width = (320.0 * scale) as i32;
            let x = screen_size.width as i32 - win_width - (24.0 * scale) as i32;
            let y = (40.0 * scale) as i32;
            let _ = window.set_position(Position::Physical(tauri::PhysicalPosition { x, y }));
            let _ = window.set_size(Size::Logical(LogicalSize::new(320.0, 76.0)));
            persist_window(window);
        }
        return;
    };

    // Use LOGICAL units for DPI-safe restoration
    let _ = window.set_size(Size::Logical(LogicalSize::new(geo.width, geo.height)));

    // Verify saved position intersects an active monitor
    let mut is_visible_on_any_monitor = true;
    if let Ok(monitors) = window.available_monitors() {
        if !monitors.is_empty() {
            is_visible_on_any_monitor = false;
            let scale = window.scale_factor().unwrap_or(1.0);
            let phys_x = (geo.x * scale) as i32;
            let phys_y = (geo.y * scale) as i32;

            for m in monitors {
                let m_pos = m.position();
                let m_size = m.size();
                let margin = 20;
                let inside_x = phys_x >= (m_pos.x - margin) && phys_x < (m_pos.x + m_size.width as i32 + margin);
                let inside_y = phys_y >= (m_pos.y - margin) && phys_y < (m_pos.y + m_size.height as i32 + margin);

                if inside_x && inside_y {
                    is_visible_on_any_monitor = true;
                    break;
                }
            }
        }
    }

    if is_visible_on_any_monitor {
        let _ = window.set_position(Position::Logical(LogicalPosition::new(geo.x, geo.y)));
    } else if let Ok(Some(monitor)) = window.primary_monitor() {
        let screen_size = monitor.size();
        let scale = monitor.scale_factor();
        let win_width = (geo.width * scale) as i32;
        let x = screen_size.width as i32 - win_width - (24.0 * scale) as i32;
        let y = (40.0 * scale) as i32;
        let _ = window.set_position(Position::Physical(tauri::PhysicalPosition { x, y }));
    }
}

pub fn persist_window(window: &WebviewWindow) {
    if is_temporary_expanded() {
        return;
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(phys_pos) = window.outer_position() else { return };
    let Ok(phys_size) = window.outer_size() else { return };

    if phys_size.width == 0 || phys_size.height == 0 {
        return;
    }

    let visible = window.is_visible().unwrap_or(true);

    let geo = WindowGeometry {
        x: phys_pos.x as f64 / scale,
        y: phys_pos.y as f64 / scale,
        width: phys_size.width as f64 / scale,
        height: phys_size.height as f64 / scale,
        visible,
    };

    save_window_geometry(&geo);
}

pub fn watch_window(window: &WebviewWindow) {
    let win_clone = window.clone();
    let seq = Arc::new(AtomicU64::new(0));

    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let current_seq = seq.fetch_add(1, Ordering::Relaxed) + 1;
                let w = win_clone.clone();
                let seq_clone = seq.clone();

                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if seq_clone.load(Ordering::Relaxed) == current_seq {
                        persist_window(&w);
                    }
                });
            }
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                persist_window(&win_clone);
            }
            _ => {}
        }
    });
}

#[tauri::command]
pub fn set_window_expanded_mode(expanded: bool) {
    set_temporary_expanded(expanded);
}
