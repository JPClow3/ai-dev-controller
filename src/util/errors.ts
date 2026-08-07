/** Thrown by scaffold stubs. Every occurrence is a v1 implementation task. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NOT_IMPLEMENTED: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** A model recommended a transition the controller refuses to perform. */
export class IllegalTransitionError extends Error {
  constructor(from: string, to: string, reason: string) {
    super(`Illegal transition ${from} -> ${to}: ${reason}`);
    this.name = 'IllegalTransitionError';
  }
}

/** A worker or orchestrator asked for something in safety.forbidden_operations. */
export class ForbiddenOperationError extends Error {
  constructor(operation: string) {
    super(`Forbidden operation refused: ${operation}`);
    this.name = 'ForbiddenOperationError';
  }
}

/** Retry / escalation budget exhausted. Routes the issue to BLOCKED_HUMAN. */
export class BudgetExhaustedError extends Error {
  constructor(budget: string) {
    super(`Budget exhausted: ${budget}`);
    this.name = 'BudgetExhaustedError';
  }
}
