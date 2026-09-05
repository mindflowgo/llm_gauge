import { pluginManager } from './plugins/index.js';
import { toDisplayAccount, getPercentCategory } from './viewmodel.js';
import { getInvoke } from './net.js';
import { clearConfigCache } from './config.js';

// --- In-memory Console Log Buffer & Interceptor ---
const logBuffer = [];
const MAX_LOGS = 350;
let isLogsOpen = false;
let priorLogsWindowSize = null;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function formatArg(arg) {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function captureLog(level, args) {
  const d = new Date();
  const time = `${d.toTimeString().split(' ')[0]}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const text = args.map(formatArg).join(' ');
  const entry = { time, level, text };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
  if (isLogsOpen) {
    appendLogToDom(entry);
  }
}

console.log = (...args) => { originalConsole.log(...args); captureLog('log', args); };
console.info = (...args) => { originalConsole.info(...args); captureLog('info', args); };
console.warn = (...args) => { originalConsole.warn(...args); captureLog('warn', args); };
console.error = (...args) => { originalConsole.error(...args); captureLog('error', args); };

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    console.error('[uncaught error]', e.message, e.filename ? `(${e.filename}:${e.lineno})` : '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });
}

let currentQuotas = [];
let currentModelItems = [];
let selectedModelKey = null;
let statsTimeout = null;
let isPinned = false;

let userSettings = {
  opacity: 0.88,
  pinned: true,
  selectedGauges: [],
};
let apiKeys = {
  zcode: '',
  opencode: '',
};
let allAvailableModels = [];
let tempSelectedGauges = new Set();
let isSettingsOpen = false;
let priorSettingsWindowSize = null;

/**
 * Escape HTML special characters for safe template interpolation
 */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const GAUGE_COLORS = {
  good: { stroke: '#10b981', glow: 'glow-green' },
  warning: { stroke: '#f59e0b', glow: 'glow-amber' },
  danger: { stroke: '#f43f5e', glow: 'glow-rose' },
};

/**
 * Returns gauge color and drop-shadow glow based on percentage left.
 * Null/undefined returns the grey depleted track. <= 0 returns transparent.
 */
function getGaugeColor(pct) {
  if (pct === null || pct === undefined) {
    return { stroke: 'rgba(255, 255, 255, 0.15)', glow: '' };
  }
  if (pct <= 0) {
    return { stroke: 'transparent', glow: '' };
  }
  return GAUGE_COLORS[getPercentCategory(pct)];
}

/**
 * Returns raw SVG elements for the model logo, positioned at (50, 50) in SVG 100x100 space
 * Enlarged by 25% so the outer tips bleed directly into the donut stroke (inner radius = 32)
 */
function getModelSvgContent(id = '', name = '') {
  const key = `${id} ${name}`.toLowerCase();

  if (key.includes('gemini')) {
    // 4-pointed Gemini Sparkle centered at (50, 50), enlarged 25% (r=33) to bleed into donut
    return `
      <path d="M 50 17 L 54.5 45.5 L 83 50 L 54.5 54.5 L 50 83 L 45.5 54.5 L 17 50 L 45.5 45.5 Z" fill="#67e8f9" />
    `;
  }
  if (key.includes('claude')) {
    // Anthropic Claude Official Terracotta Spark enlarged 25% (spokes to r=33) to bleed into donut
    return `
      <g stroke="#D97757" stroke-width="5" stroke-linecap="round">
        <line x1="50" y1="50" x2="50" y2="17" />
        <line x1="50" y1="50" x2="50" y2="83" />
        <line x1="50" y1="50" x2="83" y2="50" />
        <line x1="50" y1="50" x2="17" y2="50" />
        <line x1="50" y1="50" x2="77" y2="34.5" />
        <line x1="50" y1="50" x2="65.5" y2="23" />
        <line x1="50" y1="50" x2="77" y2="65.5" />
        <line x1="50" y1="50" x2="65.5" y2="77" />
        <line x1="50" y1="50" x2="34.5" y2="77" />
        <line x1="50" y1="50" x2="23" y2="65.5" />
        <line x1="50" y1="50" x2="23" y2="34.5" />
        <line x1="50" y1="50" x2="34.5" y2="23" />
      </g>
      <circle cx="50" cy="50" r="8" fill="#D97757" />
    `;
  }
  if (key.includes('mcp') || key.includes('tool') || key.includes('web')) {
    // MCP Web Tools Globe centered at (50, 50), enlarged 25% (r=21)
    return `
      <circle cx="50" cy="50" r="21" fill="none" stroke="#67e8f9" stroke-width="2.8" />
      <line x1="29" y1="50" x2="71" y2="50" stroke="#67e8f9" stroke-width="2.2" />
      <path d="M 33 40 Q 50 44 67 40" fill="none" stroke="#67e8f9" stroke-width="2" />
      <path d="M 33 60 Q 50 56 67 60" fill="none" stroke="#67e8f9" stroke-width="2" />
      <ellipse cx="50" cy="50" rx="9.5" ry="21" fill="none" stroke="#67e8f9" stroke-width="2.2" />
    `;
  }
  if (key.includes('glm') || key.includes('zcode') || key.includes('z.ai') || key.includes('z-code')) {
    // Z-Code Stylized Angular Geometric Z enlarged 25% to bleed into donut
    return `
      <path d="M 30 28 L 70 28 L 30 72 L 70 72" fill="none" stroke="#c084fc" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
    `;
  }
  if (key.includes('opencode') || key.includes('open-code')) {
    // OpenCode terminal prompt `>_` enlarged to fit donut
    return `
      <polyline points="30,30 50,50 30,70" fill="none" stroke="#38bdf8" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="56" y1="70" x2="72" y2="70" stroke="#38bdf8" stroke-width="5.5" stroke-linecap="round" />
    `;
  }
  // AI Sparkle on left + vertical gauge on right (bottom 3/4 green, grey top)
  return `
    <path d="M 42 22 Q 42 44 62 44 Q 42 44 42 66 Q 42 44 22 44 Q 42 44 42 22 Z" fill="#ffffff" stroke="#18181b" stroke-width="2.5" />
    <rect x="67" y="32" width="7" height="24" rx="3.5" fill="#71717a" stroke="#18181b" stroke-width="1.5" />
    <rect x="67" y="38" width="7" height="18" rx="3.5" fill="#10b981" />
  `;
}

let baseOpacity = 0.88;
let isMouseInside = false;
let activeCloseMenu = null;
let isDraggingSlider = false;

function setWindowOpacity(alpha) {
  const invoke = getInvoke();
  if (invoke) {
    invoke('native_overlay_set_opacity', { alpha }).catch(() => {});
  }
}

function setOverlaySize(width, height) {
  console.log(`[window] setOverlaySize: ${width}x${height}`);
  const invoke = getInvoke();
  if (invoke) {
    invoke('native_overlay_set_size', { width, height })
      .then(res => console.log(`[window] native_overlay_set_size result:`, res))
      .catch(err => console.error('[window] native_overlay_set_size error:', err));
  }
}

function handleMouseEnter() {
  if (isMouseInside) return;
  isMouseInside = true;
  setWindowOpacity(1.0);
  const container = document.querySelector('.overlay-container');
  if (container) container.classList.add('window-hovered');
}

function handleMouseLeave() {
  if (!isMouseInside) return;
  isMouseInside = false;
  setWindowOpacity(baseOpacity);
  const container = document.querySelector('.overlay-container');
  if (container) container.classList.remove('window-hovered');
  if (activeCloseMenu && !isDraggingSlider) {
    activeCloseMenu();
  }
}

/**
 * Dynamically render the AI sparkle icon with vertical quota gauge to RGBA and update macOS menu tray icon
 */
function updateTrayIcon(pct, tooltip) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 44;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 48, 44);

    // Helper: draw 4-pointed sparkle with concave edges
    function drawSparkle(cx, cy, r) {
      const top = cy - r;
      const bottom = cy + r;
      const left = cx - r;
      const right = cx + r;
      const inward = r * 0.22;

      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.quadraticCurveTo(cx + inward, cy - inward, right, cy);
      ctx.quadraticCurveTo(cx + inward, cy + inward, cx, bottom);
      ctx.quadraticCurveTo(cx - inward, cy + inward, left, cy);
      ctx.quadraticCurveTo(cx - inward, cy - inward, cx, top);
      ctx.closePath();
    }

    // Helper: draw rounded rect
    function drawRoundedRect(x, y, w, h, rad) {
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, rad);
      } else {
        ctx.rect(x, y, w, h);
      }
    }

    // 1. Draw Large Sparkle on Left (cx=18, cy=22, r=15)
    drawSparkle(18, 22, 15);
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 3.0;
    ctx.strokeStyle = '#141416';
    ctx.stroke();
    ctx.fill();

    // 2. Draw Vertical Gauge Bar replacing second star (outer: x=34, y=12, w=8, h=20, rad=4)
    const fillPercent = Math.max(0, Math.min(100, pct));
    let fillColor = '#10b981'; // emerald
    if (fillPercent < 20) {
      fillColor = '#ef4444'; // rose red
    } else if (fillPercent < 50) {
      fillColor = '#f59e0b'; // amber
    }

    // Clip inside rounded capsule and render bottom quota fill + top grey
    ctx.save();
    drawRoundedRect(34, 12, 8, 20, 4);
    ctx.clip();

    // Grey depleted background (top)
    ctx.fillStyle = '#71717a';
    ctx.fillRect(34, 12, 8, 20);

    // Dynamic Quota Fill from bottom upwards
    const fillHeight = Math.max(2, 20 * (fillPercent / 100));
    const fillY = 12 + (20 - fillHeight);
    ctx.fillStyle = fillColor;
    ctx.fillRect(34, fillY, 8, fillHeight);
    ctx.restore();

    // Outer border stroke around vertical bar
    drawRoundedRect(34, 12, 8, 20, 4);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#141416';
    ctx.stroke();

    // Extract raw RGBA image data (48x44 = 2112 pixels = 8448 bytes)
    const imgData = ctx.getImageData(0, 0, 48, 44);
    const rgba = Array.from(imgData.data);

    const invoke = getInvoke();
    if (invoke) {
      invoke('native_tray_update_icon', {
        rgba,
        width: 48,
        height: 44,
        tooltip: tooltip || `LLM Quota: ${Math.round(fillPercent)}% tokens left`,
        title: null,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('updateTrayIcon failed:', err);
  }
}

/**
 * Load saved UI preferences and configuration from Tauri (~/.llm-quota.json) with fallback to localStorage
 */
async function loadUserSettings() {
  console.log('[settings] Loading user settings...');
  const invoke = getInvoke();
  if (invoke) {
    try {
      const config = await invoke('get_user_settings');
      console.log('[settings] Received config from backend:', config);
      if (config?.settings) {
        baseOpacity = config.settings.opacity ?? 0.88;
        isPinned = config.settings.pinned ?? true;
        userSettings = {
          opacity: baseOpacity,
          pinned: isPinned,
          selectedGauges: Array.isArray(config.settings.selectedGauges) ? config.settings.selectedGauges : [],
        };
      }
      if (config?.apiKeys) {
        apiKeys = { ...apiKeys, ...config.apiKeys };
      }
    } catch (err) {
      console.warn('[settings] Failed to load user settings from Tauri:', err);
    }
  } else {
    console.log('[settings] Running outside Tauri desktop; using localStorage fallback');
    // Browser fallback
    try {
      const savedPin = localStorage.getItem('llm_quota_is_pinned');
      if (savedPin !== null) isPinned = savedPin === 'true';
      const savedOpacity = localStorage.getItem('llm_quota_opacity');
      if (savedOpacity) baseOpacity = parseFloat(savedOpacity);
      const savedGauges = localStorage.getItem('llm_quota_selected_gauges');
      if (savedGauges) userSettings.selectedGauges = JSON.parse(savedGauges);
    } catch {}
  }
  setWindowOpacity(baseOpacity);
}

/**
 * Persist user settings to Tauri backend (~/.llm-quota.json)
 */
async function saveUserSettings(newSettings) {
  userSettings = { ...userSettings, ...newSettings };
  console.log('[settings] Saving user settings:', userSettings);
  const invoke = getInvoke();
  if (invoke) {
    try {
      await invoke('save_user_settings', { settings: userSettings });
      console.log('[settings] Settings successfully saved to backend.');
    } catch (err) {
      console.error('[settings] Failed to save user settings:', err);
    }
  } else {
    try {
      if (newSettings.pinned !== undefined) localStorage.setItem('llm_quota_is_pinned', String(newSettings.pinned));
      if (newSettings.opacity !== undefined) localStorage.setItem('llm_quota_opacity', String(newSettings.opacity));
      if (newSettings.selectedGauges !== undefined) localStorage.setItem('llm_quota_selected_gauges', JSON.stringify(newSettings.selectedGauges));
    } catch {}
  }
}

// Initialize UI
async function initApp() {
  console.log('[app] Initializing LLM Quota Overlay...', {
    readyState: document.readyState,
    hasGlobalTauri: typeof window !== 'undefined' && !!window.__TAURI__,
    hasInvoke: !!getInvoke(),
  });

  await loadUserSettings();
  setupControls();
  await loadQuotas(false);

  // Sync initial pin state with backend
  if (isPinned) {
    const invoke = getInvoke();
    if (invoke) {
      invoke('native_overlay_set_pinned', { pinned: true }).catch((err) => {
        console.warn('[app] Initial native_overlay_set_pinned failed:', err);
      });
    }
  }

  // Periodic quota refresh every 60s
  setInterval(() => {
    console.log('[app] Periodic refresh triggered (every 60s)');
    loadQuotas(false);
  }, 60 * 1000);

  // Local 1-second countdown ticker for smooth UI timers without API calls
  setInterval(tickCountdowns, 1000);
  console.log('[app] Initialization complete.');
}

const scheduleInit = () => setTimeout(initApp, 300);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleInit);
} else {
  scheduleInit();
}

function setupControls() {
  const menuDropdown = document.getElementById('menu-dropdown');
  const btnMenu = document.getElementById('btn-menu');

  // Mousing over window makes it 100% opaque, leaving returns to baseOpacity (timeflow pattern)
  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('overlay-entered', () => handleMouseEnter());
    window.__TAURI__.event.listen('overlay-exited', () => handleMouseLeave());
  }

  const docEl = document.documentElement;
  docEl.addEventListener('pointerenter', handleMouseEnter);
  docEl.addEventListener('mouseenter', handleMouseEnter);
  docEl.addEventListener('pointerleave', handleMouseLeave);
  docEl.addEventListener('mouseleave', handleMouseLeave);

  // --- Triple Ellipsis Menu with Auto-Expansion & Mouse-Out Shrink ---
  let priorMenuWindowSize = null;
  let menuCloseTimer = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  window.addEventListener('pointermove', (e) => {
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  }, { passive: true });

  const openMenu = async () => {
    if (menuCloseTimer) {
      clearTimeout(menuCloseTimer);
      menuCloseTimer = null;
    }
    if (!menuDropdown || !menuDropdown.classList.contains('hidden')) return;

    menuDropdown.classList.remove('hidden');
    const controlsCluster = document.querySelector('.window-controls-cluster');
    if (controlsCluster) controlsCluster.classList.add('menu-active');

    const currentSize = await getWindowSize();
    const measuredHeight = menuDropdown.offsetHeight || 205;
    const menuTop = menuDropdown.offsetTop || 34;
    const requiredHeight = Math.max(250, Math.ceil(menuTop + measuredHeight + 12));

    if (currentSize.height < requiredHeight) {
      priorMenuWindowSize = { width: currentSize.width, height: currentSize.height };
      setOverlaySize(currentSize.width, requiredHeight);
    }
  };

  const closeMenu = () => {
    if (menuCloseTimer) {
      clearTimeout(menuCloseTimer);
      menuCloseTimer = null;
    }
    if (!menuDropdown || menuDropdown.classList.contains('hidden')) return;

    menuDropdown.classList.add('hidden');
    const controlsCluster = document.querySelector('.window-controls-cluster');
    if (controlsCluster) controlsCluster.classList.remove('menu-active');

    if (priorMenuWindowSize) {
      const restore = priorMenuWindowSize;
      priorMenuWindowSize = null;
      setOverlaySize(restore.width, restore.height);
    }
  };
  activeCloseMenu = closeMenu;

  const scheduleMenuClose = () => {
    if (isDraggingSlider) return;
    if (menuCloseTimer) clearTimeout(menuCloseTimer);
    menuCloseTimer = setTimeout(() => {
      if (!isDraggingSlider) {
        closeMenu();
      }
    }, 180);
  };

  const cancelMenuClose = () => {
    if (menuCloseTimer) {
      clearTimeout(menuCloseTimer);
      menuCloseTimer = null;
    }
  };

  // Vertical Triple Ellipsis Dropdown Toggle & Hover Listeners
  if (btnMenu && menuDropdown) {
    btnMenu.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (menuDropdown.classList.contains('hidden')) {
        await openMenu();
      } else {
        closeMenu();
      }
    });

    btnMenu.addEventListener('mouseenter', cancelMenuClose);
    btnMenu.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget && e.relatedTarget.closest('#menu-dropdown')) {
        return;
      }
      if (!menuDropdown.classList.contains('hidden')) {
        scheduleMenuClose();
      }
    });

    menuDropdown.addEventListener('mouseenter', cancelMenuClose);
    menuDropdown.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget && e.relatedTarget.closest('#btn-menu')) {
        return;
      }
      scheduleMenuClose();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#btn-menu, #menu-dropdown')) {
        closeMenu();
      }
    });
  }

  // Settings Button in Dropdown Menu
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      window.openSettings();
    });
  }

  // Refresh Button
  const btnRefresh = document.getElementById('btn-refresh');
  const iconRefresh = document.getElementById('icon-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      iconRefresh?.classList.add('animate-spin');
      await loadQuotas(true);
      setTimeout(() => {
        iconRefresh?.classList.remove('animate-spin');
        closeMenu();
      }, 600);
    });
  }

  // Console Logs Button in Dropdown Menu
  const btnLogs = document.getElementById('btn-logs');
  if (btnLogs) {
    btnLogs.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      window.toggleLogs();
    });
  }

  // Global Keyboard Shortcut: Cmd+Shift+L or Ctrl+Shift+L to toggle logs
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      window.toggleLogs();
    }
  });

  // Close Button (Hides overlay panel cleanly; recoverable via System Tray)
  const btnClose = document.getElementById('btn-close');
  if (btnClose) {
    btnClose.addEventListener('click', async () => {
      closeMenu();
      const invoke = getInvoke();
      if (invoke) {
        try {
          await invoke('native_overlay_visibility', { action: 'hide' });
          return;
        } catch (e) {}
      }
      if (window.__TAURI__?.window?.getCurrentWindow) {
        try {
          await window.__TAURI__.window.getCurrentWindow().close();
        } catch (e) {
          console.warn('Tauri close window failed:', e);
        }
      } else {
        window.close();
      }
    });
  }

  // Window dragging: allow dragging anywhere on the window background except interactive elements
  const startDrag = async (e) => {
    if (e.target.closest('button, input, select, textarea, a, [role="button"], #slider-opacity, #menu-dropdown, #btn-menu, .gauge-card, .gauge-select-card, #btn-close-stats, #window-resize-handle, #settings-panel, #logs-panel')) {
      return;
    }
    if (e.button !== 0) return;

    const invoke = getInvoke();
    if (invoke) {
      try {
        await invoke('native_overlay_start_drag');
        return;
      } catch (err) {}
    }
    if (window.__TAURI__?.window?.getCurrentWindow) {
      try {
        await window.__TAURI__.window.getCurrentWindow().startDragging();
      } catch (err) {}
    }
  };

  window.addEventListener('pointerdown', startDrag);

  // Unified document click delegation for dynamically rendered components
  document.addEventListener('click', (e) => {
    // 1. Model circular gauge card
    const card = e.target.closest('.gauge-card');
    if (card && !card.closest('#settings-panel')) {
      const modelKey = card.getAttribute('data-model-key');
      if (modelKey) {
        e.preventDefault();
        e.stopPropagation();
        window.toggleModelStats(modelKey);
      }
      return;
    }

    // 2. Stats panel close button (✕)
    const closeStats = e.target.closest('#btn-close-stats');
    if (closeStats) {
      e.preventDefault();
      e.stopPropagation();
      window.hideModelStats();
      return;
    }

    // 3. Settings gauge selection card
    const selectCard = e.target.closest('.gauge-select-card');
    if (selectCard) {
      const key = selectCard.getAttribute('data-gauge-key');
      if (key) {
        e.preventDefault();
        e.stopPropagation();
        window.toggleGaugeSelection(key);
      }
      return;
    }

    // 4. Offline notice retry button
    const retryBtn = e.target.closest('#btn-offline-retry');
    if (retryBtn) {
      e.preventDefault();
      e.stopPropagation();
      loadQuotas(true);
      return;
    }
  });

  // Window Drag-to-Resize Handle (Bottom-Right corner)
  const resizeHandle = document.getElementById('window-resize-handle');
  if (resizeHandle) {
    let isResizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      isResizing = true;
      startX = e.screenX;
      startY = e.screenY;
      startWidth = window.innerWidth;
      startHeight = window.innerHeight;
      resizeHandle.setPointerCapture(e.pointerId);
    });

    resizeHandle.addEventListener('pointermove', (e) => {
      if (!isResizing) return;
      e.preventDefault();
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      const newWidth = Math.max(120, Math.min(900, startWidth + dx));
      const newHeight = Math.max(64, Math.min(800, startHeight + dy));
      if (priorWindowSize) {
        priorWindowSize = {
          width: Math.max(120, newWidth),
          height: Math.max(64, newHeight - 200),
        };
      }
      setOverlaySize(newWidth, newHeight);
    });

    const stopResize = (e) => {
      if (isResizing) {
        isResizing = false;
        try {
          resizeHandle.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };
    resizeHandle.addEventListener('pointerup', stopResize);
    resizeHandle.addEventListener('pointercancel', stopResize);
  }
}

async function loadQuotas(forceRefresh = false) {
  console.log(`[quota] loadQuotas(forceRefresh=${forceRefresh}) starting...`);
  updateStatus('Updating quotas...', true);
  try {
    const rawQuotas = await pluginManager.fetchAllQuotas(forceRefresh);
    console.log(`[quota] pluginManager.fetchAllQuotas returned ${rawQuotas.length} item(s):`, rawQuotas);
    currentQuotas = rawQuotas.map(toDisplayAccount);
    console.log(`[quota] Transformed into ${currentQuotas.length} display account(s):`, currentQuotas);
    updateStatus('Live', false);
    renderCurrentTab();
    console.log('[quota] renderCurrentTab finished successfully.');
  } catch (err) {
    console.error('[quota] Failed to load quotas:', err);
    updateStatus('Sync error', false);
  }
}

function updateStatus(text, isBusy) {
  const statusEl = document.getElementById('status-text');
  if (statusEl) {
    statusEl.innerHTML = `
      <span class="w-1.5 h-1.5 rounded-full ${isBusy ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}"></span>
      <span>${esc(text)}</span>
    `;
  }
  const dotEl = document.getElementById('status-dot');
  if (dotEl) {
    dotEl.className = `w-2 h-2 rounded-full ${isBusy ? 'bg-amber-400 animate-ping' : 'bg-emerald-400 animate-pulse glow-green'} mr-1`;
    dotEl.title = text;
  }
}

/**
 * Main render function dispatching sequence of circular gauges for all models
 */
function renderCurrentTab() {
  const container = document.getElementById('quota-content');
  if (!container) return;

  let modelItems = [];

  // Show ALL models together as a unified sequence
  for (const acc of currentQuotas) {
    if (acc.llms && acc.llms.length > 0) {
      for (const llm of acc.llms) {
        modelItems.push({
          ...llm,
          uniqueKey: `${acc.providerId}_${llm.id}`,
          providerName: acc.providerName,
          status: acc.status === 'OK' ? llm.status : acc.status,
        });
      }
    } else if (acc.fiveHourQuota || acc.weeklyQuota) {
      modelItems.push({
        id: acc.providerId,
        uniqueKey: acc.providerId,
        name: acc.providerName,
        providerName: acc.providerName,
        status: acc.status,
        fiveHourQuota: acc.fiveHourQuota,
        weeklyQuota: acc.weeklyQuota,
      });
    }
  }

  const knownDefaults = [
    { id: 'gemini', uniqueKey: 'antigravity_gemini', name: 'Gemini', providerName: 'Google Antigravity' },
    { id: 'claude', uniqueKey: 'antigravity_claude', name: 'Claude', providerName: 'Google Antigravity' },
    { id: 'glm', uniqueKey: 'zcode_glm', name: 'GLM Coding Models', providerName: 'ZCode' },
    { id: 'zcode-mcp', uniqueKey: 'zcode_zcode-mcp', name: 'MCP & Web Tools', providerName: 'ZCode' },
    { id: 'opencode-go', uniqueKey: 'opencode_opencode-go', name: 'OpenCode Go', providerName: 'OpenCode' },
  ];

  const existingKeys = new Set(modelItems.map(m => m.uniqueKey || m.id));
  const mergedAll = [...modelItems];
  for (const km of knownDefaults) {
    if (!existingKeys.has(km.uniqueKey)) {
      mergedAll.push({
        ...km,
        status: 'OFFLINE',
        fiveHourQuota: null,
        weeklyQuota: null,
      });
    }
  }
  allAvailableModels = mergedAll;

  // Filter models based on user selection in settings
  let displayItems = modelItems;
  if (userSettings.selectedGauges && userSettings.selectedGauges.length > 0) {
    const selSet = new Set(userSettings.selectedGauges);
    const filtered = modelItems.filter(item => selSet.has(item.uniqueKey || item.id));
    if (filtered.length > 0) {
      displayItems = filtered;
    }
  }

  currentModelItems = displayItems;

  // Update dynamic AI tray icon with remaining token level
  let minPct = null;
  let summaries = [];
  for (const item of displayItems) {
    const p5 = item.fiveHourQuota?.percentage;
    const pw = item.weeklyQuota?.percentage;
    if (typeof p5 === 'number') {
      if (minPct === null || p5 < minPct) minPct = p5;
      summaries.push(`${item.name || item.id}: ${Math.round(p5)}%`);
    } else if (typeof pw === 'number') {
      if (minPct === null || pw < minPct) minPct = pw;
      summaries.push(`${item.name || item.id}: ${Math.round(pw)}%`);
    }
  }
  if (minPct !== null) {
    updateTrayIcon(minPct, `LLM Quota: ${summaries.join(' | ')}`);
  }

  // Check if any provider has an action prompt or offline notice
  const offlineAccounts = currentQuotas.filter(q => q.status === 'OFFLINE' || q.status === 'PROMPT_START');
  let noticeHtml = '';
  if (offlineAccounts.length > 0) {
    const item = offlineAccounts[0];
    noticeHtml = `
      <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-xs flex items-center justify-between gap-3" data-tauri-drag-region="false">
        <div class="flex items-center gap-2 truncate">
          <svg class="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <span class="truncate">${esc(item.actionPrompt || 'Antigravity IDE not active.')}</span>
        </div>
        <button id="btn-offline-retry" type="button" data-tauri-drag-region="false" class="shrink-0 px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-[11px] font-medium transition">
          Retry
        </button>
      </div>
    `;
  }

  if (displayItems.length === 0) {
    container.innerHTML = `
      ${noticeHtml}
      <div class="p-6 text-center text-neutral-400 text-xs space-y-2" data-tauri-drag-region="false">
        <p>No model gauges currently selected or active.</p>
        <p class="text-[11px] text-neutral-500">Configure gauges in Settings or start your IDE.</p>
      </div>
    `;
    return;
  }

  // Sequence of circular gauges — wrapping dynamically depending on window width without subheadings
  const gaugesHtml = displayItems.map(item => renderCircularGaugeCard(item)).join('');
  const selectedItem = selectedModelKey ? displayItems.find(m => (m.uniqueKey || m.id) === selectedModelKey) : null;
  const statsHtml = selectedItem ? renderStatsCard(selectedItem) : '';

  container.innerHTML = `
    <div class="flex-1 flex flex-col justify-between w-full" data-tauri-drag-region>
      ${noticeHtml ? `<div class="px-2.5 pt-1.5" data-tauri-drag-region>${noticeHtml}</div>` : ''}
      <div id="gauge-container" class="flex flex-nowrap justify-start items-center gap-2.5 px-3 pt-2 pb-1.5 overflow-hidden" data-tauri-drag-region>
        ${gaugesHtml}
      </div>
      <div id="stats-panel" class="${selectedItem ? '' : 'hidden'} w-full" data-tauri-drag-region="false">
        ${statsHtml}
      </div>
    </div>
  `;
}

/**
 * Render individual dual-arc circular gauge card (1/3 scale, 38px donut, logo only in center)
 */
function renderCircularGaugeCard(item) {
  const h5 = item.fiveHourQuota;
  const wk = item.weeklyQuota;

  let h5Pct = h5 && typeof h5.percentLeft === 'number' ? h5.percentLeft : null;
  const wkPct = wk && typeof wk.percentLeft === 'number' ? wk.percentLeft : null;

  // For MCP/tool quota, mirror the cycle percent on the left arc if 5h is absent
  if (h5Pct === null && item.mcpUsage && wkPct !== null) {
    h5Pct = wkPct;
  }

  const h5Color = getGaugeColor(h5Pct);
  const wkColor = getGaugeColor(wkPct);

  const h5Dash = h5Pct !== null ? `${h5Pct} 100` : '0 100';
  const wkDash = wkPct !== null ? `${wkPct} 100` : '0 100';

  let h5Short = '—';
  if (item.mcpUsage) {
    h5Short = String(item.mcpUsage.remaining);
  } else if (h5) {
    if (h5.resetsInSeconds > 0) {
      const hours = (h5.resetsInSeconds / 3600).toFixed(1);
      h5Short = `${hours}h`;
    } else if (h5.resetsAt) {
      h5Short = '0.0h';
    } else {
      h5Short = '—';
    }
  }

  let wkShort = '—';
  if (wk) {
    if (wk.resetsInSeconds > 0) {
      const days = wk.resetsInSeconds / 86400;
      wkShort = days >= 0.1 ? `${days.toFixed(1)}d` : `${(wk.resetsInSeconds / 3600).toFixed(1)}h`;
    } else {
      wkShort = 'Cap';
    }
  }

  const actualH5Pct = h5 && typeof h5.percentLeft === 'number' ? h5.percentLeft : null;
  const actualWkPct = wk && typeof wk.percentLeft === 'number' ? wk.percentLeft : null;

  const h5PctShort = actualH5Pct !== null ? `${Math.round(actualH5Pct)}%` : (item.mcpUsage ? '' : (actualWkPct === null ? '—' : ''));
  const wkPctShort = actualWkPct !== null ? `${Math.round(actualWkPct)}%` : '';

  const itemKey = item.uniqueKey || item.id;
  const isSelected = selectedModelKey === itemKey;
  const logoSvgContent = getModelSvgContent(item.id, item.name);
  const tooltip = item.mcpUsage
    ? `${item.name} (${item.providerName || ''})\n• Remaining calls: ${item.mcpUsage.remaining}/${item.mcpUsage.total} (${wkPct !== null ? `${wkPct.toFixed(0)}%` : 'N/A'})\n• Cycle reset: ${wk?.formattedCountdown || wkShort}\n\nClick to view stats`
    : `${item.name} (${item.providerName || ''})\n• 5-Hour: ${h5Pct !== null ? `${h5Pct.toFixed(0)}%` : 'N/A'} (reset: ${h5?.formattedCountdown || h5Short})\n• Weekly: ${wkPct !== null ? `${wkPct.toFixed(0)}%` : 'N/A'} (reset: ${wk?.formattedCountdown || wkShort})\n\nClick to view stats`;

  return `
    <button type="button" class="gauge-card ${isSelected ? 'gauge-selected' : ''}"
         data-model-key="${esc(itemKey)}"
         data-tauri-drag-region="false"
         title="${esc(tooltip)}">
      <div class="gauge-circle-wrap">
        <!-- Top-Left: 5-Hour Reset (with 1 decimal in Orange) -->
        <span class="gauge-corner-label gauge-corner-tl text-orange-400"
              data-resets-at="${esc(h5?.resetsAt || '')}" data-type="5h">
          ${esc(h5Short)}
        </span>

        <!-- Top-Right: Weekly Reset (days with 1 decimal) -->
        <span class="gauge-corner-label gauge-corner-tr text-emerald-300"
              data-resets-at="${esc(wk?.resetsAt || '')}" data-type="wk">
          ${esc(wkShort)}
        </span>

        <!-- 1/3 Scale Circular Donut Gauge SVG (38x38px) -->
        <svg class="gauge-svg" viewBox="0 0 100 100">
          <!-- Left Semicircle (5-Hour): Track (grey) and Active Fill (colored arc) -->
          <path d="M 46 14 A 36 36 0 0 0 46 86" class="gauge-track" />
          <path d="M 46 14 A 36 36 0 0 0 46 86" class="gauge-fill ${h5Color.glow}" stroke="${h5Color.stroke}" pathLength="100" stroke-dasharray="${h5Dash}" />

          <!-- Right Semicircle (Weekly): Track (grey) and Active Fill (colored arc) -->
          <path d="M 54 14 A 36 36 0 0 1 54 86" class="gauge-track" />
          <path d="M 54 14 A 36 36 0 0 1 54 86" class="gauge-fill ${wkColor.glow}" stroke="${wkColor.stroke}" pathLength="100" stroke-dasharray="${wkDash}" />

          <!-- Center Logo: Enlarged by 25% to physically bleed into the donut stroke at (50, 50) -->
          <g class="gauge-center-logo">
            ${logoSvgContent}
          </g>
        </svg>

        <!-- Bottom-Left: 5-Hour % in Grey Letters (bleeding / overlapping the donut) -->
        ${h5PctShort ? `<span class="gauge-corner-label gauge-corner-bl text-neutral-400">${esc(h5PctShort)}</span>` : ''}

        <!-- Bottom-Right: Weekly % in Grey Letters (bleeding / overlapping the donut) -->
        ${wkPctShort ? `<span class="gauge-corner-label gauge-corner-br text-neutral-400">${esc(wkPctShort)}</span>` : ''}
      </div>
    </button>
  `;
}

/**
 * Renders the full-width stats panel card for a clicked model
 */
function renderStatsCard(item) {
  if (!item) return '';
  const h5 = item.fiveHourQuota;
  const wk = item.weeklyQuota;

  let h5Pct = h5 && typeof h5.percentLeft === 'number' ? h5.percentLeft : null;
  const wkPct = wk && typeof wk.percentLeft === 'number' ? wk.percentLeft : null;

  if (h5Pct === null && item.mcpUsage && wkPct !== null) {
    h5Pct = wkPct;
  }

  const h5Color = h5Pct !== null ? (h5Pct > 50 ? 'text-emerald-400' : h5Pct >= 20 ? 'text-amber-400' : 'text-rose-400') : 'text-neutral-400';
  const wkColor = wkPct !== null ? (wkPct > 50 ? 'text-emerald-400' : wkPct >= 20 ? 'text-amber-400' : 'text-rose-400') : 'text-neutral-400';

  const h5BarColor = h5Pct !== null ? (h5Pct > 50 ? 'bg-emerald-500' : h5Pct >= 20 ? 'bg-amber-500' : 'bg-rose-500') : 'bg-neutral-600';
  const wkBarColor = wkPct !== null ? (wkPct > 50 ? 'bg-emerald-500' : wkPct >= 20 ? 'bg-amber-500' : 'bg-rose-500') : 'bg-neutral-600';

  const h5Countdown = h5?.formattedCountdown || (h5?.resetsInSeconds ? `${(h5.resetsInSeconds / 3600).toFixed(1)}h` : '—');
  const h5ResetTime = h5?.formattedResetTime || '—';
  const wkCountdown = wk?.formattedCountdown || (wk?.resetsInSeconds ? `${Math.round(wk.resetsInSeconds / 3600)}h` : '—');
  const wkResetTime = wk?.formattedResetTime || '—';

  const mcpSection = item.mcpUsage ? `
    <div class="p-2 rounded-lg bg-white/[0.04] border border-white/5 text-xs flex items-center justify-between">
      <span class="text-neutral-400">MCP Tool Calls:</span>
      <span class="font-mono text-cyan-300 font-semibold">${esc(item.mcpUsage.remaining)} / ${esc(item.mcpUsage.total)} remaining</span>
    </div>
  ` : '';

  return `
    <div class="stats-flush-panel space-y-2 w-full relative" data-tauri-drag-region="false">
      <!-- Close button in top-right of stats panel -->
      <button id="btn-close-stats" type="button" data-tauri-drag-region="false" title="Close details" class="absolute top-1.5 right-2 text-neutral-400 hover:text-white px-1 py-0.5 text-xs font-bold leading-none transition z-10">✕</button>

      <!-- 2-Column Quota Breakdown (No heading, no provider, no auto-hides) -->
      <div class="grid grid-cols-2 gap-2 text-xs pr-4">
        <!-- 5-Hour Limit -->
        <div class="p-2 rounded-lg bg-white/[0.04] border border-white/5 space-y-1">
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-neutral-400">5-Hour Quota</span>
            <span class="font-mono font-bold ${h5Color}">${h5Pct !== null ? `${Math.round(h5Pct)}%` : '—'}</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill ${h5BarColor}" style="width: ${h5Pct !== null ? h5Pct : 0}%"></div>
          </div>
          <div class="flex items-center justify-between text-[10px] text-neutral-400 font-mono">
            <span>Reset:</span>
            <span>${esc(h5Countdown)} ${esc(h5ResetTime)}</span>
          </div>
        </div>

        <!-- Weekly Limit -->
        <div class="p-2 rounded-lg bg-white/[0.04] border border-white/5 space-y-1">
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-neutral-400">Weekly Quota</span>
            <span class="font-mono font-bold ${wkColor}">${wkPct !== null ? `${Math.round(wkPct)}%` : '—'}</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill ${wkBarColor}" style="width: ${wkPct !== null ? wkPct : 0}%"></div>
          </div>
          <div class="flex items-center justify-between text-[10px] text-neutral-400 font-mono">
            <span>Reset:</span>
            <span>${esc(wkCountdown)} ${esc(wkResetTime)}</span>
          </div>
        </div>
      </div>

      ${mcpSection}

      <!-- 15-Second Animated Draining Bar -->
      <div class="w-full bg-white/5 h-[2px] rounded-full overflow-hidden mt-0.5">
        <div class="stats-timer-bar"></div>
      </div>
    </div>
  `;
}

let priorWindowSize = null;

async function getWindowSize() {
  const invoke = getInvoke();
  if (invoke) {
    try {
      const [w, h] = await invoke('native_overlay_get_size');
      if (w > 0 && h > 0) return { width: w, height: h };
    } catch (e) {}
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Toggles or opens model details stats panel with automatic window expansion
 * Expands to at least 480px width and at least 230px height, returning to prior size on dismiss
 */
window.toggleModelStats = async function(modelKey) {
  console.log('[stats] toggleModelStats called for:', modelKey);
  if (selectedModelKey === modelKey) {
    window.hideModelStats();
    return;
  }

  // Expand window on first open
  if (!selectedModelKey) {
    const currentSize = await getWindowSize();
    console.log('[stats] current window size before expand:', currentSize);
    priorWindowSize = { width: currentSize.width, height: currentSize.height };

    const targetWidth = Math.max(480, currentSize.width);
    const targetHeight = Math.max(230, currentSize.height + 150);

    const invoke = getInvoke();
    if (invoke) {
      invoke('set_window_expanded_mode', { expanded: true }).catch(() => {});
    }
    setOverlaySize(targetWidth, targetHeight);
  }

  selectedModelKey = modelKey;
  const panel = document.getElementById('stats-panel');
  const targetItem = (currentModelItems || []).find(m => (m.uniqueKey || m.id) === modelKey)
    || (allAvailableModels || []).find(m => (m.uniqueKey || m.id) === modelKey);
  console.log('[stats] targetItem for panel:', targetItem ? targetItem.name : 'NOT FOUND');
  if (panel && targetItem) {
    panel.innerHTML = renderStatsCard(targetItem);
    panel.classList.remove('hidden');
  }
  document.querySelectorAll('.gauge-card').forEach(el => {
    el.classList.toggle('gauge-selected', el.getAttribute('data-model-key') === modelKey);
  });
  if (statsTimeout) clearTimeout(statsTimeout);
  statsTimeout = setTimeout(() => {
    window.hideModelStats();
  }, 15000);
};

/**
 * Hides model stats panel, clears timer, and returns window to prior size
 */
window.hideModelStats = function() {
  console.log('[stats] hideModelStats called');
  selectedModelKey = null;
  if (statsTimeout) {
    clearTimeout(statsTimeout);
    statsTimeout = null;
  }
  const panel = document.getElementById('stats-panel');
  if (panel) {
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }
  document.querySelectorAll('.gauge-card').forEach(el => {
    el.classList.remove('gauge-selected');
  });

  // Restore prior window size
  if (priorWindowSize) {
    console.log('[stats] restoring priorWindowSize:', priorWindowSize);
    setOverlaySize(priorWindowSize.width, priorWindowSize.height);
    priorWindowSize = null;
  }

  const invoke = getInvoke();
  if (invoke) {
    invoke('set_window_expanded_mode', { expanded: false }).catch(() => {});
  }
};

/**
 * Render individual gauge selector card with top-right checkbox replacing weekly reset
 */
function renderGaugeSelectCard(item, isChecked) {
  const h5 = item.fiveHourQuota;
  const wk = item.weeklyQuota;

  let h5Pct = h5 && typeof h5.percentLeft === 'number' ? h5.percentLeft : null;
  const wkPct = wk && typeof wk.percentLeft === 'number' ? wk.percentLeft : null;

  if (h5Pct === null && item.mcpUsage && wkPct !== null) {
    h5Pct = wkPct;
  }

  const h5Color = getGaugeColor(h5Pct);
  const wkColor = getGaugeColor(wkPct);

  const h5Dash = h5Pct !== null ? `${h5Pct} 100` : '0 100';
  const wkDash = wkPct !== null ? `${wkPct} 100` : '0 100';

  let h5Short = '—';
  if (item.mcpUsage) {
    h5Short = String(item.mcpUsage.remaining);
  } else if (h5) {
    if (h5.resetsInSeconds > 0) {
      const hours = (h5.resetsInSeconds / 3600).toFixed(1);
      h5Short = `${hours}h`;
    } else if (h5.resetsAt) {
      h5Short = '0.0h';
    } else {
      h5Short = '—';
    }
  }

  const pctValue = h5Pct !== null ? Math.round(h5Pct) : (wkPct !== null ? Math.round(wkPct) : null);
  const pctShort = pctValue !== null ? `${pctValue}%` : '—';

  const itemKey = item.uniqueKey || item.id;
  const logoSvgContent = getModelSvgContent(item.id, item.name);

  return `
    <div class="gauge-select-card ${isChecked ? 'is-selected' : ''}"
         data-gauge-key="${esc(itemKey)}"
         data-tauri-drag-region="false"
         title="${esc(item.name || item.id)} (${esc(item.providerName || '')}) - Click to toggle">
      <div class="gauge-circle-wrap">
        <!-- Top-Left: 5-Hour Reset in Orange -->
        <span class="gauge-corner-label gauge-corner-tl text-orange-400">
          ${esc(h5Short)}
        </span>

        <!-- Top-Right: Little Checkbox replacing weekly limit -->
        <div class="gauge-corner-checkbox ${isChecked ? 'checked' : ''}">
          ${isChecked ? `<svg class="w-2.5 h-2.5 text-neutral-950" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7"/></svg>` : ''}
        </div>

        <!-- 1/3 Scale Circular Donut Gauge SVG (38x38px) -->
        <svg class="gauge-svg" viewBox="0 0 100 100">
          <!-- Left Semicircle (5-Hour) -->
          <path d="M 46 14 A 36 36 0 0 0 46 86" class="gauge-track" />
          <path d="M 46 14 A 36 36 0 0 0 46 86" class="gauge-fill ${h5Color.glow}" stroke="${h5Color.stroke}" pathLength="100" stroke-dasharray="${h5Dash}" />

          <!-- Right Semicircle (Weekly) -->
          <path d="M 54 14 A 36 36 0 0 1 54 86" class="gauge-track" />
          <path d="M 54 14 A 36 36 0 0 1 54 86" class="gauge-fill ${wkColor.glow}" stroke="${wkColor.stroke}" pathLength="100" stroke-dasharray="${wkDash}" />

          <!-- Center Logo -->
          <g class="gauge-center-logo">
            ${logoSvgContent}
          </g>
        </svg>

        <!-- Bottom-Left: % in Grey Letters -->
        <span class="gauge-corner-label gauge-corner-bl text-neutral-400">
          ${esc(pctShort)}
        </span>
      </div>
      <div class="gauge-select-label">${esc(item.name || item.id)}</div>
    </div>
  `;
}

/**
 * Renders the Settings panel view with Select Gauges, Window Settings, and API Keys
 */
/**
 * Monochrome SVG Icons for password visibility
 */
const svgEye = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
const svgEyeSlash = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>`;

/**
 * Toggle password/text visibility for API key input with monochrome SVG icon
 */
window.toggleKeyVisibility = function(inputId, btnId) {
  const el = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!el) return;
  const isNowText = el.type === 'password';
  el.type = isNowText ? 'text' : 'password';
  if (btn) {
    btn.innerHTML = isNowText ? svgEyeSlash : svgEye;
  }
};

/**
 * Renders the Settings panel view with Select Gauges, Window Settings, and API Keys
 */
function renderSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;

  const gaugesHtml = allAvailableModels.map(item => {
    const itemKey = item.uniqueKey || item.id;
    const isChecked = tempSelectedGauges.has(itemKey);
    return renderGaugeSelectCard(item, isChecked);
  }).join('');

  panel.innerHTML = `
    <!-- Settings Header (No [X] at top per spec) -->
    <div class="settings-header">
      <div class="settings-title">
        <svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>Settings</span>
      </div>
    </div>

    <!-- Section 1: Select Gauges -->
    <div class="settings-section">
      <div class="flex justify-between items-center">
        <div class="settings-section-title">Select Gauges</div>
        <span id="settings-gauge-count" class="text-[10px] text-neutral-400 font-mono">${tempSelectedGauges.size} / ${allAvailableModels.length} selected</span>
      </div>
      <div class="settings-section-subtitle">
        Choose which model gauges to display on the desktop overlay.
      </div>
      <div class="gauge-selector-grid">
        ${gaugesHtml || '<div class="text-xs text-neutral-400 py-2">No models discovered yet. Start your IDE or configure an API key.</div>'}
      </div>
    </div>

    <!-- Section 2: Window Settings -->
    <div class="settings-section">
      <div class="settings-section-title">Window Settings</div>
      <div class="grid grid-cols-2 gap-3 pt-1">
        <!-- Opacity -->
        <div class="space-y-1">
          <div class="flex justify-between items-center text-xs">
            <span class="text-neutral-300 font-medium">Window Opacity:</span>
            <span id="settings-label-opacity" class="font-mono text-cyan-300 font-bold">${Math.round(baseOpacity * 100)}%</span>
          </div>
          <input type="range" id="settings-slider-opacity" min="0.2" max="1.0" step="0.01" value="${baseOpacity}" class="settings-slider">
        </div>

        <!-- Pin -->
        <div class="space-y-1">
          <div class="text-xs text-neutral-300 font-medium">Pin on Top:</div>
          <button id="settings-btn-pin" type="button" data-tauri-drag-region="false" class="settings-toggle-btn ${isPinned ? 'active' : ''} w-full justify-center">
            <svg class="w-3.5 h-3.5 ${isPinned ? 'text-cyan-400' : 'text-neutral-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            <span>Floating (${isPinned ? 'ON' : 'OFF'})</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Section 3: API Keys -->
    <div class="settings-section">
      <div class="flex justify-between items-center">
        <div class="settings-section-title">API Keys</div>
        <span class="text-[9px] text-neutral-500 font-mono">~/.llm-gauge.json</span>
      </div>

      <!-- Gemini auto-detected notice -->
      <div class="p-2 rounded-lg bg-white/[0.03] border border-white/5 flex items-center gap-2 text-xs">
        <svg class="w-4 h-4 text-cyan-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
        <div class="flex-1 text-neutral-300 text-[11px]">
          <span class="font-semibold text-white">Google Antigravity (Gemini & Claude):</span> Auto-detected from local IDE session. No API key required.
        </div>
      </div>

      <!-- ZCode API Key (no individual save button, monochrome toggle icon) -->
      <div class="space-y-1 pt-1">
        <div class="flex justify-between items-center text-xs">
          <label class="text-neutral-300 font-medium">ZCode (GLM & MCP Tools)</label>
        </div>
        <div class="flex items-center gap-2">
          <input type="password" id="input-key-zcode" value="${esc(apiKeys.zcode || '')}" placeholder="Enter ZCode API Key..." class="settings-input flex-1">
          <button type="button" id="btn-toggle-zcode" title="Toggle key visibility" class="px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white transition flex items-center justify-center shrink-0">
            ${svgEye}
          </button>
        </div>
      </div>

      <!-- OpenCode API Key (no individual save button, monochrome toggle icon) -->
      <div class="space-y-1 pt-1">
        <div class="flex justify-between items-center text-xs">
          <label class="text-neutral-300 font-medium">OpenCode</label>
        </div>
        <div class="flex items-center gap-2">
          <input type="password" id="input-key-opencode" value="${esc(apiKeys.opencode || '')}" placeholder="Enter OpenCode API token..." class="settings-input flex-1">
          <button type="button" id="btn-toggle-opencode" title="Toggle key visibility" class="px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white transition flex items-center justify-center shrink-0">
            ${svgEye}
          </button>
        </div>
      </div>
    </div>

    <!-- Form Footer Actions (Bottom of Form: Cancel & Save) -->
    <div class="flex justify-between items-center pt-3 pb-1 border-t border-white/10 mt-1 sticky bottom-0 bg-[#121218]/95 backdrop-blur-md">
      <button type="button" id="settings-btn-cancel" class="settings-btn-secondary">Cancel</button>
      <button type="button" id="settings-btn-save" class="settings-btn-primary">Save Changes</button>
    </div>
  `;

  // Attach explicit click event listeners for buttons
  const btnToggleZ = document.getElementById('btn-toggle-zcode');
  if (btnToggleZ) {
    btnToggleZ.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.toggleKeyVisibility('input-key-zcode', 'btn-toggle-zcode');
    });
  }

  const btnToggleOpen = document.getElementById('btn-toggle-opencode');
  if (btnToggleOpen) {
    btnToggleOpen.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.toggleKeyVisibility('input-key-opencode', 'btn-toggle-opencode');
    });
  }

  const btnPin = document.getElementById('settings-btn-pin');
  if (btnPin) {
    btnPin.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.togglePinSetting();
    });
  }

  const btnCancel = document.getElementById('settings-btn-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.cancelSettings();
    });
  }

  const btnSave = document.getElementById('settings-btn-save');
  if (btnSave) {
    btnSave.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.saveAllSettings();
    });
  }

  // Attach dynamic event listeners for Settings Opacity slider preview
  const slider = document.getElementById('settings-slider-opacity');
  const label = document.getElementById('settings-label-opacity');
  if (slider) {
    slider.addEventListener('input', (e) => {
      baseOpacity = parseFloat(e.target.value);
      if (label) label.textContent = `${Math.round(baseOpacity * 100)}%`;
      setWindowOpacity(baseOpacity);
    });
  }
}

