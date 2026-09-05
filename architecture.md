# LLM Gauge Tracker — System Architecture & Design Decisions

This document tracks the technical architecture, design principles, integration contracts, and future migration roadmap for the **LLM Quota Tracker**.

---

## 1. Vision & Core Principles

The LLM Quota Tracker provides developers with instant, real-time visibility into their coding agent quotas across multiple providers and accounts. It focuses on the two most critical usage constraints:
1. **Rolling 5-Hour Session Quota** (e.g., prompt quotas that reset after a sliding window).
2. **Weekly / Tier Limits** (e.g., weekly hard caps, plan credit allowances).

### Design Principles
- **JavaScript-First Business Logic**: All quota fetching, token discovery, endpoint probing, and data normalization live in modern JavaScript (ES Modules). This ensures business logic can run identically in the Node.js CLI runner and inside webview frontends.
- **Strictly Functional Rust Backend (Tauri)**: The Rust layer does not contain agent-specific scraping or quota logic. It acts purely as a high-performance system relay: executing low-level system checks (`lsof`, process inspection) and an HTTP proxy (`danger_accept_invalid_certs`) to bypass browser CORS and self-signed certificate rejections on localhost.
- **Zero Heavy Frameworks**: Vanilla JavaScript and Tailwind CSS. No React/Vue/Svelte overhead, guaranteeing instantaneous startup (<100ms) and minimal RAM consumption (<30MB).
- **Graceful Degradation**: If one provider is unauthenticated, offline, or experiencing rate limits, it never blocks or crashes the tracking of other agents.

---

## 2. Component Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                          PRESENTATION LAYER                            │
│                                                                        │
│   ┌──────────────────────────────┐    ┌────────────────────────────┐   │
│   │         Terminal CLI         │    │      Web-Overlay HUD       │   │
│   │          (cli.js)            │    │  (index.html + app.js)     │   │
│   └──────────────┬───────────────┘    └─────────────┬──────────────┘   │
└──────────────────┼──────────────────────────────────┼──────────────────┘
                   ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        VIEW-MODEL LAYER (viewmodel.js)                 │
│  Normalizes multi-pool quotas (Gemini vs Claude) into unified widgets │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      PLUGIN MANAGER (plugins/index.js)                 │
│   - TTL Cache Layer (60s) to prevent monitoring API self-exhaustion    │
│   - Parallel Fetch Executor (Promise.all)                              │
│   - Config Resolver (src/config.js: ~/.llm-quota, env, agent configs)  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│ Antigravity  │             │    ZCode     │             │   OpenCode   │
│    Plugin    │             │    Plugin    │             │    Plugin    │
└──────┬───────┘             └──────┬───────┘             └──────┬───────┘
       │                            │                            │
       │ (Loopback HTTPS)           │ (Bearer API)               │ (Session API)
       ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│  Language    │             │     Z.ai     │             │   OpenCode   │
│    Server    │             │  Cloud API   │             │   Platform   │
└──────────────┘             └──────────────┘             └──────────────┘
```

---

## 3. Unified Quota Contract

Every agent plugin returns an array of `AccountQuota` objects conforming to this contract:

```typescript
interface AccountQuota {
  providerId: string;           // e.g. "antigravity", "zcode", "opencode"
  providerName: string;         // e.g. "Google Antigravity"
  accountId: string;            // e.g. "developer@company.com"
  accountEmail: string;         // e.g. "developer@company.com (Google AI Pro)"
  isActiveSession: boolean;     // true if currently bound to active local IDE
  isRunning: boolean;           // true if agent process / service is live
  status: 'OK' | 'WARNING' | 'EXHAUSTED' | 'OFFLINE' | 'PROMPT_START' | 'UNCONFIGURED' | 'ERROR';
  errorMessage?: string;
  actionPrompt?: string;        // e.g. "Launch Antigravity or run 'agy' in terminal"

  // Multiple LLMs monitored by this provider (e.g. ['gemini', 'claude'] for Antigravity)
  // Contract Invariant: Guaranteed to always be an array (never undefined)
  llms: LLMQuota[];

  // Primary summary buckets (aggregated across LLMs for quick status displays)
  fiveHourQuota: QuotaBucket | null;
  weeklyQuota: QuotaBucket | null;

  // Detailed model list
  models: ModelQuotaDetail[];
}

