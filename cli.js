import { pluginManager } from './src/plugins/index.js';
import { toDisplayAccount } from './src/viewmodel.js';

// Simple ANSI color helpers (no external dependency required)
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
};

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function padVisible(str, width, align = 'left') {
  const visibleLen = stripAnsi(str).length;
  const pad = Math.max(0, width - visibleLen);
  if (align === 'right') return ' '.repeat(pad) + str;
  return str + ' '.repeat(pad);
}

const colWidths = [16, 24, 32, 32, 11];

function formatRow(cols) {
  return `${colors.dim}│${colors.reset} ` + cols.map((c, i) => padVisible(c, colWidths[i])).join(` ${colors.dim}│${colors.reset} `) + ` ${colors.dim}│${colors.reset}`;
}

function makeBorder(start, mid, end, fill = '─') {
  return `${colors.dim}${start}` + colWidths.map(w => fill.repeat(w + 2)).join(mid) + `${end}${colors.reset}`;
}

function formatPercent(pct) {
  if (pct === null || pct === undefined) return `${colors.gray}N/A${colors.reset}`;
  if (pct > 50) return `${colors.green}${pct.toFixed(1)}%${colors.reset}`;
  if (pct >= 20) return `${colors.yellow}${pct.toFixed(1)}%${colors.reset}`;
  return `${colors.red}${pct.toFixed(1)}%${colors.reset}`;
}

function formatStatus(status) {
  switch (status) {
    case 'OK':
      return `${colors.green}● ACTIVE${colors.reset}`;
    case 'WARNING':
      return `${colors.yellow}▲ LOW QUOTA${colors.reset}`;
    case 'EXHAUSTED':
      return `${colors.red}✖ EXHAUSTED${colors.reset}`;
    case 'OFFLINE':
    case 'PROMPT_START':
      return `${colors.red}○ NOT RUNNING${colors.reset}`;
    case 'UNCONFIGURED':
      return `${colors.gray}○ NO KEY${colors.reset}`;
    default:
      return `${colors.gray}${status}${colors.reset}`;
  }
}

function renderBar(pct, width = 8) {
  if (pct === null || pct === undefined) return `${colors.gray}${'░'.repeat(width)}${colors.reset}`;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  const barColor = pct > 50 ? colors.green : pct >= 20 ? colors.yellow : colors.red;
  return `${barColor}${'█'.repeat(filled)}${colors.gray}${'░'.repeat(empty)}${colors.reset}`;
}

function formatQuotaMetric(bucket) {
  if (!bucket) return `${colors.gray}N/A${colors.reset}`;
  const p = bucket.percentLeft;
  const bar = renderBar(p, 8);
  const cd = bucket.formattedCountdown || 'Ready';
  const time = bucket.formattedResetTime;

  let detail = cd;
  if (time && time !== 'N/A' && time !== 'Full') {
    detail = `${cd} @ ${time}`;
  } else if (p >= 100) {
    detail = 'Full';
  }
  return `${bar} ${formatPercent(p).padStart(6)} (${colors.cyan}${detail}${colors.reset})`;
}

async function run() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const forceRefresh = args.includes('--refresh') || args.includes('-r');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${colors.bold}LLM Quota Tracker${colors.reset} - Monitor 5-hour and weekly coding agent quotas

${colors.bold}USAGE:${colors.reset}
  node cli.js [OPTIONS]

${colors.bold}OPTIONS:${colors.reset}
  --json          Output in structured JSON format
  --refresh, -r   Bypass local cache and force-fetch fresh quotas
  --help, -h      Show this help message
