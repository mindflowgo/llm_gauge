import { BaseAgentPlugin } from './base.js';
import { getAdditionalAccounts } from '../config.js';
import { relayFetch } from '../net.js';

/**
 * Google Antigravity Quota Plugin
 * Supports local language server discovery and multi-account quota monitoring.
 */
export class AntigravityPlugin extends BaseAgentPlugin {
  constructor() {
    super('antigravity', 'Google Antigravity');
    this.defaultPorts = [56154, 56155, 56148, 56153, 54100, 54101, 54102, 54103, 54104];
    this.cachedPort = null;
    this.cachedCsrfToken = null;
    this.candidatePorts = [];
  }

  /**
   * Check if Antigravity is running locally
   */
  async checkStatus() {
    // 1. Ask Tauri if running in Tauri desktop environment
    const invoke = (typeof window !== 'undefined') && (window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke);
    if (invoke) {
      try {
        console.log('[antigravity] Probing process status via Tauri check_process...');
        const procInfo = await invoke('check_process', { name: 'antigravity' });
        console.log('[antigravity] check_process response:', procInfo);
        if (procInfo && procInfo.is_running) {
          if (procInfo.port) this.cachedPort = procInfo.port;
          if (Array.isArray(procInfo.ports) && procInfo.ports.length > 0) {
            this.candidatePorts = procInfo.ports;
          }
          if (procInfo.csrf_token) this.cachedCsrfToken = procInfo.csrf_token;
          return { isRunning: true, port: procInfo.port };
        }
      } catch (e) {
        console.warn('[antigravity] Tauri check_process failed:', e);
      }
    }

    // 2. Probe local ports
    const port = await this.discoverPort();
    if (port) {
      return { isRunning: true, port };
    }

    return {
      isRunning: false,
      message: 'Google Antigravity is not currently running.',
      actionPrompt: 'Please launch the Antigravity IDE or run "agy" in your terminal to start the language server.',
    };
  }

  /**
   * Probe loopback ports for the Antigravity Language Server
   */
  async discoverPort() {
    if (this.cachedPort) {
      if (await this.pingPort(this.cachedPort)) return this.cachedPort;
      this.cachedPort = null;
    }

    // 1. Dynamic probe via system lsof
    const dynamicPorts = await this.discoverSystemPorts();
    for (const port of dynamicPorts) {
      const isAlive = await this.pingPort(port);
      if (isAlive) {
        this.cachedPort = port;
        return port;
      }
    }

    // 2. Fallback to default port range
    for (const port of this.defaultPorts) {
      const isAlive = await this.pingPort(port);
      if (isAlive) {
        this.cachedPort = port;
        return port;
      }
    }
    return dynamicPorts.length > 0 ? dynamicPorts[0] : null;
  }

