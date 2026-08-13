import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { Agents } from '../agents/roles.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Git, GitRunner } from '../git/repository.js';
import type { SelectorDeps } from '../routing/selector.js';

/** Runtime bindings supplied by the composition root to the workflow steps. */
export interface StepsWiring {
  config: ControllerConfig;
  repos: ControllerRepositories;
  agents: Agents;
  orca: OrcaClient;
  github: GitHub;
  git: Git;
  gitRunner: GitRunner;
  routing: SelectorDeps;
  agentNameFor: (alias: string) => string;
  /** Set false in tests and dry runs so Linear is never written to. */
  writeToLinear?: boolean;
}
