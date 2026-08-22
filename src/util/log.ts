import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
export interface LogContext { correlationId?: string; runId?: string; issueId?: string }
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env['AI_DEV_LOG_LEVEL'] as Level) ?? 'info'] ?? 20;
const context = new AsyncLocalStorage<LogContext>();
let directory: string | null = null;

export function configurePersistentLogging(options: { directory: string }): void {
  mkdirSync(options.directory, { recursive: true });
  directory = options.directory;
}
export function newCorrelationId(): string { return randomUUID(); }
export function withLogContext<T>(value: LogContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...value }, work);
}
function serialise(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}
function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const current = context.getStore() ?? {};
  const event = {
    timestamp: new Date().toISOString(), level, scope, message,
    correlationId: current.correlationId ?? newCorrelationId(),
    ...(current.runId ? { runId: current.runId } : {}),
    ...(current.issueId ? { issueId: current.issueId } : {}),
    ...(extra === undefined ? {} : { extra: serialise(extra) }),
  };
  console.error(`${event.timestamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`);
  if (!directory) return;
  try {
    const name = (current.runId ?? 'controller').replace(/[^a-zA-Z0-9._-]/g, '_');
    appendFileSync(join(directory, `${name}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    console.error(`logging persistence failed: ${(error as Error).message}`);
  }
}
export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
