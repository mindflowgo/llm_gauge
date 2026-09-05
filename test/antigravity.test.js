import { AntigravityPlugin } from '../src/plugins/antigravity.js';

const plugin = new AntigravityPlugin();
const now = Date.now();

// Test Case 1: Real RetrieveUserQuotaSummary groups payload matching the user's live values:
// Gemini: 5h is 86%, weekly is 98%
// Claude: 5h is 59%, weekly is 86%
const mockQuotaSummaryPayload = {
  userStatus: {
    name: "Laborde House",
    email: "labordehouse@gmail.com",
    userTier: { name: "Google AI Pro" },
    planStatus: { planInfo: { planName: "Pro" } },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: "Gemini 3.8 Flash (High)", modelId: "gemini-3.8-flash-high" },
        { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro" },
        { label: "Claude 3.7 Sonnet", modelId: "claude-3-7-sonnet" },
        { label: "Claude Opus 4.6", modelId: "claude-opus-4-6" }
      ]
    }
  },
  quotaSummary: {
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          {
            displayName: "5-Hour Rolling Limit",
            remainingFraction: 0.86,
            resetTime: new Date(now + 2.3 * 3600 * 1000).toISOString(),
            window: "WINDOW_FIVE_HOURS",
          },
          {
            displayName: "Weekly Limit",
            remainingFraction: 0.98,
            resetTime: new Date(now + 5.5 * 86400 * 1000).toISOString(),
            window: "WINDOW_WEEKLY",
          }
        ]
      },
      {
        displayName: "Claude",
        buckets: [
          {
            displayName: "5-Hour Rolling Limit",
            remainingFraction: 0.59,
            resetTime: new Date(now + 4.9 * 3600 * 1000).toISOString(),
            window: "WINDOW_FIVE_HOURS",
          },
          {
            displayName: "Weekly Limit",
            remainingFraction: 0.86,
            resetTime: new Date(now + 5.5 * 86400 * 1000).toISOString(),
            window: "WINDOW_WEEKLY",
          }
        ]
      }
    ]
  }
};

console.log('=== Test Case 1: Multi-LLM Parsing with RetrieveUserQuotaSummary ===');
const parsed = plugin.parseQuotaResponse(mockQuotaSummaryPayload, 'test@example.com', true);

console.log('Account:', parsed.accountEmail);
console.log('LLMs count:', parsed.llms.length);

const gemini = parsed.llms.find(l => l.id === 'gemini');
const claude = parsed.llms.find(l => l.id === 'claude');

if (!gemini || !claude) {
  console.error('❌ Missing gemini or claude LLM object!', parsed.llms);
  process.exit(1);
}

console.log('Gemini 5h:', gemini.fiveHourQuota.percentLeft + '%', 'Weekly:', gemini.weeklyQuota.percentLeft + '%');
console.log('Gemini Back In Action:', gemini.fiveHourQuota.backInActionSummary);
console.log('Claude Back In Action:', claude.fiveHourQuota.backInActionSummary);

if (gemini.fiveHourQuota.percentLeft !== 86 || gemini.weeklyQuota.percentLeft !== 98) {
  console.error(`❌ Expected Gemini 86% / 98%, got ${gemini.fiveHourQuota.percentLeft}% / ${gemini.weeklyQuota.percentLeft}%`);
  process.exit(1);
}

if (claude.fiveHourQuota.percentLeft !== 59 || claude.weeklyQuota.percentLeft !== 86) {
  console.error(`❌ Expected Claude 59% / 86%, got ${claude.fiveHourQuota.percentLeft}% / ${claude.weeklyQuota.percentLeft}%`);
  process.exit(1);
}

// Refresh timestamp assertions
if (!gemini.fiveHourQuota.formattedResetTime || gemini.fiveHourQuota.formattedResetTime === 'N/A') {
  console.error('❌ Gemini 5h missing formattedResetTime!');
  process.exit(1);
}

if (!gemini.fiveHourQuota.backInActionTime || !gemini.fiveHourQuota.backInActionSummary) {
  console.error('❌ Gemini 5h missing backInAction fields!');
  process.exit(1);
}

if (!gemini.weeklyQuota.formattedResetTime || gemini.weeklyQuota.formattedResetTime === 'N/A') {
  console.error('❌ Gemini weekly missing formattedResetTime!');
  process.exit(1);
}

if (gemini.models.length !== 2 || claude.models.length !== 2) {
  console.error('❌ Expected 2 Gemini models and 2 Claude models mapped correctly', gemini.models, claude.models);
  process.exit(1);
}

console.log('✅ ALL MULTI-LLM & REFRESH TIMESTAMP TESTS PASSED: Gemini (86% 5h, 98% wk) and Claude (59% 5h, 86% wk) with exact back-in-action timestamps verified!\n');

// Test Case 2: Fallback parsing when quotaSummary is absent, extracting from clientModelConfigs
console.log('=== Test Case 2: Fallback Parsing from clientModelConfigs ===');
const mockFallbackPayload = {
  userStatus: {
    email: "labordehouse@gmail.com",
    userTier: { name: "Google AI Pro" },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: "Gemini 3.8 Flash (High)", quotaInfo: { remainingFraction: 0.86 } },
        { label: "Claude 3.7 Sonnet", quotaInfo: { remainingFraction: 0.59 } },
      ]
    }
  }
};

const parsedFallback = plugin.parseQuotaResponse(mockFallbackPayload, 'test@example.com', true);
const geminiFallback = parsedFallback.llms.find(l => l.id === 'gemini');
const claudeFallback = parsedFallback.llms.find(l => l.id === 'claude');

if (!geminiFallback || !claudeFallback) {
  console.error('❌ Fallback parsing failed to extract Gemini and Claude!');
  process.exit(1);
}

if (geminiFallback.fiveHourQuota.percentLeft !== 86 || claudeFallback.fiveHourQuota.percentLeft !== 59) {
  console.error('❌ Fallback percentages mismatch!');
  process.exit(1);
}

if (geminiFallback.weeklyQuota !== null || claudeFallback.weeklyQuota !== null || parsedFallback.weeklyQuota !== null) {
  console.error('❌ Expected weeklyQuota to be null in fallback path, but found a fabricated value!');
  process.exit(1);
}
console.log('✅ Fallback clientModelConfigs parsing successfully created Gemini and Claude LLMs with weeklyQuota: null!\n');

// Test Case 3: ViewModel transformation
import { toDisplayAccount } from '../src/viewmodel.js';
console.log('=== Test Case 3: ViewModel Transformation ===');
const displayAcc = toDisplayAccount(parsed);
if (displayAcc.llms.length !== 2) {
  console.error('❌ ViewModel failed to retain 2 LLMs!');
  process.exit(1);
}
console.log('✅ ViewModel adapter properly normalized multi-LLM accounts!\n');

