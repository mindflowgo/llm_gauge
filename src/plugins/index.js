import { AntigravityPlugin } from './antigravity.js';
import { ZCodePlugin } from './zcode.js';
import { OpenCodePlugin } from './opencode.js';

/**
 * Plugin Registry and Cache Manager
 */
export class QuotaPluginManager {
  constructor(options = {}) {
    this.plugins = new Map();
    this.cache = new Map();
    this.cacheTtlMs = options.cacheTtlMs || 60 * 1000; // 60 seconds default TTL
    this.errorCacheTtlMs = options.errorCacheTtlMs || 5 * 1000; // 5s short TTL for offline/error states

    // Register built-in plugins
    this.register(new AntigravityPlugin());
    this.register(new ZCodePlugin());
    this.register(new OpenCodePlugin());
  }

  register(plugin) {
    this.plugins.set(plugin.id, plugin);
  }

  getPlugin(id) {
    return this.plugins.get(id);
  }

  getAllPlugins() {
    return Array.from(this.plugins.values());
  }

  /**
   * Fetch quotas for all plugins in parallel with caching
   * @param {boolean} forceRefresh If true, bypasses the cache
   */
  async fetchAllQuotas(forceRefresh = false) {
    const pluginIds = Array.from(this.plugins.keys()).join(', ');
    console.log(`[plugins] fetchAllQuotas starting (forceRefresh=${forceRefresh}) for plugins: [${pluginIds}]`);
    const now = Date.now();
    const tasks = Array.from(this.plugins.values()).map(async (plugin) => {
      const cacheKey = plugin.id;
      const cached = this.cache.get(cacheKey);

      if (!forceRefresh && cached) {
        const isErrorOrOffline = Array.isArray(cached.data) && cached.data.some(
          a => a.status === 'ERROR' || a.status === 'OFFLINE' || a.status === 'PROMPT_START'
        );
        const ttl = isErrorOrOffline ? this.errorCacheTtlMs : this.cacheTtlMs;
        if (now - cached.timestamp < ttl) {
          console.log(`[plugins:${plugin.id}] Using cached quota (${Math.round((now - cached.timestamp) / 1000)}s old)`);
          return cached.data;
        }
      }

      try {
        console.log(`[plugins:${plugin.id}] Fetching fresh quota (forceRefresh=${forceRefresh})...`);
        const data = await plugin.fetchQuota({ forceRefresh });
        const count = Array.isArray(data) ? data.length : 1;
        console.log(`[plugins:${plugin.id}] Quota fetch success (${count} account(s))`);
        this.cache.set(cacheKey, { timestamp: now, data });
        return data;
      } catch (err) {
        console.error(`[plugins:${plugin.id}] Quota fetch failed:`, err);
        return [{
          providerId: plugin.id,
          providerName: plugin.name,
          accountId: 'error',
          accountEmail: 'Error fetching',
          isRunning: false,
          status: 'ERROR',
          errorMessage: err.message,
          actionPrompt: 'Check network connectivity or configuration.',
          llms: [],
          fiveHourQuota: null,
          weeklyQuota: null,
          quotaPools: [],
          models: [],
        }];
      }
    });

    const results = await Promise.all(tasks);
    const flat = results.flat();
    console.log(`[plugins] fetchAllQuotas completed: ${flat.length} total account(s)`);
    return flat;
  }

  clearCache() {
    this.cache.clear();
  }
}

export const pluginManager = new QuotaPluginManager();
