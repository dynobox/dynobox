import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, expect, it, vi} from 'vitest';

import {runVerifyCommands} from './verify.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, {recursive: true, force: true})),
  );
});

it.each([false, true])(
  'cancels verification children (ignore SIGTERM: %s) and skips subsequent commands',
  async (ignoreTerm) => {
    const workDir = await mkdtemp(join(tmpdir(), 'dynobox-verify-cancel-'));
    roots.push(workDir);
    const abort = new AbortController();
    const pending = runVerifyCommands({
      workDir,
      signal: abort.signal,
      scenario: {
        assertions: [
          {
            id: 'wait',
            type: 'verify.command',
            command: `node -e '${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''} require("node:fs").writeFileSync("started", String(process.pid)); setTimeout(() => {}, 3000)'; true`,
            exitCode: 0,
          },
          {
            id: 'next',
            type: 'verify.command',
            command: 'touch should-not-run',
            exitCode: 0,
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(existsSync(join(workDir, 'started'))).toBe(true),
    );
    const cancelledAt = Date.now();
    abort.abort();
    const results = await pending;
    expect(Date.now() - cancelledAt).toBeLessThan(2500);
    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).not.toBe(0);
    expect(existsSync(join(workDir, 'should-not-run'))).toBe(false);
    const childPid = Number(readFileSync(join(workDir, 'started'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
  },
);

it('does not launch verification after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  expect(
    await runVerifyCommands({
      workDir: '/not-a-workspace',
      signal: abort.signal,
      scenario: {
        assertions: [
          {id: 'skip', type: 'verify.command', command: 'exit 0', exitCode: 0},
        ],
      },
    }),
  ).toEqual([]);
});
