import type { DashboardSnapshot } from './snapshot.js';

const WIDTH = 72;

function bar(value: number, width = 20): string {
  const capped = Math.max(0, Math.min(1, value));
  const filled = Math.round(capped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function tokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Pure ANSI renderer. No layout framework: this function turns a snapshot into
 * a fixed-width string, which makes it trivial to unit test and keeps the raw
 * mode driver in the CLI separate from presentation.
 */
export function renderDashboard(snapshot: DashboardSnapshot): string {
  const lines: string[] = [];
  lines.push(`\x1b[2J\x1b[H\x1b[1m AI DEV CONTROLLER — PROVIDERS & USAGE \x1b[0m`);
  lines.push(`${snapshot.generatedAt}   [r] refresh  [q] quit`);
  lines.push('');

  lines.push('\x1b[1mPROVIDERS\x1b[0m');
  lines.push(
    `${pad('provider', 14)} ${pad('transport', 24)} ${pad('pressure', 10)} ${pad('tokens', 8)} allowance`,
  );
  lines.push('-'.repeat(WIDTH));

  for (const provider of snapshot.providers) {
    const connected = provider.connected ? 'ok' : 'down';
    const auth = provider.authOk ? 'auth' : 'no-auth';
    const usageTokens = (provider.usage?.inputTokens ?? 0) + (provider.usage?.outputTokens ?? 0);
    const allowance =
      provider.remainingAllowance != null
        ? ` ${bar(provider.remainingAllowance)} ${(provider.remainingAllowance * 100).toFixed(0)}%`
        : provider.monthlyTokenLimit != null
          ? ` limit ${tokens(provider.monthlyTokenLimit)}`
          : ' unknown';

    lines.push(
      `${pad(provider.displayName, 14)} ${pad(provider.transport, 24)} ${pad(
        `${provider.state}/${provider.auth}/${connected}/${auth}`,
        10,
      )} ${pad(tokens(usageTokens), 8)}${allowance}`,
    );
    if (provider.detail) lines.push(`  ${provider.detail.slice(0, WIDTH - 2)}`);
  }
  lines.push('');

  lines.push('\x1b[1mROLE ROUTING\x1b[0m');
  lines.push(`${pad('role', 24)} ${pad('champion', 24)} challengers`);
  lines.push('-'.repeat(WIDTH));
  for (const role of snapshot.roles) {
    const challengers = role.challengers.map((c) => `${c.alias}(${c.provider})`).join(', ');
    lines.push(`${pad(role.role, 24)} ${pad(`${role.champion} (${role.championProvider})`, 24)} ${challengers}`);
  }
  lines.push('');

  lines.push('\x1b[1mRECENT DAILY USAGE\x1b[0m');
  const byDay = new Map<string, Map<string, number>>();
  for (const row of snapshot.usageHistory) {
    const day = byDay.get(row.day) ?? new Map<string, number>();
    day.set(row.provider, (day.get(row.provider) ?? 0) + row.tokens);
    byDay.set(row.day, day);
  }
  const days = [...byDay.keys()].sort().slice(-14);
  if (days.length === 0) {
    lines.push('  no usage recorded yet');
  } else {
    const providers = new Set(snapshot.usageHistory.map((r) => r.provider));
    lines.push(`  ${days.map((d) => d.slice(5)).join('  ')}`);
    for (const provider of providers) {
      const spark = days.map((day) => {
        const tokensForDay = byDay.get(day)?.get(provider) ?? 0;
        return tokensForDay === 0 ? ' ' : tokensForDay < 10_000 ? '.' : tokensForDay < 100_000 ? '*' : '#';
      }).join('  ');
      lines.push(`  ${pad(provider, 10)} ${spark}`);
    }
  }

  return lines.join('\n');
}
