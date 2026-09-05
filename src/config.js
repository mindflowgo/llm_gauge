/**
 * Universal Configuration Resolver for LLM Quota / Gauge Tracker
 * ~/.llm-gauge.json is the ONLY source of truth for settings, keys, etc.
 * No path scanning.
 */

import { getInvoke } from './net.js';

let cachedConfig = null;

/**
 * Safely read a JSON file from disk in Node.js environments
 */
async function readJsonFile(filePath) {
  if (typeof process === 'undefined' || !process.versions?.node) {
    return null;
  }
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    let resolvedPath = filePath;
    if (resolvedPath.startsWith('~')) {
      resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
    }

    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Gracefully ignore permission or parse errors
  }
  return null;
}

/**
 * Invalidate cached config
 */
export function clearConfigCache() {
  cachedConfig = null;
}

/**
 * Load configuration from ~/.llm-gauge.json (the ONLY source of truth)
 */
export async function loadConfig(forceRefresh = false) {
  if (!forceRefresh && cachedConfig && Object.keys(cachedConfig).length > 0) {
    return cachedConfig;
  }

  let config = {};

  // 1. In Tauri webview, invoke native get_user_settings
  const invoke = getInvoke();
  if (invoke) {
    try {
      const nativeSettings = await invoke('get_user_settings');
      if (nativeSettings && typeof nativeSettings === 'object') {
        config = { ...nativeSettings };
      }
    } catch {}
  }

  // 2. In Node.js / CLI, read directly from ~/.llm-gauge.json
  if (Object.keys(config).length === 0 && typeof process !== 'undefined' && process.versions?.node) {
    const envPath = process.env?.LLM_GAUGE_SETTINGS_PATH;
    if (envPath) {
      const customConfig = await readJsonFile(envPath);
      if (customConfig) config = { ...customConfig };
    }
    if (Object.keys(config).length === 0) {
      const gaugeConfig = await readJsonFile('~/.llm-gauge.json');
      if (gaugeConfig) config = { ...gaugeConfig };
    }
  }

  if (Object.keys(config).length > 0) {
    cachedConfig = config;
  }
  return config;
}

/**
 * Get credentials/token for a specific provider from ~/.llm-gauge.json (or env var)
 * @param {string} providerId 'antigravity' | 'zcode' | 'opencode'
 */
export async function getProviderToken(providerId) {
  let config = await loadConfig();

  // If token is missing, force refresh from disk/IPC in case user recently saved a new key
  if (!config.apiKeys?.[providerId] && !config[providerId]?.apiKey && !config[providerId]?.token) {
    config = await loadConfig(true);
  }

  // 1. Check apiKeys.<provider> from ~/.llm-gauge.json
  if (config.apiKeys?.[providerId]) {
    return config.apiKeys[providerId];
  }
  if (config[providerId]?.apiKey) return config[providerId].apiKey;
  if (config[providerId]?.token) return config[providerId].token;

  // 2. Environment variable fallback
  if (typeof process !== 'undefined' && process.env) {
    if (providerId === 'zcode') {
      return process.env.ZCODE_API_KEY || process.env.ZAI_API_KEY || null;
    }
    if (providerId === 'opencode') {
      return process.env.OPENCODE_API_KEY || process.env.OPENCODE_TOKEN || null;
    }
  }

  return null;
}

/**
 * Get configured additional secondary accounts (e.g. for Antigravity)
 */
export async function getAdditionalAccounts(providerId) {
  const config = await loadConfig();
  if (providerId === 'antigravity' && Array.isArray(config.antigravity?.additionalAccounts)) {
    return config.antigravity.additionalAccounts;
  }
  return [];
}