/**
 * Open Settings panel and expand window
 */
window.openSettings = async function() {
  if (isSettingsOpen) return;
  isSettingsOpen = true;

  if (activeCloseMenu) activeCloseMenu();
  if (isLogsOpen) window.closeLogs();
  window.hideModelStats();

  const currentSize = await getWindowSize();
  priorSettingsWindowSize = { width: currentSize.width, height: currentSize.height };
  console.log('[settings] openSettings: recorded priorSettingsWindowSize:', priorSettingsWindowSize);

  // Extend window dimensions higher and wider so all settings content and 'Save Changes' footer are fully visible
  const targetWidth = Math.max(520, currentSize.width);
  const targetHeight = Math.max(580, currentSize.height + 250);

  const invoke = getInvoke();
  if (invoke) {
    invoke('set_window_expanded_mode', { expanded: true }).catch(() => {});
  }
  setOverlaySize(targetWidth, targetHeight);

  await loadUserSettings();

  // If user has not configured any selectedGauges, default to selecting all discovered models
  const allKeys = allAvailableModels.map(m => m.uniqueKey || m.id);
  if (!userSettings.selectedGauges || userSettings.selectedGauges.length === 0) {
    tempSelectedGauges = new Set(allKeys);
  } else {
    tempSelectedGauges = new Set(userSettings.selectedGauges);
  }

  renderSettingsPanel();

  const quotaContent = document.getElementById('quota-content');
  const settingsPanel = document.getElementById('settings-panel');
  if (quotaContent) quotaContent.classList.add('hidden');
  if (settingsPanel) settingsPanel.classList.remove('hidden');
};

