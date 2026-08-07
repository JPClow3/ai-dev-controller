import { validate, extractJson } from './validate.js';

/** Confirms every schema compiles and the conditional requirements actually bite. */
const cases: Array<[string, boolean, unknown]> = [
  [
    'curated-issue: valid',
    true,
    {
      verdict: 'curated',
      issue_id: 'HFS-142',
      repository: 'hefesto-backend',
      title: 'Add filtering to risk map',
      body: '# Goal\n...',
      task_category: 'routine_behavior_change',
      risk: 'medium',
      acceptance_criteria: [{ id: 'AC-1', statement: 'Filter applies to results.' }],
    },
  ],
  ['curated-issue: curated without criteria must fail', false, { verdict: 'curated', issue_id: 'X' }],
  [
    'curated-issue: needs_context requires the block',
    false,
    { verdict: 'needs_context', issue_id: 'HFS-143' },
  ],
  [
    'implementation-plan: blocked requires reason',
    false,
    { verdict: 'blocked', issue_id: 'HFS-144' },
  ],
  [
    'worker-result: scope_conflict requires detail',
    false,
    { verdict: 'scope_conflict', issue_id: 'H-1', task_id: 'api', worker: { id: 'luna_high' } },
  ],
  [
    'review: escalate requires a reason',
    false,
    {
      verdict: 'escalate',
      issue_id: 'H-1',
      stage: 'final',
      reviewer: { id: 'glm_5_2' },
      criteria: [{ id: 'AC-1', status: 'uncertain' }],
    },
  ],
  [
    'failure: requirement_ambiguity requires a human question',
    false,
    {
      class: 'requirement_ambiguity',
      confidence: 0.9,
      root_cause: 'undetermined behaviour',
      blast_radius: 'single_task',
      evidence: [{ source: 'reviewer', excerpt: 'no spec' }],
    },
  ],
];

const schemaOf: Record<string, Parameters<typeof validate>[0]> = {
  'curated-issue': 'curated-issue',
  'implementation-plan': 'implementation-plan',
  'worker-result': 'worker-result',
  review: 'review',
  failure: 'failure',
};

let failures = 0;
for (const [name, expectOk, payload] of cases) {
  const key = name.split(':')[0] as string;
  const result = validate(schemaOf[key]!, payload);
  const pass = result.ok === expectOk;
  if (!pass) failures += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : ` -> ${result.errors.join('; ')}`}`);
}

const fenced = extractJson('Here you go:\n```json\n{"verdict":"approve"}\n```\nthanks');
console.log(`ok    extractJson unwraps fenced output: ${JSON.stringify(fenced)}`);

console.log(failures === 0 ? 'ALL SCHEMA CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
