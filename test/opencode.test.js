import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodePlugin } from '../src/plugins/opencode.js';
import { toDisplayAccount } from '../src/viewmodel.js';

const plugin = new OpenCodePlugin();
const now = Date.now();

// Mock real OpenCode Go usage response structure
const mockOpenCodeUsage = {
  usage: {
    rolling: {
      status: "ok",
      percent: 15, // 15% used -> 85% left
      resetsAt: new Date(now + 3.2 * 3600 * 1000).toISOString(),
    },
    weekly: {
      status: "ok",
      percent: 8, // 8% used -> 92% left
      resetsAt: new Date(now + 4.5 * 86400 * 1000).toISOString(),
    },
    monthly: {
      status: "ok",
      percent: 4,
      resetsAt: new Date(now + 20 * 86400 * 1000).toISOString(),
    }
  }
};

test('OpenCode: Returns UNCONFIGURED when no token provided', async () => {
  const result = await plugin.fetchQuota({ token: null });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'UNCONFIGURED');
  assert.deepEqual(result[0].llms, []);
});

test('OpenCode: Parses live OpenCode Go usage payload accurately', async () => {
  // Mock relayFetch via global / option injection
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => mockOpenCodeUsage,
      text: async () => JSON.stringify(mockOpenCodeUsage),
    };
  };

  try {
    const quotas = await plugin.fetchQuota({ token: 'test-sk-key' });
    assert.equal(quotas.length, 1);
    const acc = quotas[0];

    assert.equal(acc.providerId, 'opencode');
    assert.equal(acc.status, 'OK');
    assert.ok(acc.fiveHourQuota, 'fiveHourQuota must be present');
    assert.ok(acc.weeklyQuota, 'weeklyQuota must be present');

    // 15% used -> 85% remaining
    assert.equal(acc.fiveHourQuota.percentLeft, 85);
    assert.equal(acc.fiveHourQuota.percentUsed, 15);
    assert.ok(acc.fiveHourQuota.resetsInSeconds > 0);

    // 8% used -> 92% remaining
    assert.equal(acc.weeklyQuota.percentLeft, 92);
    assert.equal(acc.weeklyQuota.percentUsed, 8);
    assert.ok(acc.weeklyQuota.resetsInSeconds > 0);

    // Verify LLM entry for OpenCode Go
    assert.equal(acc.llms.length, 1);
    const llm = acc.llms[0];
    assert.equal(llm.id, 'opencode-go');
    assert.equal(llm.name, 'OpenCode Go');
    assert.equal(llm.fiveHourQuota.percentLeft, 85);
    assert.equal(llm.weeklyQuota.percentLeft, 92);

    // Test ViewModel transformation
    const display = toDisplayAccount(acc);
    assert.equal(display.providerId, 'opencode');
    assert.equal(display.llms.length, 1);
    assert.equal(display.llms[0].name, 'OpenCode Go');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
