import { z } from 'zod';

export const PROVIDER_IDS = ['chatgpt', 'commandcode', 'zai', 'opencode', 'cline_pass'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_TRANSPORTS = [
  'codex-cli',
  'command-code-cli',
  'openai-compatible-http',
  'opencode-cli',
  'manual',
] as const;
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];

export const PLAN_TIERS = ['go', 'goat', 'pro', 'max'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

const common = {
  display_name: z.string(),
  enabled: z.boolean().default(true),
  monthly_token_limit: z.number().int().nonnegative().nullable().default(null),
};

const codexCli = z
  .object({ ...common, transport: z.literal('codex-cli'), bin: z.string().default('codex') })
  .transform((p) => ({
    transport: 'codex-cli' as const,
    displayName: p.display_name,
    enabled: p.enabled,
    monthlyTokenLimit: p.monthly_token_limit,
    bin: p.bin,
  }));

const commandCodeCli = z
  .object({
    ...common,
    transport: z.literal('command-code-cli'),
    bin: z.string().default('cmd'),
    plan: z.enum(PLAN_TIERS).default('go'),
  })
  .transform((p) => ({
    transport: 'command-code-cli' as const,
    displayName: p.display_name,
    enabled: p.enabled,
    monthlyTokenLimit: p.monthly_token_limit,
    bin: p.bin,
    plan: p.plan,
  }));

const openAiHttp = z
  .object({
    ...common,
    transport: z.literal('openai-compatible-http'),
    base_url: z.string(),
    api_key_env: z.string(),
  })
  .transform((p) => ({
    transport: 'openai-compatible-http' as const,
    displayName: p.display_name,
    enabled: p.enabled,
    monthlyTokenLimit: p.monthly_token_limit,
    baseUrl: p.base_url,
    apiKeyEnv: p.api_key_env,
  }));

const openCodeCli = z
  .object({ ...common, transport: z.literal('opencode-cli'), bin: z.string().default('opencode') })
  .transform((p) => ({
    transport: 'opencode-cli' as const,
    displayName: p.display_name,
    enabled: p.enabled,
    monthlyTokenLimit: p.monthly_token_limit,
    bin: p.bin,
  }));

const manual = z
  .object({ ...common, transport: z.literal('manual') })
  .transform((p) => ({
    transport: 'manual' as const,
    displayName: p.display_name,
    enabled: p.enabled,
    monthlyTokenLimit: p.monthly_token_limit,
  }));

export const providersConfigSchema = z
  .object({
    providers: z.record(
      z.enum(PROVIDER_IDS),
      z.discriminatedUnion('transport', [codexCli, commandCodeCli, openAiHttp, openCodeCli, manual]),
    ),
  })
  .transform((cfg) => ({ providers: cfg.providers }));

export type ProvidersConfig = z.infer<typeof providersConfigSchema>;
export type ProviderConfig = ProvidersConfig['providers'][ProviderId];
