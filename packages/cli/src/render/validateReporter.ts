/** Machine-readable validation output for `dynobox validate --reporter json`. */

import type {CompileDynosResult} from '../program/compileDynos.js';

const VALIDATE_SCHEMA = 'dynobox.validate.v1';

export function renderJsonValidateOutput(result: CompileDynosResult): string {
  const records = [
    ...result.compiled.map((entry) => ({
      schema: VALIDATE_SCHEMA,
      type: 'file',
      filePath: entry.filePath,
      status: 'valid',
      name: entry.ir.name ?? null,
      scenarios: entry.ir.scenarios.length,
    })),
    ...result.errors.map((error) => ({
      schema: VALIDATE_SCHEMA,
      type: 'file',
      filePath: error.filePath,
      status: 'invalid',
      error: {message: error.message},
    })),
    summaryRecord(result),
  ];

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
