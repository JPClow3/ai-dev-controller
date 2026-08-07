import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadControllerConfig, ConfigError } from '../../src/config/load-config.js';

const ROOT = process.cwd();

/** Copy the real config into a temp root so a test can corrupt one file. */
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-dev-config-'));
  mkdirSync(join(dir, 'config'));
  mkdirSync(join(dir, 'projects'));
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  cpSync(join(ROOT, 'projects'), join(dir, 'projects'), { recursive: true });
  return dir;
}

describe('loadControllerConfig', () => {
  it('loads the approved global defaults', () => {
    const config = loadControllerConfig(ROOT);
    expect(config.global.concurrency.activeIssues).toBe(4);
    expect(config.global.concurrency.workersPerIssue).toBe(3);
    expect(config.global.concurrency.globalAgents).toBe(7);
    const total = Object.values(config.scoring.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });

  it('applies the approved sub-limits and poll interval', () => {
    const { concurrency } = loadControllerConfig(ROOT).global;
    expect(concurrency.gptHeavyAgents).toBe(2);
    expect(concurrency.gptLunaWorkers).toBe(3);
    expect(concurrency.ollamaWorkers).toBe(3);
    expect(concurrency.agentsPerRepository).toBe(5);
    expect(loadControllerConfig(ROOT).global.pollIntervalSeconds).toBe(45);
  });

  it('translates snake_case YAML into camelCase runtime objects', () => {
    const config = loadControllerConfig(ROOT);
    expect(config.global.linear.labels.needsContext).toBe('ai-needs-context');
    expect(config.global.git.branchPrefix).toBe('ai/');
    expect(config.scoring.promotion.lowRisk.minimumChallengerSamples).toBe(12);
  });

  it('keeps the human as merge authority and distrusts inferred dependencies', () => {
    const config = loadControllerConfig(ROOT);
    expect(config.global.github.autoMerge).toBe(false);
    expect(config.global.linear.trustInferredDependencies).toBe(false);
    expect(config.global.safety.forbiddenOperations).toContain('pr_merge');
  });

  it('exposes the approved promotion policy per risk tier', () => {
    const { promotion } = loadControllerConfig(ROOT).scoring;
    expect(promotion.lowRisk.automatic).toBe(true);
    expect(promotion.lowRisk.minimumScoreAdvantage).toBeCloseTo(0.08);
    expect(promotion.lowRisk.minimumSuccessRate).toBeCloseTo(0.7);
    expect(promotion.mediumRisk.automatic).toBe(false);
    expect(promotion.highRisk.experimentation).toBe(false);
  });

  it('rejects scoring weights that do not sum to 1.0', () => {
    const dir = scratchRoot();
    writeFileSync(
      join(dir, 'config/scoring.yaml'),
      `weights:
  acceptance_coverage: 0.50
  first_pass_ci: 0.25
  reviewer_defects: 0.15
  unnecessary_churn: 0.10
  resource_cost: 0.10
  wall_clock: 0.05
promotion:
  low_risk: { automatic: true, minimum_challenger_samples: 12, minimum_score_advantage: 0.08, minimum_success_rate: 0.70 }
  medium_risk: { automatic: false, propose_after_samples: 12 }
  high_risk: { automatic: false, experimentation: false }
champion_challenger: { exploration_rate: 0.15, eligible_risk: [low], dual_run: false }
acceptance:
  verdicts: [PASS, PARTIAL, FAIL, UNCERTAIN]
  points: { PASS: 1.0, PARTIAL: 0.5, FAIL: 0.0, UNCERTAIN: 0.25 }
  require_evidence: true
first_pass_ci: { penalty_per_remediation_cycle: 0.35 }
reviewer_defects:
  severity_penalty: { critical: 1.0, high: 0.55, medium: 0.20, low: 0.05 }
churn:
  penalty: { unrelated_refactor: 0.30 }
wall_clock:
  target_minutes_by_role: { routine_bugfix: 15 }
  penalty_per_target_multiple: 0.25
`,
    );
    expect(() => loadControllerConfig(dir)).toThrow(ConfigError);
    expect(() => loadControllerConfig(dir)).toThrow(/sum to 1\.0/);
  });

  it('rejects a routing role whose champion is not a declared alias', () => {
    const dir = scratchRoot();
    const routing = `aliases:
  luna_high: { family: openai, harness: codex, provider: chatgpt, profile: gpt-luna-high }
roles:
  routine_bugfix: { champion: does_not_exist, challengers: [] }
risk_gates:
  low: { allow_challenger: true }
  medium: { allow_challenger: false }
  high: { allow_challenger: false, locked_role: high_risk }
review:
  integration: { strategy: opposite_family_from_authors }
  final: { strategy: least_involved_family }
  escalation: luna_high
pressure:
  states: [LOW, NORMAL, HIGH, EXHAUSTED]
  default: NORMAL
  scarcity_multiplier: { LOW: 0.6, NORMAL: 1.0, HIGH: 2.0, EXHAUSTED: 999.0 }
  utility_weights: { expected_score: 1.0, scarcity_penalty: 0.25, latency_penalty: 0.05 }
  sources: [manual_override]
`;
    writeFileSync(join(dir, 'config/routing.yaml'), routing);
    expect(() => loadControllerConfig(dir)).toThrow(/unknown alias "does_not_exist"/);
  });

  it('requires requirement_ambiguity to escalate to a human', () => {
    const dir = scratchRoot();
    writeFileSync(
      join(dir, 'config/escalation.yaml'),
      `limits: { same_model_repair: 1, worker_escalations: 2, review_remediation_cycles: 2, sol_adjudications: 1 }
failure_routes:
  mechanical: [same_model]
  localized_logic: [cross_family_routine]
  context_insufficient: [large_context]
  architecture_integration: [orchestrator]
  reviewer_dispute: [high_risk]
  flaky_environmental: [rerun_ci]
  requirement_ambiguity: [complex_worker]
  unknown: [human]
cross_family_preference: { openai: [kimi_code] }
review_remediation:
  orchestrator_validates_finding: true
  remediation_worker: different_from_original_author
  reviewer_rechecks: true
  blocking_severities: [critical, high]
human_escalation_triggers: [unresolved_requirement]
`,
    );
    expect(() => loadControllerConfig(dir)).toThrow(/must route to "human"/);
  });

  it('every routing alias maps to a Codex profile', () => {
    const { aliases } = loadControllerConfig(ROOT).routing;
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const [name, alias] of Object.entries(aliases)) {
      expect(alias.profile, `${name} must declare a Codex profile`).toBeTruthy();
      expect(alias.harness).toBe('codex');
    }
  });
});