`);
    process.exit(0);
  }

  const results = await pluginManager.fetchAllQuotas(forceRefresh);

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n${colors.bold}${colors.cyan}⚡ LLM Coding Agent Quota Monitor${colors.reset} ${colors.gray}(Multi-LLM 5h & Weekly)${colors.reset}\n`);

  // Print Table Header
  console.log(makeBorder('┌', '┬', '┐'));
  console.log(formatRow([
    `${colors.bold}Provider / LLM${colors.reset}`,
    `${colors.bold}Account / Model Family${colors.reset}`,
    `${colors.bold}5-Hour Quota (Rolling)${colors.reset}`,
    `${colors.bold}Weekly Quota (Cycle)${colors.reset}`,
    `${colors.bold}Status${colors.reset}`,
  ]));
  console.log(makeBorder('├', '┼', '┤'));

  let hasNotRunningAntigravity = false;
  let antigravityPrompt = '';

  for (const item of results) {
    const disp = toDisplayAccount(item);
    const provider = `${colors.bold}${disp.providerName.slice(0, 16)}${colors.reset}`;
    const account = (disp.accountEmail || disp.accountId).slice(0, 24);

    const fiveHStr = formatQuotaMetric(item.fiveHourQuota);
    const weeklyStr = formatQuotaMetric(item.weeklyQuota);
    const status = formatStatus(disp.status);

    if (disp.llms && disp.llms.length > 0 && disp.isRunning) {
      // Print parent summary row
      console.log(formatRow([
        provider,
        account,
        `${colors.dim}(${disp.llms.length} LLMs Monitored)${colors.reset}`,
        weeklyStr,
        status,
      ]));

      // Print individual LLM sub-rows
      disp.llms.forEach((llm, idx) => {
        const isLast = idx === disp.llms.length - 1;
        const branch = isLast ? '└─' : '├─';
        const llmNameFormatted = ` ${colors.dim}${branch}${colors.reset} ${colors.cyan}${llm.name}${colors.reset}`;
        const subAcc = `${colors.dim}${llm.name} Model Quota${colors.reset}`;

        const llm5h = formatQuotaMetric(llm.fiveHourQuota);
        const llmWk = formatQuotaMetric(llm.weeklyQuota);
        const llmStatus = formatStatus(llm.status);

        console.log(formatRow([
          llmNameFormatted,
          subAcc,
          llm5h,
          llmWk,
          llmStatus,
        ]));
      });
    } else {
      console.log(formatRow([
        provider,
        account,
        fiveHStr,
        weeklyStr,
        status,
      ]));
    }

    if (item.providerId === 'antigravity' && (item.status === 'OFFLINE' || item.status === 'PROMPT_START')) {
      hasNotRunningAntigravity = true;
      antigravityPrompt = item.actionPrompt || 'Please launch the Antigravity IDE or run "agy" in your terminal.';
    }
  }

  console.log(makeBorder('└', '┴', '┘') + '\n');

  // Print LLM breakdown for active providers
  const activeItems = results.filter((r) => r.isRunning && (r.llms?.length > 0 || r.models?.length > 0));
  for (const item of activeItems) {
    const disp = toDisplayAccount(item);
    console.log(`${colors.bold}${colors.cyan}LLM Quota Pools & Models (${disp.providerName}):${colors.reset}`);

    if (disp.llms && disp.llms.length > 0) {
      disp.llms.forEach((llm, lIdx) => {
        const isLastLLM = lIdx === disp.llms.length - 1;
        const llmBranch = isLastLLM ? '└─' : '├─';
        const h5Time = llm.fiveHourQuota?.formattedResetTime && llm.fiveHourQuota?.formattedResetTime !== 'N/A'
          ? `Back in action @ ${llm.fiveHourQuota.formattedResetTime}, in ${llm.fiveHourQuota.formattedCountdown}`
          : (llm.fiveHourQuota?.formattedCountdown || 'N/A');
        const wkTime = llm.weeklyQuota?.formattedResetTime && llm.weeklyQuota?.formattedResetTime !== 'N/A'
          ? `Back in action @ ${llm.weeklyQuota.formattedResetTime}, in ${llm.weeklyQuota.formattedCountdown}`
          : (llm.weeklyQuota?.formattedCountdown || 'N/A');

        const h5 = llm.fiveHourQuota ? `${formatPercent(llm.fiveHourQuota.percentLeft)} (${h5Time})` : 'N/A';
        const wk = llm.weeklyQuota ? `${formatPercent(llm.weeklyQuota.percentLeft)} (${wkTime})` : 'N/A';
        console.log(`  ${colors.dim}${llmBranch}${colors.reset} ${colors.bold}${llm.name}${colors.reset} ── 5h: ${h5} │ Weekly: ${wk}`);

        const llmModels = llm.models || [];
        llmModels.forEach((mName, mIdx) => {
          const isLastM = mIdx === llmModels.length - 1;
          const subBranch = isLastLLM ? (isLastM ? '    └─' : '    ├─') : (isLastM ? '│   └─' : '│   ├─');
          console.log(`  ${colors.dim}${subBranch}${colors.reset} ${colors.dim}${mName}${colors.reset}`);
        });
      });
    }
    console.log('');
  }

  if (hasNotRunningAntigravity) {
    console.log(`${colors.yellow}${colors.bold}⚠️  ACTION REQUIRED FOR ANTIGRAVITY:${colors.reset}`);
    console.log(`   ${colors.yellow}${antigravityPrompt}${colors.reset}\n`);
  }
}

run().catch((err) => {
  console.error('Execution error:', err);
  process.exit(1);
});
