/** Machine-readable validation output for `dynobox validate --reporter json`. */

import type {CompileDynosResult} from '../program/compileDynos.js';

const VALIDATE_SCHEMA = 'dynobox.validate.v1';

export function renderJsonValidateOutput(
  result: CompileDynosResult,
  filePaths: readonly string[],
): string {
  const compiledByPath = new Map(
    result.compiled.map((entry) => [entry.filePath, entry]),
  );
  const errorsByPath = new Map(
    result.errors.map((error) => [error.filePath, error]),
  );

  const fileRecords = filePaths.map((filePath) => {
    const compiled = compiledByPath.get(filePath);
    if (compiled !== undefined) {
      return {
        schema: VALIDATE_SCHEMA,
        type: 'file',
        filePath,
        status: 'valid',
        name: compiled.ir.name ?? null,
        scenarios: compiled.ir.scenarios.length,
      };
    }
    return {
      schema: VALIDATE_SCHEMA,
      type: 'file',
      filePath,
      status: 'invalid',
      error: {message: errorsByPath.get(filePath)?.message ?? 'invalid'},
    };
  });

  const records = [...fileRecords, summaryRecord(result)];
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function summaryRecord(result: CompileDynosResult) {
  const valid = result.compiled.length;
  const invalid = result.errors.length;
  return {
    schema: VALIDATE_SCHEMA,
    type: 'summary',
    status: invalid === 0 ? 'passed' : 'failed',
    totals: {
      files: valid + invalid,
      valid,
      invalid,
    },
  };
}
