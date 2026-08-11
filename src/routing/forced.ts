import type { RoutingConfig } from '../config/routing-schema.js';

/** Pins ordinary pilot work to one alias without weakening risk-gate roles. */
export function forcePilotAlias(routing: RoutingConfig, alias: string): RoutingConfig {
  if (!routing.aliases[alias]) throw new Error(`Unknown forced routing alias "${alias}"`);
  const lockedRoles = new Set(
    Object.values(routing.risk_gates)
      .map((gate) => gate.lockedRole)
      .filter((role): role is string => Boolean(role)),
  );

  return {
    ...routing,
    roles: Object.fromEntries(
      Object.entries(routing.roles).map(([name, role]) => [
        name,
        lockedRoles.has(name) ? role : { champion: alias, challengers: [] },
      ]),
    ),
  };
}
