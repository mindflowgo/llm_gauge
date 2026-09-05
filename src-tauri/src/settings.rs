//! Settings persistence to ~/.llm-gauge.json
//! Tracks window geometry, opacity, pinned state, gauge selections, and API keys.

use serde_json::{json, Value};
use std::path::PathBuf;

pub fn settings_file_path() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("LLM_GAUGE_SETTINGS_PATH") {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".llm-gauge.json"))
}

pub fn get_settings_raw() -> Value {
    if let Some(path) = settings_file_path() {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    return json;
                }
            }
        }
    }

    // Default structure if file does not exist yet
    json!({
        "window": {
            "x": 0.0,
            "y": 0.0,
            "width": 320.0,
            "height": 76.0,
            "visible": true
        },
        "settings": {
            "opacity": 0.88,
            "pinned": true,
            "selectedGauges": []
        },
        "apiKeys": {
            "zcode": "",
            "opencode": ""
        }
    })
}

pub fn save_settings_raw(raw: &Value) -> Result<(), String> {
    let Some(path) = settings_file_path() else {
        return Err("Failed to resolve user HOME directory".to_string());
    };

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let content = serde_json::to_string_pretty(raw).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_setting_value(section: &str, key: &str) -> Option<Value> {
    let raw = get_settings_raw();
    raw.get(section)?.get(key).cloned()
}

pub fn set_setting_value(section: &str, key: &str, value: Value) -> Result<(), String> {
    let mut raw = get_settings_raw();
    if !raw.is_object() {
        raw = json!({});
    }

    let obj = raw.as_object_mut().unwrap();
    let sec = obj.entry(section).or_insert_with(|| json!({}));
    if let Some(sec_obj) = sec.as_object_mut() {
        sec_obj.insert(key.to_string(), value);
    }

    save_settings_raw(&raw)
}

/// Resolve ZCode API key from native installation paths (~/.zcode/v2, ~/.zcode/cli, ~/.zcode)
pub fn resolve_zcode_key_from_native_config() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let home_path = std::path::Path::new(&home);

    // 1. ~/.zcode/v2/config.json
    let zcode_v2 = home_path.join(".zcode").join("v2").join("config.json");
    if let Ok(data) = std::fs::read_to_string(&zcode_v2) {
        if let Ok(zv) = serde_json::from_str::<Value>(&data) {
            let key = zv.pointer("/builtin:zai-coding-plan/options/apiKey")
                .or_else(|| zv.pointer("/builtin:zai/options/apiKey"))
                .and_then(|v| v.as_str());
            if let Some(k) = key {
                if !k.is_empty() {
                    return Some(k.to_string());
                }
            }
        }
    }

    // 2. ~/.zcode/cli/config.json or ~/.zcode/config.json
    for sub in &["cli/config.json", "config.json"] {
        let p = home_path.join(".zcode").join(sub);
        if let Ok(data) = std::fs::read_to_string(&p) {
            if let Ok(zv) = serde_json::from_str::<Value>(&data) {
                let key = zv.get("apiKey")
                    .or_else(|| zv.get("access_token"))
                    .and_then(|v| v.as_str());
                if let Some(k) = key {
                    if !k.is_empty() {
                        return Some(k.to_string());
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn get_user_settings() -> Result<Value, String> {
    let mut raw = get_settings_raw();

    // If zcode API key is empty in settings, check if we can populate it from existing sources
    let zcode_empty = raw.pointer("/apiKeys/zcode")
        .and_then(|v| v.as_str())
        .map(|s| s.is_empty())
        .unwrap_or(true);

    if zcode_empty {
        if let Some(key) = resolve_zcode_key_from_native_config() {
            if let Some(api_keys) = raw.pointer_mut("/apiKeys").and_then(|v| v.as_object_mut()) {
                api_keys.insert("zcode".to_string(), json!(key));
            }
        }
    }

    // Ensure ~/.llm-quota.json is created on disk
    if let Some(path) = settings_file_path() {
        if !path.exists() {
            let _ = save_settings_raw(&raw);
        }
    }

    Ok(raw)
}

#[tauri::command]
pub fn save_user_settings(settings: Value) -> Result<bool, String> {
    let mut current = get_settings_raw();
    if let Some(obj) = current.as_object_mut() {
        obj.insert("settings".to_string(), settings);
    }
    save_settings_raw(&current)?;
    Ok(true)
}

#[tauri::command]
pub fn save_api_key(provider: String, key: String) -> Result<bool, String> {
    let mut current = get_settings_raw();
    if let Some(obj) = current.as_object_mut() {
        let keys_val = obj.entry("apiKeys").or_insert_with(|| json!({}));
        if let Some(keys_obj) = keys_val.as_object_mut() {
            keys_obj.insert(provider, json!(key));
        }
    }
    save_settings_raw(&current)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settings_save_and_load() {
        let test_path = std::env::current_dir().unwrap().join("target").join("test_settings.json");
        std::env::set_var("LLM_GAUGE_SETTINGS_PATH", test_path.to_str().unwrap());

        let path = settings_file_path();
        println!("settings_file_path: {:?}", path);
        assert_eq!(path, Some(test_path.clone()));

        let res = get_user_settings();
        println!("get_user_settings: {:?}", res);
        assert!(res.is_ok());

        let raw = res.unwrap();
        let save_res = save_settings_raw(&raw);
        println!("save_settings_raw: {:?}", save_res);
        assert!(save_res.is_ok());
        assert!(test_path.exists());

        // Test custom key update
        let _ = save_api_key("zcode".to_string(), "b671-test".to_string());
        let updated = get_user_settings().unwrap();
        assert_eq!(
            updated.pointer("/apiKeys/zcode").and_then(|v| v.as_str()),
            Some("b671-test")
        );

        // Test saving user settings directly
        let save_gauges_res = save_user_settings(json!({
            "opacity": 0.88,
            "pinned": true,
            "selectedGauges": ["antigravity_gemini", "opencode_opencode-go"]
        }));
        assert!(save_gauges_res.is_ok());

        let loaded = get_user_settings().unwrap();
        let loaded_gauges: Vec<String> = loaded
            .pointer("/settings/selectedGauges")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(loaded_gauges, vec!["antigravity_gemini", "opencode_opencode-go"]);
        assert_eq!(loaded.pointer("/settings/opacity").and_then(|v| v.as_f64()), Some(0.88));
        assert_eq!(loaded.pointer("/settings/pinned").and_then(|v| v.as_bool()), Some(true));

        let _ = std::fs::remove_file(test_path);
        std::env::remove_var("LLM_GAUGE_SETTINGS_PATH");
    }
}