/**
 * Close Settings panel and restore window size
 */
window.closeSettings = function() {
  if (!isSettingsOpen) return;
  isSettingsOpen = false;

  const quotaContent = document.getElementById('quota-content');
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel) {
    settingsPanel.innerHTML = '';
    settingsPanel.classList.add('hidden');
  }
  if (quotaContent) quotaContent.classList.remove('hidden');

  const restoreWidth = priorSettingsWindowSize?.width || 320;
  const restoreHeight = priorSettingsWindowSize?.height || 76;
  console.log('[settings] closeSettings: restoring size:', restoreWidth, restoreHeight);
  setOverlaySize(restoreWidth, restoreHeight);
  priorSettingsWindowSize = null;

  const invoke = getInvoke();
  if (invoke) {
    invoke('set_window_expanded_mode', { expanded: false }).catch(() => {});
  }
};

/**
 * Toggle gauge selection checkbox in-place without rebuilding inputs
 */
window.toggleGaugeSelection = function(modelKey) {
  if (tempSelectedGauges.has(modelKey)) {
    tempSelectedGauges.delete(modelKey);
  } else {
    tempSelectedGauges.add(modelKey);
  }
  const card = document.querySelector(`.gauge-select-card[data-gauge-key="${modelKey}"]`);
  if (card) {
    const isChecked = tempSelectedGauges.has(modelKey);
    card.classList.toggle('is-selected', isChecked);
    const cb = card.querySelector('.gauge-corner-checkbox');
    if (cb) {
      cb.classList.toggle('checked', isChecked);
      cb.innerHTML = isChecked ? `<svg class="w-2.5 h-2.5 text-neutral-950" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7"/></svg>` : '';
    }
  }
  const countEl = document.getElementById('settings-gauge-count');
  if (countEl) {
    countEl.textContent = `${tempSelectedGauges.size} / ${allAvailableModels.length} selected`;
  }
};

