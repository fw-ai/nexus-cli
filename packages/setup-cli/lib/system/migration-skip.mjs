/**
 * Thrown by a forward migration that found work to do but cannot do it
 * right now (the harness app is running and would discard the edit on
 * exit). The forward-migration runner keeps going with the remaining
 * steps and turns the skip into a note asking the user to quit the app
 * and run `nexus <harness>` to apply that step, instead of silently
 * treating it as a no-op.
 */
export class MigrationSkippedError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationSkippedError";
  }
}

/** @param {unknown} error */
export function isMigrationSkipped(error) {
  return error instanceof MigrationSkippedError;
}
