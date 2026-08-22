import type { ProviderConfig } from '../config/providers-schema.js';
import type { Pressure } from '../routing/types.js';
import type { ProviderProbeResult } from '../providers/probe.js';
import type { ProviderEligibilitySnapshot, ProviderRuntimeState, ProviderAuthState } from '../providers/runtime.js';

export interface ProviderUsageSummary {
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DashboardProviderRow {
  id: string;
  displayName: string;
  transport: string;
  enabled: boolean;
  state: ProviderRuntimeState;
  auth: ProviderAuthState;
  connected: boolean;
  authOk: boolean;
  pressure: Pressure;
  detail: string;
  usage: ProviderUsageSummary | null;
  remainingAllowance: number | null;
  monthlyTokenLimit: number | null;
}

export interface DashboardRoleRow {
  role: string;
  champion: string;
  championProvider: string;
  challengers: Array<{ alias: string; provider: string }>;
}

export interface DashboardSnapshot {
  generatedAt: string;
  providers: DashboardProviderRow[];
  roles: DashboardRoleRow[];
  usageHistory: Array<{ day: string; provider: string; tokens: number }>;
}

export interface SnapshotDeps {
  providerConfigs: Record<string, ProviderConfig>;
  probes: ProviderProbeResult[];
  pressures: Record<string, { pressure: Pressure; remainingAllowance: number | null }>;
  usage: ProviderUsageSummary[];
  usageHistory: Array<{ day: string; provider: string; tokens: number }>;
  routing: {
    aliases: Record<string, { provider: string }>;
    roles: Record<string, { champion: string; challengers: string[] }>;
  };
  eligibility?: ProviderEligibilitySnapshot;
  now?: () => Date;
}

export function buildSnapshot(deps: SnapshotDeps): DashboardSnapshot {
  const now = deps.now ?? (() => new Date());
  const probeByProvider = new Map(deps.probes.map((p) => [p.provider, p]));
  const usageByProvider = new Map(deps.usage.map((u) => [u.provider, u]));

  const providers = Object.entries(deps.providerConfigs).map<DashboardProviderRow>(
    ([id, config]) => {
      const probe = probeByProvider.get(id);
      const pressure = deps.pressures[id];
      const runtime = deps.eligibility?.providers[id];
      return {
        id,
        displayName: config.displayName,
        transport: config.transport,
        enabled: config.enabled,
        state: runtime?.state ?? (config.enabled ? 'ready' : 'disabled'),
        auth: runtime?.auth ?? (probe?.authOk ? 'verified' : 'unknown'),
        connected: probe?.connected ?? false,
        authOk: probe?.authOk ?? false,
        pressure: pressure?.pressure ?? 'NORMAL',
        detail: runtime?.reason ?? probe?.detail ?? '',
        usage: usageByProvider.get(id) ?? null,
        remainingAllowance: pressure?.remainingAllowance ?? null,
        monthlyTokenLimit: config.monthlyTokenLimit,
      };
    },
  );

  const roles = Object.entries(deps.routing.roles).map<DashboardRoleRow>(([role, spec]) => ({
    role,
    champion: spec.champion,
    championProvider: deps.routing.aliases[spec.champion]?.provider ?? 'unknown',
    challengers: spec.challengers.map((alias) => ({
      alias,
      provider: deps.routing.aliases[alias]?.provider ?? 'unknown',
    })),
  }));

  return {
    generatedAt: now().toISOString(),
    providers,
    roles,
    usageHistory: deps.usageHistory,
  };
}
