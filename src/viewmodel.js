/**
 * ViewModel Adapter for LLM Quota Tracker
 * Normalizes multi-LLM quotas (e.g. Gemini and Claude in Antigravity,
 * MiMo and DeepSeek in OpenCode) and formats clean structures for CLI and Web-Overlay UI
 */

/**
 * Transforms an AccountQuota object into a standardized display model
 * @param {AccountQuota} account 
 */
export function toDisplayAccount(account) {
  const llms = [];

  if (Array.isArray(account.llms) && account.llms.length > 0) {
    for (const l of account.llms) {
      llms.push({
        id: l.id,
        name: l.name || l.id,
        fiveHourQuota: l.fiveHourQuota || null,
        weeklyQuota: l.weeklyQuota || null,
        models: Array.isArray(l.models) ? l.models : [],
        status: l.status || 'OK',
        ...(l.mcpUsage ? { mcpUsage: l.mcpUsage } : {}),
      });
    }
  } else if (Array.isArray(account.quotaPools) && account.quotaPools.length > 0) {
    // Backward compatibility: synthesize an LLM from pools
    for (const p of account.quotaPools) {
      llms.push({
        id: p.id,
        name: p.name || p.id,
        fiveHourQuota: {
          percentLeft: p.percentLeft ?? 100,
          percentUsed: p.percentUsed ?? 0,
          resetsAt: p.resetsAt || null,
          resetTimestamp: p.resetTimestamp || null,
          formattedResetTime: p.formattedResetTime || 'N/A',
          backInActionTime: p.backInActionTime || 'N/A',
          backInActionSummary: p.backInActionSummary || 'N/A',
          formattedCountdown: p.formattedCountdown || 'N/A',
          label: p.label || 'Rolling Limit',
        },
        weeklyQuota: account.weeklyQuota || null,
        models: Array.isArray(p.models) ? p.models : [],
        status: p.percentLeft <= 0 ? 'EXHAUSTED' : p.percentLeft < 10 ? 'WARNING' : 'OK',
      });
    }
  } else if (account.fiveHourQuota || account.weeklyQuota) {
    // Fallback: single generic LLM
    llms.push({
      id: 'primary',
      name: account.providerName,
      fiveHourQuota: account.fiveHourQuota,
      weeklyQuota: account.weeklyQuota,
      models: (account.models || []).map(m => m.name),
      status: account.status || 'OK',
    });
  }

  return {
    providerId: account.providerId,
    providerName: account.providerName,
    accountId: account.accountId,
    accountEmail: account.accountEmail,
    isActiveSession: account.isActiveSession ?? false,
    isRunning: account.isRunning ?? true,
    status: account.status,
    errorMessage: account.errorMessage,
    actionPrompt: account.actionPrompt,
    llms,
    fiveHourQuota: account.fiveHourQuota,
    weeklyQuota: account.weeklyQuota,
    rawModels: account.models || [],
  };
}

/**
 * Returns color category based on remaining percentage
 * @param {number} pct
 * @returns {'good' | 'warning' | 'danger'}
 */
export function getPercentCategory(pct) {
  if (pct === null || pct === undefined) return 'good';
  if (pct > 50) return 'good';
  if (pct >= 20) return 'warning';
  return 'danger';
}