interface LLMQuota {
  id: string;                   // e.g. "gemini", "claude", "mimo", "deepseek"
  name: string;                 // e.g. "Gemini", "Claude", "MiMo-V2.5"
  fiveHourQuota: QuotaBucket;   // 5-Hour rolling window quota & countdown
  weeklyQuota: QuotaBucket;     // Weekly cycle quota & countdown
  models: string[];             // Specific model checkpoints under this LLM
  status: 'OK' | 'WARNING' | 'EXHAUSTED';
}

interface QuotaBucket {
  percentLeft: number;          // 0 to 100
  percentUsed: number;          // 0 to 100
  resetsAt: string | null;      // ISO 8601 timestamp string
  resetTimestamp: number | null;// Unix epoch milliseconds
  formattedResetTime: string;   // e.g. "05:48 AM" or "Wed, Sep 9 03:35 PM"
  backInActionTime: string;     // Exact clock time when quota is restored
  backInActionSummary: string;  // e.g. "05:48 AM (in 2h 18m)"
  resetsInSeconds: number;      // Seconds until quota restoration
  formattedCountdown: string;   // e.g. "2h 18m" or "Ready"
  label: string;
}

interface ModelQuotaDetail {
  name: string;                 // e.g. "Gemini 3.8 Flash (High)"
  percentLeft: number;
  resetTime: string | null;
}
```

---

## 4. Agent Integration Specifications

### 4.1 Google Antigravity
- **Discovery Mechanism**: Antigravity's local language server listens on a dynamic high port (`127.0.0.1:<port>`). Port discovery uses:
  ```bash
  lsof -iTCP -sTCP:LISTEN -P -n +c 40
  ```
  Targeting `language_server` (PID owner). The `+c 40` flag is required on macOS to prevent name truncation (`language_server` vs `language_`).
- **Endpoint**:
  `POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus`
  with headers `Connect-Protocol-Version: 1` and `X-Codeium-Csrf-Token` (extracted from `ps -p <pid> -ww -o command`).
- **Dual Quota Pools**:
  Antigravity manages quotas in two separate model pools:
  1. **Gemini Pool**: Gemini 3.1 Pro, 3.6 Flash, 3.7 Flash, 3.8 Flash.
  2. **Claude & GPT Pool**: Claude Opus 4.6, Claude Sonnet 4.6, GPT-OSS 120B.
  The parser groups models by family and tracks `remainingFraction` and `resetTime` independently for each pool.
- **Offline Prompting**: When `language_server` is not listening, the plugin transitions to `status: 'OFFLINE'` with an explicit prompt directing the user to launch Antigravity or execute `agy`.

### 4.2 ZCode (Z.ai)
- **Credential Storage**: Checked hierarchically across Rust backend (`get_config`) and frontend (`src/config.js`):
  1. `~/.llm-gauge.json` (`zcode.apiKey` / `zcode.token`)
  2. Environment variables `ZCODE_API_KEY` / `ZAI_API_KEY`
- **Quota Endpoint**:
  `GET https://api.z.ai/api/monitor/usage/quota/limit`
  Headers: `Authorization: Bearer <apiKey>`, `Accept: application/json`
- **Metric Extraction & Dual-Gauge Mapping**:
  1. **5-Hour Rolling Limit** (`type: TOKENS_LIMIT`, `unit: 3, number: 5`): Rolling session capacity. When 0% is used (100% remaining), displayed as `—` (ready).
  2. **Weekly Coding Plan** (`type: TOKENS_LIMIT`, `unit: 6, number: 1`): Weekly allowance cap with countdown and reset date.
  3. **MCP & Web Tools** (`type: TIME_LIMIT`): Tool calls allowance (e.g. `search-prime`, `web-reader`, `zread`). Displays remaining calls (e.g. `93 / 100 remaining`) in gauge corner and flush stats breakdown.
- **Model Output**: Emits structured LLMs: `glm` (GLM Coding Models with purple geometric "Z" icon) and `zcode-mcp` (MCP & Web Tools with cyan globe icon). MCP usage metadata is preserved across `src/viewmodel.js`.

### 4.3 OpenCode
- **Credential Storage**:
  1. `~/.llm-gauge.json` (`opencode.token`)
  2. `~/.opencode/auth.json` (`session_token`)
  3. Environment variable `OPENCODE_TOKEN`
- **Metric Extraction**:
  Monitors dollar allocations ($12 5-hour rolling limit, $30 weekly limit on OpenCode Go).

