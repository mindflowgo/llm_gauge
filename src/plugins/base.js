/**
 * Base Agent Quota Plugin
 * All coding agent plugins must extend this class and implement fetchQuota()
 */
export class BaseAgentPlugin {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }

  /**
   * Check if the agent's application or local service is running
   * @returns {Promise<{ isRunning: boolean, message?: string }>}
   */
  async checkStatus() {
    return { isRunning: true };
  }

  /**
   * Fetch current quota metrics
   * @param {Object} options Options such as accounts, tokens, or forceRefresh
   * @returns {Promise<AccountQuota[]>}
   */
  async fetchQuota(options = {}) {
    throw new Error(`fetchQuota() must be implemented by ${this.name} plugin`);
  }

  /**
   * Helper: Calculate remaining percentage, used percentage, and reset duration
   * @param {number} remainingFraction Floating number 0.0 to 1.0
   * @param {string|Date} resetTime ISO timestamp string or Date
   * @returns {QuotaBucket}
   */
  createQuotaBucket(remainingFraction, resetTime, label = '') {
    const fraction = Math.max(0, Math.min(1, typeof remainingFraction === 'number' ? remainingFraction : 1.0));
    const percentLeft = Math.round(fraction * 100 * 10) / 10;
    const percentUsed = Math.round((100 - percentLeft) * 10) / 10;

    let resetsAt = null;
    let resetTimestamp = null;
    let formattedResetTime = 'N/A';
    let backInActionTime = 'N/A';
    let backInActionSummary = 'N/A';
    let resetsInSeconds = 0;
    let formattedCountdown = 'N/A';

    if (resetTime) {
      const d = new Date(resetTime);
      if (!isNaN(d.getTime())) {
        resetsAt = d.toISOString();
        resetTimestamp = d.getTime();

        const now = new Date();
        const diffMs = d.getTime() - now.getTime();
        resetsInSeconds = Math.max(0, Math.floor(diffMs / 1000));

        if (resetsInSeconds > 0) {
          const days = Math.floor(resetsInSeconds / 86400);
          const hours = Math.floor((resetsInSeconds % 86400) / 3600);
          const mins = Math.floor((resetsInSeconds % 3600) / 60);

          if (days > 0) {
            formattedCountdown = `${days}d ${hours}h`;
          } else if (hours > 0) {
            formattedCountdown = `${hours}h ${mins}m`;
          } else {
            formattedCountdown = `${mins}m`;
          }
        } else {
          formattedCountdown = 'Ready to reset';
        }

        // Format exact refresh timestamp (e.g. 05:48 AM or Wed, Sep 9 03:35 PM)
        const isToday = d.toDateString() === now.toDateString();
        const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (isToday) {
          formattedResetTime = timePart;
        } else {
          const datePart = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          formattedResetTime = `${datePart} ${timePart}`;
        }

        backInActionTime = formattedResetTime;
        backInActionSummary = resetsInSeconds > 0
          ? `${formattedResetTime} (in ${formattedCountdown})`
          : `${formattedResetTime} (Ready)`;
      }
    }

    return {
      percentLeft,
      percentUsed,
      resetsAt,
      resetTimestamp,
      formattedResetTime,
      backInActionTime,
      backInActionSummary,
      resetsInSeconds,
      formattedCountdown,
      label,
    };
  }

  /**
   * Helper: Create a structured QuotaPool (for multi-model agents like Antigravity)
   * @param {string} id Unique pool ID (e.g. 'gemini', 'claude')
   * @param {string} name Friendly pool name (e.g. 'Gemini Models')
   * @param {number} remainingFraction Floating number 0.0 to 1.0
   * @param {string|Date} resetTime ISO timestamp string or Date
   * @param {Array<string>} models List of model labels belonging to this pool
   * @param {string} label Additional label/notes
   * @returns {QuotaPool}
   */
  createPool(id, name, remainingFraction, resetTime, models = [], label = '') {
    const bucket = this.createQuotaBucket(remainingFraction, resetTime, label);
    return {
      id,
      name,
      ...bucket,
      models,
    };
  }

  /**
   * Helper: Create a structured LLM Quota object with both 5-Hour and Weekly metrics
   * @param {string} id Unique LLM identifier (e.g. 'gemini', 'claude', 'mimo')
   * @param {string} name Friendly LLM name (e.g. 'Gemini', 'Claude')
   * @param {number} fiveHourFraction Floating number 0.0 to 1.0
   * @param {string|Date} fiveHourReset Reset time for 5-hour quota
   * @param {number} weeklyFraction Floating number 0.0 to 1.0
   * @param {string|Date} weeklyReset Reset time for weekly quota
   * @param {Array<string>} models List of model names/checkpoints under this LLM
   * @param {Object} labels Optional custom labels { fiveHour, weekly }
   * @returns {LLMQuota}
   */
  createLLMQuota(id, name, fiveHourFraction, fiveHourReset, weeklyFraction, weeklyReset, models = [], labels = {}) {
    const fiveHour = (fiveHourFraction !== null && fiveHourFraction !== undefined)
      ? this.createQuotaBucket(fiveHourFraction, fiveHourReset, labels.fiveHour || '5-Hour Rolling Limit')
      : null;
    const weekly = (weeklyFraction !== null && weeklyFraction !== undefined)
      ? this.createQuotaBucket(weeklyFraction, weeklyReset, labels.weekly || 'Weekly Cycle Limit')
      : null;

    let status = 'OK';
    const fivePct = fiveHour ? fiveHour.percentLeft : 100;
    const weekPct = weekly ? weekly.percentLeft : 100;
    if ((fiveHour && fivePct <= 0) || (weekly && weekPct <= 0)) {
      status = 'EXHAUSTED';
    } else if ((fiveHour && fivePct < 20) || (weekly && weekPct < 20)) {
      status = 'WARNING';
    }

    return {
      id,
      name,
      fiveHourQuota: fiveHour,
      weeklyQuota: weekly,
      models,
      status,
    };
  }
}
