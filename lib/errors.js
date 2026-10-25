export class TowerError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'TowerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function assertTower(condition, code, message, details = undefined) {
  if (!condition) throw new TowerError(code, message, details);
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetails(error) {
  if (error instanceof TowerError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { code: 'INTERNAL_ERROR', message: errorMessage(error) };
}