---

## 5. Configuration Architecture

To avoid relying solely on browser `localStorage` (which fails in CLI mode), configuration is resolved via `src/config.js`:

```json
// ~/.llm-gauge.json (optional override)
{
  "refreshIntervalSeconds": 60,
  "antigravity": {
    "additionalAccounts": [
      { "email": "secondary@gmail.com", "token": "oauth_token_here" }
    ]
  },
  "zcode": {
    "apiKey": "..."
  },
  "opencode": {
    "token": "..."
  }
}
```

---

---

## 6. Web-Overlay HUD Architecture & Visual Design

The desktop application functions as an ultra-minimalist, floating macOS HUD overlay designed to overlay code editors or web browsers without obstructing workflow.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                        [⋮] (Menu, Padded)  │
│                                                                            │
│   ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐                                │
│   │ 2.3h │   │ 1.8h │   │ 52   │   │ 1.1h │   ← Orange 5h (1-dec)          │
│   │( ✦ ) │   │( ✳ ) │   │( 🌐 ) │   │( Z ) │   ← Dual-Arc Gauge             │
│   │ 86%  │   │ 62%  │   │ 52%  │   │ 74%  │   ← Grey % (overlapping arc)   │
│   └──────┘   └──────┘   └──────┘   └──────┘                                │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Flush Edge-to-Edge Breakdown (No headers/tabs/text; 15s auto-dismiss)│✕ │
│  │ 5-Hour: 86% [████████░░] Reset: 2.3h   Weekly: 92% [█████████░] 5.5d│  │
│  │ ──────────────────────────────────────────────────────────────────── │  │
│  │ [======== 15s Grey Draining Timer Bar =============================] │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                         [⤡]│
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Borderless Transparent HUD
- **Zero Heavy Chrome**: Removed all outer card wrappers, button borders, tab pickers, and legacy header banners.
- **Pure Transparency**: Window background is fully transparent (`background: transparent; -webkit-backdrop-filter: none;`). The HUD floats directly above other desktop windows without blocking background text.
- **Left-Justified Fluid Layout**: Donut gauges align naturally to the top-left, wrapping smoothly if resized.

### 6.2 Mouse-Over Window Outline & Resizing
- **Contextual Outline**: The window boundary is completely invisible by default. When the mouse cursor hovers over the window (`overlay-entered` from AppKit or DOM `pointerenter`), `.window-hovered` is applied to `.overlay-container`, displaying a subtle 1px border (`rgba(255, 255, 255, 0.22)`) and box shadow (`0 0 0 1px rgba(0, 0, 0, 0.4)`). This gives the user instant visual cues to grab and resize window edges.
- **Dual Resizing Modes**:
  1. **Native AppKit Edge Resizing**: Configured in `configure_overlay_panel` with `NSWindowStyleMask::Resizable` on `OverlayPanel`, allowing native macOS drag-resizing on any window edge.
  2. **Interactive Corner Grip (Triangle Adjuster)**: A bottom-right handle (`#window-resize-handle`) becomes visible on hover (`nwse-resize` cursor) with a comfortable 22x22 px target area at `bottom: 4px; right: 4px;` and supports pointer dragging via Tauri IPC command `native_overlay_set_size`.
- **Auto-Dimming & Hover Opacity Restoration**: The HUD runs at a user-defined base opacity (e.g. 88%, configurable via slider). When the cursor enters the window, opacity immediately elevates to 100% via native `NSTrackingArea` events (`overlay-entered` and `overlay-exited`), restoring full clarity during direct interaction.

### 6.3 Dual-Arc Circular Donut Model Gauges
- **Split Arc Topology**:
  - **Left Semicircle**: 5-Hour rolling session quota.
  - **Right Semicircle**: Weekly / cycle capacity quota.
  - Semicircles use SVG path arc calculations (`A 36 36 0 0 0` and `A 36 36 0 0 1`) with `pathLength="100"` and dynamic `stroke-dasharray`.
- **Threshold Color Coding**:
  - `> 50%`: Emerald green (`#10b981`) with soft drop-shadow glow.
  - `20% – 50%`: Amber warning (`#f59e0b`).
  - `< 20%`: Rose red alert (`#f43f5e`).
  - Depleted / background track: Translucent grey (`rgba(255, 255, 255, 0.12)`).