/**
 * Save all settings (gauges, API keys, opacity, pin) from bottom Save button,
 * closes settings panel, and restores prior window dimensions.
 */
window.saveAllSettings = async function() {
  console.log('[settings] saveAllSettings triggered');
  const invoke = getInvoke();

  // 1. Commit gauge selection
  const selectedList = Array.from(tempSelectedGauges);
  userSettings.selectedGauges = selectedList;

  // 2. Read and save API keys from form inputs
  let keysChanged = false;
  const zKeyInput = document.getElementById('input-key-zcode');
  if (zKeyInput) {
    const zKey = zKeyInput.value.trim();
    if (zKey !== (apiKeys.zcode || '')) {
      apiKeys.zcode = zKey;
      keysChanged = true;
      if (invoke) {
        try {
          await invoke('save_api_key', { provider: 'zcode', key: zKey });
        } catch (e) {
          console.error('[settings] Failed to save zcode API key:', e);
        }
      }
    }
  }

  const openKeyInput = document.getElementById('input-key-opencode');
  if (openKeyInput) {
    const openKey = openKeyInput.value.trim();
    if (openKey !== (apiKeys.opencode || '')) {
      apiKeys.opencode = openKey;
      keysChanged = true;
      if (invoke) {
        try {
          await invoke('save_api_key', { provider: 'opencode', key: openKey });
        } catch (e) {
          console.error('[settings] Failed to save opencode API key:', e);
        }
      }
    }
  }

  // Invalidate configuration cache so plugins immediately pick up fresh keys
  clearConfigCache();

  // 3. Save all settings (selected gauges, opacity, pin)
  await saveUserSettings({
    selectedGauges: selectedList,
    opacity: baseOpacity,
    pinned: isPinned,
  });

  // 4. Close settings and adjust window to size of before
  window.closeSettings();

  // 5. Re-render UI and refresh quotas
  renderCurrentTab();
  loadQuotas(true);
};

