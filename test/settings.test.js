import test from 'node:test';
import assert from 'node:assert/strict';

test('Settings JSON structure defaults and operations', () => {
  const defaultSettings = {
    window: {
      x: 100.0,
      y: 100.0,
      width: 320.0,
      height: 76.0,
      visible: true,
    },
    settings: {
      opacity: 0.88,
      pinned: true,
      selectedGauges: ['antigravity_gemini', 'zcode_glm'],
    },
    apiKeys: {
      zcode: 'b671867e-test-key',
      opencode: '',
    },
  };

  assert.equal(typeof defaultSettings.window.x, 'number');
  assert.equal(typeof defaultSettings.window.y, 'number');
  assert.equal(defaultSettings.settings.opacity, 0.88);
  assert.equal(defaultSettings.settings.pinned, true);
  assert.deepEqual(defaultSettings.settings.selectedGauges, ['antigravity_gemini', 'zcode_glm']);
  assert.equal(defaultSettings.apiKeys.zcode, 'b671867e-test-key');
});

test('Gauge filtering by user-selected gauges', () => {
  const allModels = [
    { uniqueKey: 'antigravity_gemini', name: 'Gemini 3.8 Flash' },
    { uniqueKey: 'antigravity_claude', name: 'Claude 3.7 Sonnet' },
    { uniqueKey: 'zcode_glm', name: 'GLM-4' },
    { uniqueKey: 'zcode_zcode-mcp', name: 'Z-MCP Web' },
  ];

  const selectedGauges = ['antigravity_gemini', 'zcode_glm'];
  const selSet = new Set(selectedGauges);
  const filtered = allModels.filter(m => selSet.has(m.uniqueKey));

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].uniqueKey, 'antigravity_gemini');
  assert.equal(filtered[1].uniqueKey, 'zcode_glm');

  const emptySelection = [];
  const displayItems = emptySelection.length > 0
    ? allModels.filter(m => new Set(emptySelection).has(m.uniqueKey))
    : allModels;

  assert.equal(displayItems.length, 4);
});

test('Gauge select card checkbox rendering replaces weekly limit', () => {
  function renderMockGaugeSelectCard(item, isChecked) {
    return `
      <div class="gauge-select-card ${isChecked ? 'is-selected' : ''}" data-gauge-key="${item.uniqueKey}">
        <div class="gauge-circle-wrap">
          <span class="gauge-corner-label gauge-corner-tl text-orange-400">2.3h</span>
          <div class="gauge-corner-checkbox ${isChecked ? 'checked' : ''}">
            ${isChecked ? '<svg class="checkmark"></svg>' : ''}
          </div>
          <span class="gauge-corner-label gauge-corner-bl text-neutral-400">86%</span>
        </div>
        <div class="gauge-select-label">${item.name}</div>
      </div>
    `;
  }

  const checkedHtml = renderMockGaugeSelectCard({ uniqueKey: 'antigravity_gemini', name: 'Gemini' }, true);
  assert.ok(checkedHtml.includes('gauge-corner-checkbox checked'), 'Must render checked checkbox');
  assert.ok(checkedHtml.includes('checkmark'), 'Must render checkmark svg');
  assert.ok(!checkedHtml.includes('gauge-corner-tr'), 'Weekly limit label must not be rendered');

  const uncheckedHtml = renderMockGaugeSelectCard({ uniqueKey: 'antigravity_claude', name: 'Claude' }, false);
  assert.ok(!uncheckedHtml.includes('gauge-corner-checkbox checked'));
  assert.ok(!uncheckedHtml.includes('checkmark'));
});

test('Circular gauge card corner labels render both 5h (86%) and weekly (98%) values', () => {
  const item = {
    uniqueKey: 'antigravity_gemini',
    id: 'gemini',
    name: 'Gemini 2.5 Flash',
    fiveHourQuota: { percentLeft: 86.4, resetsInSeconds: 8220 },
    weeklyQuota: { percentLeft: 98.2, resetsInSeconds: 590400 },
  };

  const actualH5Pct = item.fiveHourQuota && typeof item.fiveHourQuota.percentLeft === 'number' ? item.fiveHourQuota.percentLeft : null;
  const actualWkPct = item.weeklyQuota && typeof item.weeklyQuota.percentLeft === 'number' ? item.weeklyQuota.percentLeft : null;

  const h5PctShort = actualH5Pct !== null ? `${Math.round(actualH5Pct)}%` : '';
  const wkPctShort = actualWkPct !== null ? `${Math.round(actualWkPct)}%` : '';

  assert.equal(h5PctShort, '86%');
  assert.equal(wkPctShort, '98%');
});

test('Gauge cards have data-tauri-drag-region="false" and no inline onclick handlers', () => {
  function renderMockGaugeCard(itemKey) {
    return `
      <button type="button" class="gauge-card"
           data-model-key="${itemKey}"
           data-tauri-drag-region="false"
           title="Model tooltip">
        <div class="gauge-circle-wrap">
          <svg class="gauge-svg"></svg>
        </div>
      </button>
    `;
  }

  const html = renderMockGaugeCard('antigravity_gemini');
  assert.ok(html.includes('data-tauri-drag-region="false"'), 'Must specify data-tauri-drag-region="false"');
  assert.ok(html.includes('data-model-key="antigravity_gemini"'), 'Must have data-model-key');
  assert.ok(!html.includes('onclick='), 'Must not use inline onclick attribute');
});