- **Centered Brand Logos (25% Bleed)**:
  - Scaled up by 25% (inner radius 32px vs logo tips at 33px) so logos physically bleed into the inner donut stroke.
  - Includes custom SVG glyphs for Google Gemini (4-pointed star), Anthropic Claude (official terracotta starburst), MCP Web Tools (globe), and Z-Code (angular geometric Z).
- **Tightened Corner Labels Layout**:
  - **Top-Left**: 5-Hour rolling reset time with 1-decimal precision (`2.3h`, `1.8h`, `0.0h`) in high-visibility **orange** (`#fb923c` / `text-orange-400`), positioned higher above the donut circle.
  - **Top-Right**: Weekly cycle reset time with 1-decimal precision (`5.5d`, `6.1d`) in emerald green (`#6ee7b7`), positioned higher above the donut circle.
  - **Bottom-Left**: Remaining quota percentage in grey letters (`#9ca3af`, e.g., `86%`, `62%`) overlapping/bleeding into the lower donut arc.
  - **Bottom-Right**: Completely empty (zero visual clutter).
  - Eliminates vertical text stacking and tightens card dimensions to 50x46 px.

### 6.4 Top-Right Control: Triple-Ellipsis Menu (`⋮`) & Dynamic Auto-Expansion
- **Main Window Dragging**: Anywhere on the main transparent overlay window functions as a drag surface (`data-tauri-drag-region` with `startDrag` invoking `native_overlay_start_drag`), eliminating the need for a separate visible grab bar.
- **Triple-Ellipsis Menu Button (`⋮`)**:
  - Positioned via `.window-controls-cluster` at `top: 6px; right: 18px;`.
  - **Padded to Right**: Shifted 18px inward from the right window edge so that the bottom-right corner triangle-adjuster (`#window-resize-handle`) has an unobstructed vertical lane and is effortless to select and drag without accidental menu hover.
  - **Mouse-Out Hiding (Pure Gauges Resting State)**:
    - On mouse-out (`mouseleave` / `overlay-exited`), `.window-controls-cluster` transitions to `opacity: 0; pointer-events: none;`, exactly like the `.resize-handle` triangle and the window outline.
    - **ONLY the 2 LLM circular gauges remain visible** when the mouse is out of the window, floating with complete transparency.
    - Mousing over the window adds `.window-hovered`, smoothly revealing the triple-ellipsis button (`opacity: 1`), triangle handle (`opacity: 0.7`), and window outline.
  - **Dynamic Window Expansion & Mouse-Out Shrink**:
    - If current window height is too small to fit the menu (< 250px), clicking the triple ellipsis automatically expands window height to 250px (saving resting dimensions in `priorMenuWindowSize`).
    - When the mouse leaves the window or menu area, the menu automatically closes and the window shrinks back down to its resting height. A grace period and slider drag guard prevent premature closure while interacting with the opacity slider.
  - **Dropdown Menu Capabilities**:
    - **Pin on Top**: Toggles `NSFloatingWindowLevel` (level 4 vs 0) and `set_floating_panel`.
    - **Opacity Slider**: Interactive slider (30% to 100%) persisting preference to `localStorage`.
    - **Refresh Quotas**: Triggers cache bypass (`forceRefresh = true`) with a spinning indicator animation.
    - **Copy CLI Output**: Copies pre-formatted plaintext status output directly to clipboard.
    - **Close**: Hides the overlay panel cleanly; accessible for reactivation via system tray.

### 6.5 Flush Edge-to-Edge Headerless Stats Panel & Window Expansion
- **Elimination of Unwanted Headers, Labels, and Tabs**:
  - Completely removed model group titles ("Gemini Models"), provider branding ("Google Antigravity"), tab switchers, and verbose instructional text ("auto-hides in 15s").
  - The stats panel presents *pure data*:
    - 2-column quota breakdown (5-Hour Quota with orange/emerald %, progress bar, countdown, and exact clock reset; Weekly Quota with %, progress bar, countdown, and exact clock reset).
    - MCP Tool Calls counter (`remaining / total`) when present.
    - Clean, subtle `✕` dismiss button at the top-right of the stats panel.
    - **15-Second Animated Draining Bar** in neutral grey (`.stats-timer-bar`) indicating remaining time until auto-hide.
- **Dynamic Window Expansion on Click**:
  - Clicking any model gauge dynamically widens the window to at least 440px (`Math.max(440, currentWidth)`) and adds 115px to height (`currentHeight + 115`), perfectly fitted to the headerless panel.
  - Caches resting dimensions in `priorWindowSize`.
