/**
 * Unified Transport Layer for LLM Quota Tracker
 * Standardizes HTTP requests and Tauri IPC invocation across Node.js CLI and Web-Overlay
 */

/**
 * Universal detector for Tauri IPC invoke function
 */
export function getInvoke() {
  if (typeof window !== 'undefined') {
    return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke || null;
  }
  return null;
}

/**
 * Dynamic User-Agent resolver
 * Pulls directly from WebKit (navigator.userAgent) in the webview,
 * or dynamically formats from Node.js runtime environment.
 * Zero hardcoded strings.
 */
let cachedUserAgent = null;

export function getUserAgent() {
  if (cachedUserAgent) return cachedUserAgent;

  if (typeof navigator !== 'undefined' && navigator?.userAgent) {
    cachedUserAgent = navigator.userAgent;
    return cachedUserAgent;
  }
  if (typeof process !== 'undefined' && process?.version) {
    cachedUserAgent = `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    return cachedUserAgent;
  }
  return null;
}

/**
 * Perform an HTTP request via the appropriate environment transport:
 * 1. Tauri: invokes native 'relay_fetch' (handles self-signed certs & loopback HTTPS)
 * 2. Node.js: uses node:https with rejectUnauthorized: false for loopback
 * 3. Browser/Fallback: uses standard fetch()
 *
 * @param {string} url
 * @param {Object} options
 * @returns {Promise<{ ok: boolean, status: number, json: () => Promise<any>, text: () => Promise<string> }>}
 */
export async function relayFetch(url, options = {}) {
  const invoke = getInvoke();

  // Prepare headers and dynamically inject WebKit / runtime User-Agent if not explicitly specified
  const headers = { ...(options.headers || {}) };
  const hasUa = Object.keys(headers).some(k => k.toLowerCase() === 'user-agent');
  if (!hasUa) {
    const ua = getUserAgent();
    if (ua) {
      headers['User-Agent'] = ua;
    }
  }

  if (invoke) {
    try {
      console.log(`[net] relay_fetch IPC -> ${options.method || 'GET'} ${url}`);
      const res = await invoke('relay_fetch', {
        url,
        method: options.method || 'GET',
        headers,
        body: options.body || null,
      });
      console.log(`[net] relay_fetch IPC <- status ${res.status} for ${url}`);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => JSON.parse(res.body),
        text: async () => res.body,
      };
    } catch (err) {
      console.warn(`[net] Tauri relay_fetch failed for ${url}:`, err);
      // In Tauri, NEVER fall through to window.fetch() which will fail with CORS / SSL access control errors
      throw err;
    }
  }

  // Node.js environment: use node:https with dedicated rejectUnauthorized agent for local loopback
  if (typeof process !== 'undefined' && process.versions?.node && url.startsWith('https://127.0.0.1')) {
    const https = await import('node:https');
    const { URL } = await import('node:url');
    const parsedUrl = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: new https.Agent({ rejectUnauthorized: false }),
        signal: options.signal,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: async () => JSON.parse(data),
            text: async () => data,
          });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  // Standard browser or remote API fallback
  return fetch(url, options);
}
