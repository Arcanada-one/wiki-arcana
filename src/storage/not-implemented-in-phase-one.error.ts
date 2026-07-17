export class NotImplementedInPhaseOneError extends Error {
  constructor(capability: string) {
    super(`${capability} is intentionally unavailable in the initial release`);
    this.name = 'NotImplementedInPhaseOneError';
  }
}

