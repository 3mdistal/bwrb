import type { ExitCode, JsonResult } from '../../lib/output.js';

export class JsonCommandError extends Error {
  result: JsonResult;
  exitCode: ExitCode;

  constructor(result: JsonResult, exitCode: ExitCode) {
    super('JSON command error');
    this.name = 'JsonCommandError';
    this.result = result;
    this.exitCode = exitCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, JsonCommandError);
    }
  }
}

export function throwJsonError(result: JsonResult, exitCode: ExitCode): never {
  throw new JsonCommandError(result, exitCode);
}
