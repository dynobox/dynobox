import type {HarnessResult, HarnessRunOutput} from './harnesses/index.js';
import type {SetupResult} from './setup.js';

export function setupFailureDiagnostic(setupResult: SetupResult): string {
  const failed = setupResult.logs.find((log) => log.exitCode !== 0);
  if (failed === undefined) return 'Scenario setup failed.';

  const stderr = failed.stderr.trim();
  return stderr.length === 0
    ? `Setup command failed with exit code ${failed.exitCode}: ${failed.command}`
    : `Setup command failed with exit code ${failed.exitCode}: ${failed.command}\n${stderr}`;
}

export function harnessExitDiagnostic(
  harnessResult: HarnessResult,
  harnessOutput: HarnessRunOutput,
): string {
  const stderr = harnessOutput.stderr.trim();
  const detail = stderr || harnessResult.errorMessage?.trim();
  return detail === undefined || detail.length === 0
    ? `Harness exited with code ${harnessResult.exitCode}.`
    : `Harness exited with code ${harnessResult.exitCode}: ${detail}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
