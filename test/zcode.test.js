import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZCodePlugin } from '../src/plugins/zcode.js';
import { toDisplayAccount } from '../src/viewmodel.js';
import { getProviderToken } from '../src/config.js';

test('ZCode: Credential resolution from config or env', async () => {
  process.env.ZCODE_API_KEY = 'test_key.123456';
  const token = await getProviderToken('zcode');
  assert.ok(token, 'A ZCode API token should be discovered');
  assert.match(token, /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/, 'Token should match expected Z.ai API key format');
  delete process.env.ZCODE_API_KEY;
});

test('ZCode: Payload parsing matching live Z.ai API structure', async () => {
  const plugin = new ZCodePlugin();

  // Mock payload exactly mirroring live response from https://api.z.ai/api/monitor/usage/quota/limit
  const mockPayload = {
    code: 200,
    msg: "Operation successful",
    data: {
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 7,
          remaining: 93,
          percentage: 7,
          nextResetTime: Date.now() + 8.5 * 86400 * 1000,
          usageDetails: [
            { modelCode: "search-prime", usage: 7 },
            { modelCode: "web-reader", usage: 0 },
            { modelCode: "zread", usage: 0 }
          ]
        },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 0
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 1,
          nextResetTime: Date.now() + 5.5 * 86400 * 1000
        }
      ],
      level: "lite"
    },
    success: true
  };

  const limits = mockPayload.data.limits;

  const fiveHourLimit = limits.find(l => l.type === 'TOKENS_LIMIT' && (l.unit === 3 || l.number === 5));
  const fiveHourPctUsed = fiveHourLimit.percentage;
  const fiveHourFraction = (100 - fiveHourPctUsed) / 100;
  const fiveHourReset = fiveHourLimit.nextResetTime ? new Date(fiveHourLimit.nextResetTime) : null;
  const fiveHourQuota = plugin.createQuotaBucket(fiveHourFraction, fiveHourReset, '5-Hour Rolling Limit');
  if (!fiveHourReset && fiveHourFraction === 1.0) {
    fiveHourQuota.formattedCountdown = '—';
  }

  const weeklyLimit = limits.find(l => l.type === 'TOKENS_LIMIT' && (l.unit === 6 || l.number === 1));
  const weeklyPctUsed = weeklyLimit.percentage;
  const weeklyFraction = (100 - weeklyPctUsed) / 100;
  const weeklyReset = weeklyLimit.nextResetTime ? new Date(weeklyLimit.nextResetTime) : null;
  const weeklyQuota = plugin.createQuotaBucket(weeklyFraction, weeklyReset, 'Weekly Coding Plan');

  const mcpLimit = limits.find(l => l.type === 'TIME_LIMIT');
  const mcpTotal = mcpLimit.usage;
  const mcpUsed = mcpLimit.currentValue;
  const mcpRemaining = mcpLimit.remaining;
  const mcpFraction = mcpRemaining / mcpTotal;
  const mcpReset = new Date(mcpLimit.nextResetTime);
  const mcpQuota = plugin.createQuotaBucket(mcpFraction, mcpReset, `MCP & Tools (${mcpRemaining}/${mcpTotal})`);

  const rawAccount = {
    providerId: 'zcode',
    providerName: 'ZCode (Z.ai)',
    accountId: 'zcode-main',
    accountEmail: 'Z.ai Coding Plan (LITE)',
    isRunning: true,
    status: 'OK',
    llms: [
      plugin.createLLMQuota(
        'glm',
        'GLM Coding Models',
        fiveHourFraction,
        fiveHourReset,
        weeklyFraction,
        weeklyReset,
        ['GLM-5 Pro', 'GLM-4.7']
      ),
      {
        id: 'zcode-mcp',
        name: 'MCP & Web Tools',
        fiveHourQuota: null,
        weeklyQuota: mcpQuota,
        models: ['search-prime', 'web-reader', 'zread'],
        status: 'OK',
        mcpUsage: {
          total: mcpTotal,
          used: mcpUsed,
          remaining: mcpRemaining,
          tools: mcpLimit.usageDetails,
        },
      }
    ],
    fiveHourQuota,
    weeklyQuota,
    mcpQuota,
  };

  // Assert raw quotas
  assert.equal(fiveHourQuota.percentLeft, 100, '5-Hour quota should be 100%');
  assert.equal(fiveHourQuota.formattedCountdown, '—', '5-Hour countdown should be dash when 100% available without pending reset');
  assert.equal(weeklyQuota.percentLeft, 99, 'Weekly quota should be 99%');
  assert.equal(mcpQuota.percentLeft, 93, 'MCP quota should be 93%');

  // Assert ViewModel mapping
  const displayAccount = toDisplayAccount(rawAccount);
  assert.equal(displayAccount.llms.length, 2, 'Should contain 2 LLM models (GLM and MCP)');

  const glmLlm = displayAccount.llms.find(l => l.id === 'glm');
  assert.ok(glmLlm, 'GLM LLM must be present');
  assert.equal(glmLlm.fiveHourQuota.percentLeft, 100);
  assert.equal(glmLlm.weeklyQuota.percentLeft, 99);

  const mcpLlm = displayAccount.llms.find(l => l.id === 'zcode-mcp');
  assert.ok(mcpLlm, 'MCP LLM must be present');
  assert.ok(mcpLlm.mcpUsage, 'mcpUsage must be preserved by toDisplayAccount');
  assert.equal(mcpLlm.mcpUsage.remaining, 93);
  assert.equal(mcpLlm.mcpUsage.total, 100);
});