/**
 * Cancel settings: discards unsaved choices, closes settings, and restores prior window size.
 */
window.cancelSettings = function() {
  console.log('[settings] cancelSettings triggered');
  tempSelectedGauges = new Set(userSettings.selectedGauges || []);

  if (userSettings.opacity !== undefined && userSettings.opacity !== baseOpacity) {
    baseOpacity = userSettings.opacity;
    setWindowOpacity(baseOpacity);
  }

  if (userSettings.pinned !== undefined && userSettings.pinned !== isPinned) {
    isPinned = userSettings.pinned;
    const invoke = getInvoke();
    if (invoke) {
      invoke('native_overlay_set_pinned', { pinned: isPinned }).catch(() => {});
    }
  }

  // Close settings and adjust window to size of before
  window.closeSettings();
};

window.saveGaugeSelection = window.saveAllSettings;
window.cancelGaugeSelection = window.cancelSettings;

/**
 * Toggle Pin on Top setting
 */
window.togglePinSetting = function() {
  isPinned = !isPinned;
  const btn = document.getElementById('settings-btn-pin');
  if (btn) {
    btn.className = `settings-toggle-btn ${isPinned ? 'active' : ''} w-full justify-center`;
    btn.innerHTML = `
      <svg class="w-3.5 h-3.5 ${isPinned ? 'text-cyan-400' : 'text-neutral-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
      <span>Floating (${isPinned ? 'ON' : 'OFF'})</span>
    `;
  }
  const invoke = getInvoke();
  if (invoke) {
    invoke('native_overlay_set_pinned', { pinned: isPinned }).catch(() => {});
  }
};


