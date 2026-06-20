import type {VerifyCommandResult} from '@dynobox/evaluators';

export type VerifyCommandResultSummary = Pick<
  VerifyCommandResult,
  'exitCode' | 'stdout' | 'stderr'
>;

export function isVerifyCommandResult(
  value: unknown,
): value is VerifyCommandResultSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'exitCode' in value &&
    typeof value.exitCode === 'number' &&
    'stdout' in value &&
    typeof value.stdout === 'string' &&
    'stderr' in value &&
    typeof value.stderr === 'string'
  );
}

export function formatVerifyCommandResult(
  result: VerifyCommandResultSummary,
  formatOutput: (output: string) => string = (output) => output,
): string {
  return `exit ${result.exitCode}, stdout ${formatOutput(result.stdout)}, stderr ${formatOutput(result.stderr)}`;
}