  /**
   * Dynamically find ports and CSRF token used by language_server
   */
  async discoverSystemPorts() {
    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        const { execSync } = await import('child_process');
        const fs = await import('fs');
        let discoveredPid = null;

        // 1. Check ps for language_server processes and extract CSRF tokens
        try {
          const psOutput = execSync('ps -ww -eo pid,command 2>/dev/null || ps -ef 2>/dev/null').toString();
          const candidates = [];
          for (const line of psOutput.split('\n')) {
            if (line.includes('language_server') && line.includes('--csrf_token')) {
              const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9_-]+)/);
              const parts = line.trim().split(/\s+/);
              const pid = /^\d+$/.test(parts[0]) ? parts[0] : (/^\d+$/.test(parts[1]) ? parts[1] : null);
              if (tokenMatch && pid) {
                const isPreferred = line.includes('subclient_type hub') || line.includes('Antigravity.app');
                candidates.push({ pid, token: tokenMatch[1], isPreferred });
              }
            }
          }
          const chosen = candidates.find(c => c.isPreferred) || candidates[0];
          if (chosen) {
            this.cachedCsrfToken = chosen.token;
            discoveredPid = chosen.pid;
          }
        } catch {}

        // 2. Query lsof for target PID or language_server
        const lsofBin = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
        const lsofCmd = discoveredPid
          ? `${lsofBin} -a -p ${discoveredPid} -iTCP -sTCP:LISTEN -P -n 2>/dev/null`
          : `${lsofBin} -iTCP -sTCP:LISTEN -P -n +c 40 2>/dev/null`;

        const output = execSync(lsofCmd).toString();
        const lines = output.split('\n');
        const candidates = [];

        for (const line of lines) {
          if (discoveredPid || /language_server/i.test(line)) {
            const match = line.match(/TCP (?:127\.0\.0\.1|\*):(\d+) \(LISTEN\)/);
            if (match) {
              const port = parseInt(match[1], 10);
              if (!candidates.includes(port)) {
                candidates.push(port);
              }
            }
          }
        }

        if (candidates.length > 0) {
          this.candidatePorts = candidates;
          return candidates;
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  async pingPort(port) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      };
      if (this.cachedCsrfToken) {
        headers['X-Codeium-Csrf-Token'] = this.cachedCsrfToken;
      }
      const res = await relayFetch(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ metadata: { ideName: 'antigravity' } }),
        signal: controller.signal,
      });
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Main fetch method
   */
  async fetchQuota(options = {}) {
    const status = await this.checkStatus();
    if (!status.isRunning) {
      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'local-session',
        accountEmail: 'Not Connected',
        isRunning: false,
        status: 'OFFLINE',
        errorMessage: status.message,
        actionPrompt: status.actionPrompt,
        llms: [],
        fiveHourQuota: null,
        weeklyQuota: null,
        models: [],
      }];
    }

    const accounts = [];

    // 1. Fetch active local session
    try {
      const localAccount = await this.fetchLocalSession(
        status.port || this.cachedPort || 54100,
        options.forceRefresh || false
      );
      accounts.push(localAccount);
    } catch (err) {
      if (typeof process !== 'undefined' && (process.env?.DEBUG || process.argv?.includes('--debug'))) {
        console.warn('[Antigravity] Failed to fetch active local session:', err);
      }
      // Return structured offline prompt
      accounts.push({
        providerId: this.id,
        providerName: this.name,
        accountId: 'local-session',
        accountEmail: 'Local Active Profile',
        isRunning: false,
        status: 'PROMPT_START',
        errorMessage: 'Antigravity language server responded with an error or requires re-authentication.',
        actionPrompt: 'Ensure Antigravity or "agy" is logged in and active.',
        llms: [
          {
            id: 'gemini',
            name: 'Gemini',
            providerId: this.id,
            providerName: this.name,
            fiveHourQuota: null,
            weeklyQuota: null,
            status: 'PROMPT_START',
            models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'],
          },
          {
            id: 'claude',
            name: 'Claude',
            providerId: this.id,
            providerName: this.name,
            fiveHourQuota: null,
            weeklyQuota: null,
            status: 'PROMPT_START',
            models: ['Claude 3.7 Sonnet', 'Claude 3.5 Sonnet'],
          }
        ],
        fiveHourQuota: null,
        weeklyQuota: null,
        models: [],
      });
    }

    // 2. Fetch any configured multi-login secondary accounts
    const secondaryAccounts = options.additionalAccounts || (await getAdditionalAccounts('antigravity'));
    for (const sec of secondaryAccounts) {
      if (sec.token) {
        try {
          const remoteAcc = await this.fetchRemoteAccount(sec);
          accounts.push(remoteAcc);
        } catch (err) {
          console.error(`[Antigravity] Remote account error for ${sec.email}:`, err);
        }
      }
    }

    return accounts;
  }

  /**
   * Fetch from active local language server
   */
  async fetchLocalSession(preferredPort, forceRefresh = false) {
    const portsToTry = Array.from(new Set([
      preferredPort,
      ...(this.candidatePorts || []),
      ...this.defaultPorts,
    ])).filter(Boolean);

    console.log('[antigravity] fetchLocalSession candidate ports:', portsToTry, 'hasCsrfToken:', !!this.cachedCsrfToken, 'forceRefresh:', forceRefresh);
    let lastError = null;

    for (const port of portsToTry) {
      const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      };
      if (this.cachedCsrfToken) {
        headers['X-Codeium-Csrf-Token'] = this.cachedCsrfToken;
      }

      const userStatusPayload = JSON.stringify({
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en',
        },
      });

      const quotaSummaryPayload = JSON.stringify(
        forceRefresh ? { request: {}, forceRefresh: true } : { request: {} }
      );

      let userStatusData = null;
      let quotaSummaryData = null;

      // 1. Try RetrieveUserQuotaSummary (gives exact group buckets: 5h and weekly)
      try {
        console.log(`[antigravity] Trying RetrieveUserQuotaSummary on port ${port} (forceRefresh=${forceRefresh})...`);
        const quotaRes = await relayFetch(
          `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
          { method: 'POST', headers, body: quotaSummaryPayload }
        );
        if (quotaRes.ok) {
          quotaSummaryData = await quotaRes.json();
          this.cachedPort = port;
          console.log(`[antigravity] RetrieveUserQuotaSummary succeeded on port ${port}`);
        }
      } catch (e) {
        console.log(`[antigravity] RetrieveUserQuotaSummary failed on port ${port}:`, e.message || e);
        // If forceRefresh failed, immediately attempt cached non-blocking RetrieveUserQuotaSummary
        if (forceRefresh) {
          try {
            console.log(`[antigravity] Retrying RetrieveUserQuotaSummary without forceRefresh on port ${port}...`);
            const cachedRes = await relayFetch(
              `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
              { method: 'POST', headers, body: JSON.stringify({ request: {} }) }
            );
            if (cachedRes.ok) {
              quotaSummaryData = await cachedRes.json();
              this.cachedPort = port;
              console.log(`[antigravity] RetrieveUserQuotaSummary (cached) succeeded on port ${port}`);
            }
          } catch (e2) {}
        }
        // Fallback to GetUserStatus
      }

      // 2. Try GetUserStatus (gives user email, tier, and clientModelConfigs)
      try {
        const userStatusRes = await relayFetch(
          `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
          { method: 'POST', headers, body: userStatusPayload }
        );
        if (userStatusRes.ok) {
          userStatusData = await userStatusRes.json();
          this.cachedPort = port;
        }
      } catch (e) {
        lastError = e;
      }

      if (userStatusData || quotaSummaryData) {
        const combined = {
          ...(userStatusData || {}),
          quotaSummary: quotaSummaryData,
        };
        if (typeof process !== 'undefined' && (process.env?.DEBUG || process.argv?.includes('--debug'))) {
          console.log('\n[DEBUG] Antigravity raw response keys:', Object.keys(combined));
          console.log('[DEBUG] Combined data:', JSON.stringify(combined, null, 2));
        }
        return this.parseQuotaResponse(combined, 'Active Local Session', true);
      }
    }

    throw lastError || new Error('All local language server ports and endpoints failed');
  }

  /**
   * Fetch from remote Cloud Code API for secondary accounts
   */
  async fetchRemoteAccount(account) {
    const res = await relayFetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${account.token}`,
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Cloud Code remote API failed`);
    }

    const data = await res.json();
    return this.parseQuotaResponse(data, account.email || 'Secondary Account', false);
  }

  /**
   * Parse language server / Cloud Code response into unified AccountQuota with multiple LLMs
   */
  parseQuotaResponse(data, defaultEmail, isActiveSession) {
    const userStatus = data.userStatus || {};
    const email = userStatus.email || defaultEmail;
    const tierName = userStatus.userTier?.name || userStatus.planStatus?.planInfo?.planName || 'Pro';

    // Model configs can be directly at root, or nested inside cascadeModelConfigData
    const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs
      || data.clientModelConfigs
      || [];

    const rawModels = [];
    const geminiModels = [];
    const claudeModels = [];
    const otherModels = [];

    for (const cfg of modelConfigs) {
      const quota = cfg.quotaInfo;
      const fraction = typeof quota?.remainingFraction === 'number' ? quota.remainingFraction : 1.0;
      const percentLeft = Math.round(fraction * 100 * 10) / 10;
      const modelName = cfg.label || cfg.displayName || cfg.modelId || cfg.model || 'Unknown Model';
      const resetTimeStr = quota?.resetTime || null;

      rawModels.push({
        name: modelName,
        percentLeft,
        resetTime: resetTimeStr,
      });

      const idCheck = `${modelName} ${cfg.modelId || ''} ${cfg.model || ''}`;

      if (/gemini/i.test(idCheck)) {
        geminiModels.push({ name: modelName, fraction, resetTime: resetTimeStr });
      } else if (/claude|gpt|opus|sonnet/i.test(idCheck)) {
        claudeModels.push({ name: modelName, fraction, resetTime: resetTimeStr });
      } else {
        otherModels.push({ name: modelName, fraction, resetTime: resetTimeStr });
      }
    }

    const llms = [];

    // 1. Inspect RetrieveUserQuotaSummary groups if returned
    const groups = data.quotaSummary?.groups 
      || data.quotaSummary?.response?.groups 
      || data.groups 
      || [];

    if (Array.isArray(groups) && groups.length > 0) {
      for (const grp of groups) {
        const groupName = grp.displayName || grp.name || 'Model Group';
        const buckets = grp.buckets || [];

        let fiveHourBucket = null;
        let weeklyBucket = null;

        for (const b of buckets) {
          const bName = (b.displayName || b.bucketId || b.description || '').toLowerCase();
          const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
          const reset = b.resetTime || null;

          if (bName.includes('5') || bName.includes('hour') || bName.includes('rolling') || b.window === 'WINDOW_FIVE_HOURS' || b.window === 1) {
            fiveHourBucket = { fraction: frac, resetTime: reset };
          } else if (bName.includes('week') || bName.includes('cycle') || bName.includes('hard') || b.window === 'WINDOW_WEEKLY' || b.window === 2) {
            weeklyBucket = { fraction: frac, resetTime: reset };
          } else if (!fiveHourBucket) {
            fiveHourBucket = { fraction: frac, resetTime: reset };
          } else {
            weeklyBucket = { fraction: frac, resetTime: reset };
          }
        }

        const isGemini = /gemini/i.test(groupName);
        const isClaude = /claude/i.test(groupName);
        const modelsList = isGemini 
          ? geminiModels.map(m => m.name)
          : isClaude 
            ? claudeModels.map(m => m.name)
            : [];

        const llmId = isGemini ? 'gemini' : isClaude ? 'claude' : groupName.toLowerCase().replace(/\s+/g, '-');
        const cleanName = isGemini ? 'Gemini' : isClaude ? 'Claude' : groupName.replace(/\s*models\s*/i, '').trim();

        llms.push(this.createLLMQuota(
          llmId,
          cleanName,
          fiveHourBucket?.fraction ?? 1.0,
          fiveHourBucket?.resetTime ?? null,
          weeklyBucket?.fraction ?? 1.0,
          weeklyBucket?.resetTime ?? null,
          modelsList
        ));
      }
    }

    // 2. Fallback: If no explicit groups in quotaSummary, construct from clientModelConfigs
    if (llms.length === 0) {
      // Gemini LLM (5-hour rolling + weekly limit)
      if (geminiModels.length > 0) {
        const min5h = Math.min(...geminiModels.map(m => m.fraction));
        const reset5h = geminiModels.find(m => m.fraction === min5h)?.resetTime || null;
        llms.push(this.createLLMQuota(
          'gemini',
          'Gemini',
          min5h,
          reset5h,
          null, // Return null instead of invented numbers
          null,
          geminiModels.map(m => m.name),
          { fiveHour: '5-Hour Rolling Limit', weekly: 'Weekly Cycle Limit' }
        ));
      }

      // Claude LLM (5-hour rolling + weekly limit)
      if (claudeModels.length > 0) {
        const min5h = Math.min(...claudeModels.map(m => m.fraction));
        const reset5h = claudeModels.find(m => m.fraction === min5h)?.resetTime || null;
        llms.push(this.createLLMQuota(
          'claude',
          'Claude',
          min5h,
          reset5h,
          null, // Return null instead of invented numbers
          null,
          claudeModels.map(m => m.name),
          { fiveHour: '5-Hour Rolling Limit', weekly: 'Weekly Cycle Limit' }
        ));
      }

      // Other LLMs (if any)
      if (otherModels.length > 0) {
        const min5h = Math.min(...otherModels.map(m => m.fraction));
        const reset5h = otherModels.find(m => m.fraction === min5h)?.resetTime || null;
        llms.push(this.createLLMQuota(
          'other',
          'Other Models',
          min5h,
          reset5h,
          null,
          null,
          otherModels.map(m => m.name),
          { fiveHour: '5-Hour Rolling Limit', weekly: 'Weekly Cycle Limit' }
        ));
      }
    }

    // Headline aggregate buckets (lowest across LLMs)
    let min5hFraction = 1.0;
    let min5hReset = null;
    let minWeeklyFraction = 1.0;
    let minWeeklyReset = null;
    let hasWeeklyQuota = false;

    for (const l of llms) {
      if (l.fiveHourQuota && l.fiveHourQuota.percentLeft / 100 < min5hFraction) {
        min5hFraction = l.fiveHourQuota.percentLeft / 100;
        min5hReset = l.fiveHourQuota.resetsAt;
      }
      if (l.weeklyQuota) {
        hasWeeklyQuota = true;
        if (l.weeklyQuota.percentLeft / 100 < minWeeklyFraction) {
          minWeeklyFraction = l.weeklyQuota.percentLeft / 100;
          minWeeklyReset = l.weeklyQuota.resetsAt;
        }
      }
    }

    const fiveHourQuota = this.createQuotaBucket(
      min5hFraction,
      min5hReset,
      `Active Session (${(min5hFraction * 100).toFixed(0)}% min)`
    );

    const weeklyQuota = hasWeeklyQuota
      ? this.createQuotaBucket(
          minWeeklyFraction,
          minWeeklyReset,
          `${tierName} Plan Tier`
        )
      : null;

    let status = 'OK';
    if (llms.some(l => l.status === 'EXHAUSTED')) {
      status = 'EXHAUSTED';
    } else if (llms.some(l => l.status === 'WARNING')) {
      status = 'WARNING';
    }

    // Backward-compatible quotaPools mapping
    const quotaPools = llms.map(l => ({
      id: l.id,
      name: l.name,
      ...(l.fiveHourQuota || {}),
      models: l.models,
    }));

    return {
      providerId: this.id,
      providerName: this.name,
      accountId: email,
      accountEmail: `${email} (${tierName})`,
      isActiveSession,
      isRunning: true,
      status,
      llms,
      quotaPools,
      fiveHourQuota,
      weeklyQuota,
      models: rawModels,
    };
  }
}