/**
 * Updates countdown timestamps in-place every second
 */
function tickCountdowns() {
  document.querySelectorAll('[data-resets-at]').forEach((el) => {
    const resetsAt = el.getAttribute('data-resets-at');
    const type = el.getAttribute('data-type');
    if (!resetsAt) return;

    const diffMs = new Date(resetsAt).getTime() - Date.now();
    const diffSecs = Math.max(0, Math.floor(diffMs / 1000));

    if (diffSecs > 0) {
      if (type === '5h') {
        const hours = (diffSecs / 3600).toFixed(1);
        el.textContent = `${hours}h`;
      } else if (type === 'wk') {
        const days = diffSecs / 86400;
        el.textContent = days >= 0.1 ? `${days.toFixed(1)}d` : `${(diffSecs / 3600).toFixed(1)}h`;
      } else {
        const days = Math.floor(diffSecs / 86400);
        const hours = Math.floor((diffSecs % 86400) / 3600);
        const mins = Math.floor((diffSecs % 3600) / 60);
        el.textContent = days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : `${mins}m`;
      }
    } else {
      el.textContent = type === '5h' ? '0.0h' : 'Cap';
    }
  });
}

// --- In-App Console Logs Viewer ---

function entryToHtml(entry) {
  let badgeColor = 'text-cyan-400 bg-cyan-950/60 border-cyan-700/40';
  if (entry.level === 'warn') badgeColor = 'text-amber-400 bg-amber-950/60 border-amber-700/40';
  if (entry.level === 'error') badgeColor = 'text-rose-400 bg-rose-950/60 border-rose-700/40';

  return `
    <div class="log-row flex items-start gap-1.5 px-1 py-0.5 rounded hover:bg-white/[0.04]">
      <span class="text-neutral-500 text-[9.5px] font-mono shrink-0 select-none">${esc(entry.time)}</span>
      <span class="px-1 rounded text-[8.5px] font-semibold border ${badgeColor} uppercase shrink-0 select-none">${esc(entry.level)}</span>
      <span class="text-neutral-200 break-all whitespace-pre-wrap flex-1 text-[10.5px] font-mono">${esc(entry.text)}</span>
    </div>
  `;
}

