export class InvalidAccessContextError extends Error {
  override readonly name = 'InvalidAccessContextError';

  constructor() {
    super('Storage access context is missing or malformed');
  }
}

export class AccessDeniedError extends Error {
  override readonly name = 'AccessDeniedError';

  constructor() {
    super('Storage access denied');
  }
}

export class InvalidStorageInputError extends Error {
  override readonly name = 'InvalidStorageInputError';

  constructor(field: string) {
    super(`Invalid storage input: ${field}`);
  }
}
