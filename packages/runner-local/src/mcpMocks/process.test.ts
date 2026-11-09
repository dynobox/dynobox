import {describe, expect, it} from 'vitest';

import {startOwnedProcess} from '../processGroup.js';
import {McpHarnessError} from './errors.js';
import {collectMcpProcess} from './process.js';

function launch(source: string, timeout = 5000) {
  return startOwnedProcess(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    env: process.env,
    reject: false,
    timeout,
  });
}

describe('MCP process collection', () => {
  it('decodes split Unicode and consumes the final line without a newline', async () => {
    const lines: string[] = [];
    const {result, failure} = await collectMcpProcess(
      launch(`
        const bytes = Buffer.from('雪é\\r\\n\\nfinal');
        process.stdout.write(bytes.subarray(0, 1));
        setTimeout(() => process.stdout.write(bytes.subarray(1)), 20);
      `),
      {label: 'Fixture', onLine: (line) => lines.push(line)},
    );
    expect(lines).toEqual(['雪é', 'final']);
    expect(failure).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('雪é\r\n\nfinal');
  });

  it('stops processing after the first failure while retaining debug output', async () => {
    const error = new McpHarnessError('not_ready', 'Native readiness failed.');
    const lines: string[] = [];
    const {result, failure} = await collectMcpProcess(
      launch(
        `process.stdout.write('first\\nPRIVATE_PAYLOAD\\n'); setInterval(() => {}, 1000);`,
      ),
      {
        label: 'Fixture',
        onLine(line) {
          lines.push(line);
          throw error;
        },
      },
    );
    expect(lines).toEqual(['first']);
    expect(failure).toBe(error);
    expect(result.failed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('PRIVATE_PAYLOAD');
  });

  it('leaves a line truncated by a timeout unparsed', async () => {
    const lines: string[] = [];
    const {result, failure} = await collectMcpProcess(
      launch(
        `process.stdout.write('{}\\n{"partial'); setInterval(() => {}, 1000);`,
        2000,
      ),
      {
        label: 'Fixture',
        onLine(line) {
          lines.push(line);
          JSON.parse(line);
        },
      },
    );
    expect(result.timedOut).toBe(true);
    expect(lines).toEqual(['{}']);
    expect(failure).toBeUndefined();
  });

  it.each([
    [
      new SyntaxError('private syntax details'),
      'Fixture emitted unparseable JSON output.',
    ],
    [
      new Error('Failed to parse line: "PRIVATE_TO"', {
        cause: new SyntaxError('private syntax details'),
      }),
      'Fixture emitted unparseable JSON output.',
    ],
    [
      new Error('callback failed'),
      'Fixture event processing failed: callback failed',
    ],
    [undefined, 'Fixture event processing failed: undefined'],
  ])('captures parser and callback failures (%s)', async (error, message) => {
    const {failure} = await collectMcpProcess(
      launch(`process.stdout.write('final');`),
      {
        label: 'Fixture',
        onLine() {
          throw error;
        },
      },
    );
    expect(failure).toMatchObject({category: 'execution_failed', message});
  });
});
