import { BaseAgentPlugin } from './base.js';
import { getProviderToken } from '../config.js';
import { relayFetch } from '../net.js';

/**
 * OpenCode Quota Plugin
 * Monitors OpenCode Go subscription quotas ($12 5-hour rolling limit, $30 weekly limit)
 * via https://opencode.ai/zen/go/v1/usage
 */
export class OpenCodePlugin extends BaseAgentPlugin {
  constructor() {
    super('opencode', 'OpenCode');
  }

  async checkStatus() {
    const token = await getProviderToken('opencode');
    return {
      isRunning: true,
      isConfigured: !!token,
    };
  }

  async fetchQuota(options = {}) {
    const token = options.token || (await getProviderToken('opencode'));
    console.log('[opencode] fetchQuota starting, hasToken:', !!token);

    if (!token) {
      console.log('[opencode] No token configured; returning UNCONFIGURED state');
      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'default',
        accountEmail: 'OpenCode Go (Unconfigured)',
        isRunning: true,
        status: 'UNCONFIGURED',
        errorMessage: 'OpenCode API key not configured.',
        actionPrompt: 'Configure your OpenCode API key in Settings or ~/.llm-gauge.json to begin tracking.',
        llms: [],
        fiveHourQuota: null,
        weeklyQuota: null,
        quotaPools: [],
        models: [],
      }];
    }

    try {
      const endpoint = options.endpoint || 'https://opencode.ai/zen/go/v1/usage';
      console.log('[opencode] Sending request to:', endpoint);
      const res = await relayFetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });

      console.log('[opencode] Response status:', res.status);
      if (!res.ok) {
        const errorStatus = res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'ERROR';
        return [{
          providerId: this.id,
          providerName: this.name,
          accountId: 'opencode-go',
          accountEmail: 'OpenCode Go',
          isRunning: true,
          status: errorStatus,
          errorMessage: `OpenCode API returned HTTP ${res.status}`,
          actionPrompt: res.status === 401 || res.status === 403
            ? 'Invalid OpenCode API key. Update your key in Settings.'
            : 'OpenCode API temporarily unavailable.',
          llms: [
            {
              id: 'opencode-go',
              name: 'OpenCode Go',
              providerId: this.id,
              providerName: this.name,
              status: errorStatus,
              fiveHourQuota: null,
              weeklyQuota: null,
              quotaPools: [],
              models: ['DeepSeek V4', 'Qwen 3.8', 'Kimi K3', 'GLM-5', 'MiMo V2.5', 'MiniMax M3'],
            }
          ],
          fiveHourQuota: null,
          weeklyQuota: null,
          quotaPools: [],
          models: ['OpenCode Go'],
        }];
      }

      const raw = await res.json();
      const usage = raw?.usage || {};
      const rolling = usage.rolling || {};
      const weekly = usage.weekly || {};

      // 1. 5-Hour Rolling Limit ($12)
      const rollingUsedPct = typeof rolling.percent === 'number' ? rolling.percent : 0;
      const rollingUsedFraction = rollingUsedPct > 1 ? rollingUsedPct / 100 : rollingUsedPct;
      const rollingRemainingFraction = Math.max(0, Math.min(1, 1 - rollingUsedFraction));
      const rollingReset = rolling.resetsAt ? new Date(rolling.resetsAt) : null;
      const fiveHourQuota = this.createQuotaBucket(
        rollingRemainingFraction,
        rollingReset,
        '5-Hour Rolling Limit ($12)'
      );

      // 2. Weekly Limit ($30)
      const weeklyUsedPct = typeof weekly.percent === 'number' ? weekly.percent : 0;
      const weeklyUsedFraction = weeklyUsedPct > 1 ? weeklyUsedPct / 100 : weeklyUsedPct;
      const weeklyRemainingFraction = Math.max(0, Math.min(1, 1 - weeklyUsedFraction));
      const weeklyReset = weekly.resetsAt ? new Date(weekly.resetsAt) : null;
      const weeklyQuota = this.createQuotaBucket(
        weeklyRemainingFraction,
        weeklyReset,
        'Weekly Limit ($30)'
      );

      const quotaPools = [fiveHourQuota, weeklyQuota].filter(Boolean);
      let accountStatus = 'OK';
      if (fiveHourQuota.percentLeft <= 0 || weeklyQuota.percentLeft <= 0) {
        accountStatus = 'EXHAUSTED';
      } else if (fiveHourQuota.percentLeft < 20 || weeklyQuota.percentLeft < 20) {
        accountStatus = 'WARNING';
      }

      const llms = [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          providerId: this.id,
          providerName: this.name,
          status: accountStatus,
          fiveHourQuota,
          weeklyQuota,
          quotaPools,
          models: ['DeepSeek V4', 'Qwen 3.8', 'Kimi K3', 'GLM-5', 'MiMo V2.5', 'MiniMax M3'],
        }
      ];

      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'opencode-go',
        accountEmail: 'OpenCode Go',
        isRunning: true,
        status: accountStatus,
        errorMessage: null,
        actionPrompt: null,
        fiveHourQuota,
        weeklyQuota,
        quotaPools,
        models: ['OpenCode Go'],
        llms,
      }];
    } catch (err) {
      console.warn('[opencode] fetchQuota caught error:', err);
      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'opencode-go',
        accountEmail: 'OpenCode Go',
        isRunning: false,
        status: 'NETWORK_ERROR',
        errorMessage: err.message || 'Network request failed',
        actionPrompt: 'Unable to reach opencode.ai. Check your connection.',
        llms: [
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            providerId: this.id,
            providerName: this.name,
            status: 'NETWORK_ERROR',
            fiveHourQuota: null,
            weeklyQuota: null,
            quotaPools: [],
            models: ['DeepSeek V4', 'Qwen 3.8', 'Kimi K3', 'GLM-5', 'MiMo V2.5', 'MiniMax M3'],
          }
        ],
        fiveHourQuota: null,
        weeklyQuota: null,
        quotaPools: [],
        models: ['OpenCode Go'],
      }];
    }
  }
}
