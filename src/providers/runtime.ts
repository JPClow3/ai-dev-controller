import type { RoutingConfig } from '../config/routing-schema.js';
import type { ProvidersConfig } from '../config/providers-schema.js';
import type { PlanTier } from '../config/providers-schema.js';
import { planAllowsModel } from './catalog.js';
import type { ProviderProbeResult } from './probe.js';
import type { PressureMap } from '../routing/pressure.js';

export const PROVIDER_RUNTIME_STATES = [
  'ready',
  'unavailable',
  'plan_blocked',
  'quota_cooldown',
  'disabled',
] as const;
export type ProviderRuntimeState = (typeof PROVIDER_RUNTIME_STATES)[number];

export type ProviderAuthState = 'verified' | 'unknown' | 'failed';
export const PROVIDER_HEALTH_RECHECK_INTERVAL_MS = 5 * 60_000;

export interface ProviderRuntimeStatus {
  provider: string;
  state: ProviderRuntimeState;
  auth: ProviderAuthState;
  reason: string;
  nextProbeAt: string | null;
}

export interface AliasEligibility {
  eligible: boolean;
  state: ProviderRuntimeState;
  reason: string;
}

export interface ProviderEligibilitySnapshot {
  providers: Record<string, ProviderRuntimeStatus>;
  aliases: Record<string, AliasEligibility>;
}

export interface BuildEligibilityOptions {
  providers: ProvidersConfig;
  routing: RoutingConfig;
  pressure: PressureMap;
  probes?: ProviderProbeResult[];
  unavailableTransports?: Record<string, string>;
  persisted?: Array<ProviderRuntimeStatus>;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
}

/**
 * This is the sole translation from operational provider state to routing
 * eligibility. Selectors never infer availability from a normal pressure
 * value: an alias must pass through this snapshot first.
 */
export function buildProviderEligibility(options: BuildEligibilityOptions): ProviderEligibilitySnapshot {
  const now = options.now ?? new Date();
  const probes = new Map((options.probes ?? []).map((probe) => [probe.provider, probe]));
  const persisted = new Map((options.persisted ?? []).map((status) => [status.provider, status]));
  const unavailable = options.unavailableTransports ?? {};
  const nextHealthProbe = new Date(now.getTime() + PROVIDER_HEALTH_RECHECK_INTERVAL_MS).toISOString();
  const providers: Record<string, ProviderRuntimeStatus> = {};

  for (const [id, config] of Object.entries(options.providers.providers)) {
    const probe = probes.get(id);
    const previous = persisted.get(id);
    const pressure = options.pressure[id];
    if (!config.enabled) {
      providers[id] = { provider: id, state: 'disabled', auth: 'failed', reason: 'disabled in config', nextProbeAt: null };
    } else if (unavailable[id]) {
      providers[id] = { provider: id, state: 'unavailable', auth: 'failed', reason: unavailable[id]!, nextProbeAt: nextHealthProbe };
    } else if (pressure?.pressure === 'EXHAUSTED') {
      providers[id] = {
        provider: id,
        state: pressure.source === 'transport_unavailable' ? 'unavailable' : 'quota_cooldown',
        auth: previous?.auth ?? 'unknown',
        reason: pressure.source,
        nextProbeAt: pressure.resetAt ?? previous?.nextProbeAt ?? null,
      };
    } else if (probe && !probe.connected) {
      providers[id] = { provider: id, state: 'unavailable', auth: 'failed', reason: probe.detail, nextProbeAt: nextHealthProbe };
    } else if (!probe && previous?.state === 'unavailable' && previous.nextProbeAt && new Date(previous.nextProbeAt) > now) {
      providers[id] = previous;
    } else {
      // HTTP providers can be configured without a billable model call. Their
      // key is therefore eligible but explicitly shown as unverified.
      providers[id] = {
        provider: id,
        state: 'ready',
        auth: probe?.authOk ? 'verified' : 'unknown',
        reason: probe?.detail ?? 'configured',
        nextProbeAt: null,
      };
    }
  }

  const aliases: Record<string, AliasEligibility> = {};
  for (const [aliasId, alias] of Object.entries(options.routing.aliases)) {
    const provider = providers[alias.provider];
    if (!provider || provider.state !== 'ready') {
      aliases[aliasId] = {
        eligible: false,
        state: provider?.state ?? 'unavailable',
        reason: provider?.reason ?? `provider ${alias.provider} is not configured`,
      };
    } else if (alias.provider === 'commandcode') {
      const commandCode = options.providers.providers.commandcode;
      const configuredPlan = options.env?.['COMMAND_CODE_PLAN']?.trim();
      const plan: PlanTier = configuredPlan && ['go', 'goat', 'pro', 'max'].includes(configuredPlan)
        ? configuredPlan as PlanTier
        : (commandCode.transport === 'command-code-cli' ? commandCode.plan : 'go');
      if (!planAllowsModel(plan, alias.model)) {
        aliases[aliasId] = {
          eligible: false,
          state: 'plan_blocked',
          reason: `model ${alias.model} is unavailable on Command Code plan ${plan}`,
        };
      } else {
        aliases[aliasId] = { eligible: true, state: 'ready', reason: 'ready' };
      }
    } else {
      aliases[aliasId] = { eligible: true, state: 'ready', reason: 'ready' };
    }
  }

  for (const [provider, status] of Object.entries(providers)) {
    if (status.state !== 'ready') continue;
    const configuredAliases = Object.entries(options.routing.aliases)
      .filter(([, alias]) => alias.provider === provider)
      .map(([aliasId]) => aliases[aliasId]!);
    if (configuredAliases.length > 0 && configuredAliases.every((alias) => alias.state === 'plan_blocked')) {
      providers[provider] = {
        ...status,
        state: 'plan_blocked',
        reason: configuredAliases[0]?.reason ?? 'every configured alias is blocked by provider plan',
        nextProbeAt: null,
      };
    }
  }

  return { providers, aliases };
}
