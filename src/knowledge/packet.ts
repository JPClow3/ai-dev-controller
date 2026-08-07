import { NotImplementedError } from '../util/errors.js';

/**
 * Context packets, not context dumping.
 *
 * Shoving 80 Markdown files at every worker costs tokens, dilutes attention,
 * introduces conflicting guidance, and produces unnecessary edits. A database
 * worker gets migration rules and the models it touches; a frontend worker
 * gets a completely different packet.
 *
 * A worker also never receives other workers' conversations or speculative
 * reasoning - only their integrated commits matter.
 */
export interface ContextPacket {
  agentsMd: string;
  issueContract: string;
  taskDefinition: string;
  allowedScope: string[];
  knowledgeDocuments: Array<{ path: string; content: string }>;
  affectedSources: string[];
  validationCommands: Array<{ name: string; command: string }>;
  /** Populated only for remediation attempts. Kept as small as possible. */
  remediation?: {
    acceptanceCriteria: string[];
    failureOutput: string;
    currentDiff: string;
    instruction: string;
  };
}

export function build(_opts: {
  projectId: string;
  issueId: string;
  taskKey: string;
  contextRequirements: string[];
}): ContextPacket {
  throw new NotImplementedError('packet.build');
}

/** Rebuild larger when the classifier says missing_repository_context. */
export function rebuildWider(_opts: { projectId: string; issueId: string; taskKey: string }): ContextPacket {
  throw new NotImplementedError('packet.rebuildWider');
}

export function estimateTokens(_packet: ContextPacket): number {
  throw new NotImplementedError('packet.estimateTokens');
}
