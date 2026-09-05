import { BaseAgentPlugin } from './base.js';
import { getProviderToken } from '../config.js';
import { relayFetch } from '../net.js';

/**
 * ZCode (Z.ai GLM Coding Plan) Quota Plugin
 * Gathers 5-Hour rolling token limits, Weekly cycle limits, and MCP/Tool quotas.
 * Queries https://api.z.ai/api/monitor/usage/quota/limit
 */
export class ZCodePlugin extends BaseAgentPlugin {
  constructor() {
    super('zcode', 'ZCode (Z.ai)');
    this.endpoint = 'https://api.z.ai/api/monitor/usage/quota/limit';
  }

  async checkStatus() {
    return { isRunning: true };
  }

  async fetchQuota(options = {}) {
    const apiKey = options.apiKey || (await getProviderToken('zcode'));
    console.log('[zcode] fetchQuota starting, hasApiKey:', !!apiKey);
    if (!apiKey) {
      console.log('[zcode] No API key configured; returning UNCONFIGURED state');
      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'default',
        accountEmail: 'No API Key configured',
        isRunning: true,
        status: 'UNCONFIGURED',
        errorMessage: 'ZCode API Key not configured.',
        actionPrompt: 'Configure your Z.ai Coding Plan key in config.json, ~/.llm-quota/config.json, or ZCODE_API_KEY.',
        fiveHourQuota: null,
        weeklyQuota: null,
        mcpQuota: null,
        quotaPools: [],
        llms: [],
        models: [],
      }];
    }

    try {
      console.log('[zcode] Sending request to:', this.endpoint);
      const res = await relayFetch(this.endpoint, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      console.log('[zcode] Response status:', res.status);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to retrieve quota from Z.ai`);
      }

      const raw = await res.json();
      const payload = raw.data || raw;
      const limits = Array.isArray(payload.limits) ? payload.limits : [];
      const planLevel = (payload.level || 'Lite').toUpperCase();

      // 1. 5-Hour Token Rolling Limit (type: TOKENS_LIMIT, unit: 3, number: 5)
      const fiveHourLimit = limits.find(l => l.type === 'TOKENS_LIMIT' && (l.unit === 3 || l.number === 5))
        || limits.find(l => l.type === 'TOKENS_LIMIT')
        || {};
      const fiveHourPctUsed = typeof fiveHourLimit.percentage === 'number' ? fiveHourLimit.percentage : 0;
      const fiveHourFraction = Math.max(0, Math.min(1, (100 - fiveHourPctUsed) / 100));
      const fiveHourReset = fiveHourLimit.nextResetTime ? new Date(fiveHourLimit.nextResetTime) : null;
      const fiveHourQuota = this.createQuotaBucket(
        fiveHourFraction,
        fiveHourReset,
        '5-Hour Rolling Limit'
      );

      // If unused/100% available without pending reset, display clean ready status
      if (!fiveHourReset && fiveHourFraction === 1.0) {
        fiveHourQuota.formattedCountdown = '—';
        fiveHourQuota.backInActionSummary = '100% available';
      }

      // 2. Weekly Token Cycle Limit (type: TOKENS_LIMIT, unit: 6, number: 1)
      const weeklyLimit = limits.find(l => l.type === 'TOKENS_LIMIT' && (l.unit === 6 || l.number === 1))
        || limits.filter(l => l.type === 'TOKENS_LIMIT')[1]
        || {};
      const weeklyPctUsed = typeof weeklyLimit.percentage === 'number' ? weeklyLimit.percentage : 0;
      const weeklyFraction = Math.max(0, Math.min(1, (100 - weeklyPctUsed) / 100));
      const weeklyReset = weeklyLimit.nextResetTime ? new Date(weeklyLimit.nextResetTime) : null;
      const weeklyQuota = this.createQuotaBucket(
        weeklyFraction,
        weeklyReset,
        'Weekly Coding Plan'
      );

      // 3. MCP & Web Tools Limit (type: TIME_LIMIT with usageDetails like search-prime, web-reader, zread)
      const mcpLimit = limits.find(l => l.type === 'TIME_LIMIT' || (Array.isArray(l.usageDetails) && l.usageDetails.length > 0)) || {};
      const mcpTotal = typeof mcpLimit.usage === 'number' ? mcpLimit.usage : 100;
      const mcpUsed = typeof mcpLimit.currentValue === 'number' ? mcpLimit.currentValue : 0;
      const mcpRemaining = typeof mcpLimit.remaining === 'number' ? mcpLimit.remaining : Math.max(0, mcpTotal - mcpUsed);
      const mcpFraction = mcpTotal > 0 ? Math.max(0, Math.min(1, mcpRemaining / mcpTotal)) : ((100 - (mcpLimit.percentage ?? 0)) / 100);
      const mcpReset = mcpLimit.nextResetTime ? new Date(mcpLimit.nextResetTime) : null;

      const mcpQuota = this.createQuotaBucket(
        mcpFraction,
        mcpReset,
        `MCP & Tools (${mcpRemaining}/${mcpTotal} calls remaining)`
      );

      const toolDetails = Array.isArray(mcpLimit.usageDetails) && mcpLimit.usageDetails.length > 0
        ? mcpLimit.usageDetails.map(t => `${t.modelCode} (${t.usage} used)`)
        : ['search-prime', 'web-reader', 'zread'];

      // Build structured multi-pool LLMs
      const llms = [
        this.createLLMQuota(
          'glm',
          'GLM Coding Models',
          fiveHourFraction,
          fiveHourReset,
          weeklyFraction,
          weeklyReset,
          ['GLM-5 Pro', 'GLM-4.7'],
          { fiveHour: '5-Hour Rolling Limit', weekly: 'Weekly Plan Limit' }
        ),
        {
          id: 'zcode-mcp',
          name: 'MCP & Web Tools',
          fiveHourQuota: null, // MCP quota is counted against total monthly/cycle allowance
          weeklyQuota: mcpQuota,
          models: toolDetails,
          status: mcpQuota.percentLeft < 20 ? 'WARNING' : 'OK',
          mcpUsage: {
            total: mcpTotal,
            used: mcpUsed,
            remaining: mcpRemaining,
            tools: mcpLimit.usageDetails || [],
          },
        },
      ];

      const overallStatus = (fiveHourQuota.percentLeft < 20 || weeklyQuota.percentLeft < 20) ? 'WARNING' : 'OK';

      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'zcode-main',
        accountEmail: `Z.ai Coding Plan (${planLevel})`,
        isRunning: true,
        status: overallStatus,
        llms,
        fiveHourQuota,
        weeklyQuota,
        mcpQuota,
        models: [
          { name: 'GLM-5 Pro', percentLeft: fiveHourQuota.percentLeft, resetTime: fiveHourQuota.resetsAt },
          { name: 'GLM-4.7', percentLeft: fiveHourQuota.percentLeft, resetTime: fiveHourQuota.resetsAt },
          ...toolDetails.map(t => ({ name: t, percentLeft: mcpQuota.percentLeft, resetTime: mcpQuota.resetsAt })),
        ],
      }];
    } catch (err) {
      console.warn('[zcode] fetchQuota caught error:', err);
      return [{
        providerId: this.id,
        providerName: this.name,
        accountId: 'default',
        accountEmail: 'Connection Error',
        isRunning: false,
        status: 'ERROR',
        errorMessage: err.message,
        actionPrompt: 'Verify network connectivity and Z.ai API key.',
        fiveHourQuota: null,
        weeklyQuota: null,
        mcpQuota: null,
        quotaPools: [],
        llms: [
          {
            id: 'glm',
            name: 'GLM Coding Models',
            providerId: this.id,
            providerName: this.name,
            fiveHourQuota: null,
            weeklyQuota: null,
            status: 'ERROR',
            models: ['GLM-5 Pro', 'GLM-4.7'],
          },
          {
            id: 'zcode-mcp',
            name: 'MCP & Web Tools',
            providerId: this.id,
            providerName: this.name,
            fiveHourQuota: null,
            weeklyQuota: null,
            status: 'ERROR',
            models: ['search-prime', 'web-reader', 'zread'],
          }
        ],
        models: [],
      }];
    }
  }
}

