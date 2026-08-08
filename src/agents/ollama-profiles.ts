import type { ModelAlias } from '../config/routing-schema.js';
import type { StructuredTransport } from './types.js';

/**
 * Ollama Cloud over its OpenAI-compatible HTTP endpoint.
 *
 * Preferred for structured calls even though the worker path goes through
 * Codex: this is one request with one JSON response, and `response_format`
 * gives a far stronger guarantee than asking a coding agent to please only
 * print JSON.
 */
export function ollamaTransport(baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1'): StructuredTransport {
  return {
    name: 'ollama-http',

    supports(alias: ModelAlias): boolean {
      return alias.provider === 'ollama' || alias.provider === 'ollama_local';
    },

    async complete({ alias, system, user, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env['OLLAMA_API_KEY']
              ? { authorization: `Bearer ${process.env['OLLAMA_API_KEY']}` }
              : {}),
          },
          body: JSON.stringify({
            model: modelName(alias),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            // Structured work is not creative work.
            temperature: 0,
            response_format: { type: 'json_object' },
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Ollama ${response.status} ${response.statusText}: ${body.slice(0, 400)}`);
        }

        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('Ollama returned an empty completion');

        // Built key-by-key: exactOptionalPropertyTypes rejects an explicit
        // `undefined` for an optional field, and Ollama omits usage sometimes.
        const usage: { inputTokens?: number; outputTokens?: number } = {};
        if (json.usage?.prompt_tokens !== undefined) usage.inputTokens = json.usage.prompt_tokens;
        if (json.usage?.completion_tokens !== undefined) usage.outputTokens = json.usage.completion_tokens;

        return Object.keys(usage).length > 0 ? { text, usage } : { text };
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`Ollama call to ${modelName(alias)} timed out after ${timeoutMs}ms`);
        }
        if (err instanceof TypeError) {
          throw new Error(
            `Cannot reach Ollama at ${baseUrl}. Is the Ollama app running, and has \`ollama signin\` been done?`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The routing alias stores the Codex *profile* name. For a direct HTTP call we
 * need the underlying model tag, which the profile name does not carry, so it
 * is derived from the alias id.
 */
const MODEL_BY_ALIAS: Readonly<Record<string, string>> = {
  'ollama-glm': 'glm-5.2:cloud',
  'ollama-kimi': 'kimi-k2.7-code:cloud',
  'ollama-deepseek': 'deepseek-v4-flash:cloud',
};

export function modelName(alias: ModelAlias): string {
  // An explicitly declared tag always wins; the table is only a fallback for
  // the three cloud aliases that predate the `model` field.
  const model = alias.model ?? MODEL_BY_ALIAS[alias.profile];
  if (!model) {
    throw new Error(
      `No Ollama model tag for alias profile "${alias.profile}". Add a \`model:\` field in config/routing.yaml.`,
    );
  }
  return model;
}
