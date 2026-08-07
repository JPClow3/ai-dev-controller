type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env['AI_DEV_LOG_LEVEL'] as Level) ?? 'info'] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra === undefined) console.error(line);
  else console.error(line, extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