- **Flush Edge-to-Edge Layout**:
  - The information box is strictly **flush edge-to-edge of the window**:
    - No floating card margin, no side borders, no outer drop shadows.
    - Features a top hairline divider (`border-top: 1px solid rgba(255, 255, 255, 0.12)`) and bottom corner rounding (`border-radius: 0 0 14px 14px`) matching the window's boundary.
- **Return to Prior Size on Dismiss**:
  - When the stats panel is hidden (via the 15-second auto-dismiss timer, the `✕` close button, or re-clicking the gauge card), the window automatically shrinks back to its exact prior size via `native_overlay_set_size`.

### 6.6 Menu Bar System Tray Icon with Vertical Gauge
- **Compact Dimensions**: 48x44 px (Retina 24x22 pt), replacing old wide horizontal layouts.
- **Star + Vertical Gauge Layout**:
  - Left: Primary 4-pointed AI star (`cx=18, cy=22, r=15`) with crisp white fill and dark border.
  - Right: Vertical gauge capsule (`x=34, y=12, w=8, h=20, rad=4`) replacing the second small star.
  - **Fill Dynamics**: The bottom section represents remaining quota (emerald green `#10b981`), while the top section represents depleted quota (slate grey `#71717a`). The green gauge dynamically drains downwards as quotas diminish.
- **Native Color Rendering**: Set via `tray.set_icon_as_template(false)` on macOS to guarantee full-color rendering in the macOS menu bar rather than monochrome template masking.

---

## 7. Change Log & Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-03 | Adopt JavaScript-first plugin execution | Enables identical code execution across CLI and Tauri webview. |
| 2026-09-03 | Dynamic `lsof +c 40` port discovery | Antigravity language server binds to random dynamic ports; hardcoding ports fails across restarts. |
| 2026-09-04 | Separate Gemini and Claude into dual quota pools | Real API response proved Gemini and Claude have distinct remaining fractions and reset times. Grouping by time-delta was flawed. |
| 2026-09-04 | Introduce View-Model normalizer | Isolates UI rendering from plugin schema changes, simplifying table and HUD widget generation. |
| 2026-09-04 | Centralize config via `~/.llm-quota/config.json` | Replaces `localStorage` dependence to ensure full CLI feature parity. |
| 2026-09-04 | Transition to Borderless Transparent HUD Overlay | Eliminates visual cards, tab selectors, and headers so users can place widgets directly above code editors. |
| 2026-09-04 | Circular Dual-Arc Donut Gauges with Bleed Logos | Visualizes both 5-hour rolling session limits and weekly caps in a single 38px donut with brand logos bleeding 25% into the inner stroke. |
| 2026-09-04 | Mouse-Over Window Boundary Outline & Resizing | Keeps overlay 100% borderless during normal display, but activates a 1px boundary and bottom-right resize grip on mouse-over. |
| 2026-09-04 | Top-Right Vertical Triple-Ellipsis Action Menu | Consolidates pinning, opacity adjustments, refresh, CLI export, and close actions into a single minimalist dropdown. |
| 2026-09-04 | AI Star Menu Bar Icon with Vertical Gauge | Replaces horizontal bar with an AI star on the left and a vertical gauge capsule (3/4 green, 1/4 grey) replacing the second star. |
| 2026-09-04 | Orange 5h Reset Time with 1-Decimal Precision | Formats 5h limit as `X.Xh` in orange (`#fb923c`) placed higher above the donut; weekly in emerald (`X.Xd`); bottom-left % in grey. |
| 2026-09-04 | Remove Grab Bar & Pad Triple-Ellipsis to Right | Removed redundant grab bar since entire window body is draggable; padded triple-ellipsis 18px from right edge to leave an open lane for effortless bottom-right triangle-adjuster selection. |
| 2026-09-04 | Elimination of Stats Panel Headers, Tabs & Clutter | Removed "Gemini Models", "Google Antigravity", tabs, and "auto-hides in 15s" text for a pure data breakdown with grey draining bar and ✕ button. |
| 2026-09-04 | Menu Auto-Expansion & Mouse-Out Shrinking | Clicking the triple-ellipsis expands window height if < 250px to fully display dropdown; mousing out auto-hides menu and shrinks window back to prior height. |