function appendLogToDom(entry) {
  const body = document.getElementById('logs-body');
  if (!body) return;
  const div = document.createElement('div');
  div.innerHTML = entryToHtml(entry).trim();
  body.appendChild(div.firstElementChild || div);
  const badge = document.getElementById('logs-count-badge');
  if (badge) badge.textContent = `${logBuffer.length} logs`;
  scrollLogsToBottom();
}

function scrollLogsToBottom() {
  const body = document.getElementById('logs-body');
  if (body) {
    body.scrollTop = body.scrollHeight;
  }
}

function renderLogsPanel() {
  const panel = document.getElementById('logs-panel');
  if (!panel) return;

  const count = logBuffer.length;
  const hasInvoke = !!getInvoke();

  panel.innerHTML = `
    <div class="logs-header flex items-center justify-between pb-2 border-b border-white/10 shrink-0">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span class="font-bold text-xs text-white">Console Logs</span>
        <span id="logs-count-badge" class="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-neutral-300">${count} logs</span>
      </div>
      <div class="flex items-center gap-1.5" data-tauri-drag-region="false">
        ${hasInvoke ? `
          <button id="btn-open-devtools" type="button" data-tauri-drag-region="false" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-neutral-300 hover:text-white text-[10px] font-medium transition" title="Open Webview DevTools">
            DevTools
          </button>
        ` : ''}
        <button id="btn-copy-logs" type="button" data-tauri-drag-region="false" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-neutral-300 hover:text-white text-[10px] font-medium transition" title="Copy all logs">
          Copy
        </button>
        <button id="btn-clear-logs" type="button" data-tauri-drag-region="false" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-neutral-300 hover:text-white text-[10px] font-medium transition" title="Clear console buffer">
          Clear
        </button>
        <button id="btn-close-logs" type="button" data-tauri-drag-region="false" class="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10 transition" title="Close Logs">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
    <div id="logs-body" class="logs-terminal flex-1 overflow-y-auto mt-2 p-2 rounded-lg bg-black/50 border border-white/5 font-mono text-[10.5px] leading-relaxed select-text space-y-0.5" data-tauri-drag-region="false">
      ${logBuffer.length > 0 ? logBuffer.map(entryToHtml).join('') : '<div class="text-neutral-500 text-center py-4">No console logs recorded yet.</div>'}
    </div>
  `;

  document.getElementById('btn-open-devtools')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.openDevTools();
  });
  document.getElementById('btn-copy-logs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.copyLogs();
  });
  document.getElementById('btn-clear-logs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.clearLogs();
  });
  document.getElementById('btn-close-logs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.closeLogs();
  });
}

