import { ProviderQuotaExhaustedError, ProviderUnavailableError, quotaResetAtFromOutput } from '../routing/quota.js';
import type { ModelAlias } from '../config/routing-schema.js';
import type { StructuredTransport } from './types.js';

export interface FetchLike {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  message?: string;
}

export interface OpenAiCompatibleTransportOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
}

/**
 * Minimal OpenAI-compatible chat completion transport.
 *
 * Kept deliberately small: this is the structured-call path only, so no
 * streaming and no tools. The same transport serves Z.AI today and can serve
 * any OpenAI-compatible HTTP provider by adding a provider config entry.
 */
export function openAiCompatibleTransport(
  options: OpenAiCompatibleTransportOptions,
): StructuredTransport {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const doFetch = options.fetch ?? (fetch as unknown as FetchLike);

  return {
    name: `openai-compatible-${options.provider}`,

    supports(alias: ModelAlias): boolean {
      return alias.provider === options.provider;
    },

    async complete({ alias, system, user, timeoutMs }) {
      const body = {
        model: alias.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        ...(alias.reasoningEffort ? { reasoning_effort: alias.reasoningEffort } : {}),
        // Ask for an object; the transport still relies on local Ajv as the
        // real gate because `json_object` is not schema enforcement.
        response_format: { type: 'json_object' },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e.name === 'AbortError') {
          throw new ProviderUnavailableError(options.provider, `timed out after ${timeoutMs}ms`);
        }
        throw new ProviderUnavailableError(options.provider, `request failed: ${e.message ?? 'unknown error'}`);
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (response.status === 429 || response.status === 402 || /insufficient.*(balance|credit)/i.test(text)) {
        throw new ProviderQuotaExhaustedError(
          options.provider,
          quotaResetAtFromOutput(text),
          `HTTP ${response.status}`,
        );
      }
      if (!response.ok) {
        throw new ProviderUnavailableError(options.provider, `returned HTTP ${response.status}: ${text.slice(0, 400)}`);
      }

      let parsed: OpenAiCompatibleResponse;
      try {
        parsed = JSON.parse(text) as OpenAiCompatibleResponse;
      } catch {
        throw new Error(`${options.provider} returned invalid JSON: ${text.slice(0, 300)}`);
      }

      const content = parsed.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error(`${options.provider} returned no message content`);
      }

      const inputTokens = parsed.usage?.prompt_tokens;
      const outputTokens = parsed.usage?.completion_tokens;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        const usage: { inputTokens?: number; outputTokens?: number } = {};
        if (inputTokens !== undefined) usage.inputTokens = inputTokens;
        if (outputTokens !== undefined) usage.outputTokens = outputTokens;
        return { text: content, usage };
      }
      return { text: content };
    },
  };
}