window.toggleLogs = async function() {
  if (isLogsOpen) {
    window.closeLogs();
  } else {
    await window.openLogs();
  }
};

window.openLogs = async function() {
  if (isLogsOpen) return;
  isLogsOpen = true;

  if (activeCloseMenu) activeCloseMenu();
  if (isSettingsOpen) window.closeSettings();
  window.hideModelStats();

  const currentSize = await getWindowSize();
  priorLogsWindowSize = { width: currentSize.width, height: currentSize.height };

  const targetWidth = Math.max(540, currentSize.width);
  const targetHeight = Math.max(420, currentSize.height);

  const invoke = getInvoke();
  if (invoke) {
    invoke('set_window_expanded_mode', { expanded: true }).catch(() => {});
  }
  setOverlaySize(targetWidth, targetHeight);

  renderLogsPanel();

  const quotaContent = document.getElementById('quota-content');
  const logsPanel = document.getElementById('logs-panel');
  if (quotaContent) quotaContent.classList.add('hidden');
  if (logsPanel) logsPanel.classList.remove('hidden');
  scrollLogsToBottom();
  console.log('[logs] Console logs panel opened.');
};

window.closeLogs = function() {
  if (!isLogsOpen) return;
  isLogsOpen = false;

  const quotaContent = document.getElementById('quota-content');
  const logsPanel = document.getElementById('logs-panel');
  if (logsPanel) {
    logsPanel.innerHTML = '';
    logsPanel.classList.add('hidden');
  }
  if (quotaContent) quotaContent.classList.remove('hidden');

  if (priorLogsWindowSize) {
    setOverlaySize(priorLogsWindowSize.width, priorLogsWindowSize.height);
    priorLogsWindowSize = null;
  }

  const invoke = getInvoke();
  if (invoke) {
    invoke('set_window_expanded_mode', { expanded: false }).catch(() => {});
  }
  console.log('[logs] Console logs panel closed.');
};

window.copyLogs = async function() {
  const plain = logBuffer.map(e => `[${e.time}] [${e.level.toUpperCase()}] ${e.text}`).join('\n');
  try {
    await navigator.clipboard.writeText(plain);
    const btn = document.getElementById('btn-copy-logs');
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 1500);
    }
  } catch (err) {
    console.error('Failed to copy logs to clipboard:', err);
  }
};

window.clearLogs = function() {
  logBuffer.length = 0;
  const body = document.getElementById('logs-body');
  if (body) body.innerHTML = '<div class="text-neutral-500 text-center py-4">Console cleared.</div>';
  const badge = document.getElementById('logs-count-badge');
  if (badge) badge.textContent = '0 logs';
};

window.openDevTools = async function() {
  const invoke = getInvoke();
  if (invoke) {
    try {
      await invoke('open_devtools');
      console.log('[devtools] Native devtools window requested.');
    } catch (err) {
      console.warn('[devtools] invoke open_devtools failed:', err);
    }
  }
};
