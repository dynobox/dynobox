import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  AntigravityHarness,
  buildAntigravityArgs,
  parseAntigravityJson,
  parseAntigravityJsonLine,
} from './antigravity.js';
import type {HarnessRunOutput, ToolEvent} from './types.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-antigravity-test-'));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

afterEach(() => {
  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, {force: true, recursive: true});
  }
});

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('AntigravityHarness', () => {
  it('has the antigravity harness id and agy executable', () => {
    const harness = new AntigravityHarness();

    expect(harness.id).toBe('antigravity');
    expect(harness.executable).toBe('agy');
  });

  it('captures a custom executable version once', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-agy');
    const probeLog = join(scratchRoot, 'version-probes.log');
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '1.1.14'
  printf 'probe\\n' >> '${probeLog}'
  exit 0
fi
`,
      {mode: 0o755},
    );
    const harness = new AntigravityHarness({executable});

    await expect(
      Promise.all([harness.version(), harness.version()]),
    ).resolves.toEqual(['1.1.14', '1.1.14']);
    expect(readFileSync(probeLog, 'utf8')).toBe('probe\n');
  });

  it('builds isolated headless stream-json arguments', () => {
    expect(
      buildAntigravityArgs(
        '/tmp/work',
        'Say hello.',
        ['--effort', 'high'],
        'gemini-3.5-flash-medium',
      ),
    ).toEqual([
      '--new-project',
      '--add-dir',
      '/tmp/work',
      '-p',
      'Say hello.',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '30m',
      '--model',
      'gemini-3.5-flash-medium',
      '--effort',
      'high',
    ]);
  });

  it('skips all tool permissions only in dangerous mode', () => {
    expect(
      buildAntigravityArgs(
        '/tmp/work',
        'Run tests.',
        [],
        undefined,
        'dangerous',
      ),
    ).toEqual([
      '--new-project',
      '--add-dir',
      '/tmp/work',
      '-p',
      'Run tests.',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '30m',
      '--dangerously-skip-permissions',
    ]);
  });

  it('maps a Dynobox timeout onto Antigravity print-timeout', () => {
    expect(
      buildAntigravityArgs(
        '/tmp/work',
        'Say hello.',
        [],
        undefined,
        undefined,
        90_000,
      ),
    ).toEqual([
      '--new-project',
      '--add-dir',
      '/tmp/work',
      '-p',
      'Say hello.',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '90000ms',
    ]);
  });

  it('ignores stdin and emits completed tool events while streaming', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-agy');
    const stdinLog = join(scratchRoot, 'stdin.log');
    writeFileSync(
      executable,
      `#!/bin/sh
if IFS= read -r _; then
  printf 'input' > '${stdinLog}'
else
  printf 'eof' > '${stdinLog}'
fi
cat <<'JSONL'
{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pnpm test"}}}}
{"event":"step_update","step_update":{"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pnpm test"},"output":"passed"}}}
JSONL
`,
      {mode: 0o755},
    );
    const toolEvents: ToolEvent[] = [];
    const output = await new AntigravityHarness({executable}).run({
      prompt: 'Run tests.',
      workDir: scratchRoot,
      env: {},
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(output.exitCode).toBe(0);
    expect(readFileSync(stdinLog, 'utf8')).toBe('eof');
    expect(toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'run_command',
        input: {CommandLine: 'pnpm test', command: 'pnpm test'},
        command: 'pnpm test',
        status: 'success',
        message: 'passed',
      },
    ]);
  });

  it('extracts the terminal response and canonical tool events', () => {
    const stdout = jsonl(
      {
        event: 'init',
        conversation_id: 'conversation-1',
        init: {cwd: '/tmp/work', permission_mode: 'request-review'},
      },
      {
        event: 'step_update',
        step_update: {
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'write_to_file',
          tool_info: {
            name: 'write_to_file',
            parameters: {TargetFile: 'report.txt', CodeContent: 'done'},
            output: 'Wrote report.txt',
          },
        },
      },
      {
        event: 'step_update',
        step_update: {
          state: 'DONE',
          step_type: 'subagent',
          tool_name: 'invoke_subagent',
          subagent_info: {
            subagents: [{type_name: 'researcher', role: 'Find docs'}],
          },
        },
      },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Wrote report.txt\n',
          conversation_id: 'conversation-1',
        },
      },
    );
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 250,
    };

    const result = new AntigravityHarness().extractResult(raw);

    expect(result).toMatchObject({
      exitCode: 0,
      durationMs: 250,
      transcript: stdout,
      finalMessage: 'Wrote report.txt\n',
    });
    expect(result.toolEvents).toEqual([
      {
        kind: 'write_file',
        rawName: 'write_to_file',
        input: {TargetFile: 'report.txt', CodeContent: 'done'},
        status: 'success',
        message: 'Wrote report.txt',
      },
      {
        kind: 'task',
        rawName: 'invoke_subagent',
        input: {subagents: [{type_name: 'researcher', role: 'Find docs'}]},
        status: 'success',
      },
    ]);
  });

  it('captures failed tools without failing a successful run', () => {
    const parsed = parseAntigravityJson(
      jsonl(
        {
          event: 'step_update',
          step_update: {
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: {
              name: 'run_command',
              parameters: {CommandLine: 'git push'},
              error: {type: 'PERMISSION_DENIED', message: 'Requires approval'},
            },
          },
        },
        {
          event: 'result',
          result: {status: 'SUCCESS', response: 'The command was denied.'},
        },
      ),
    );

    expect(parsed.terminalFailure).toBe(false);
    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'run_command',
        input: {CommandLine: 'git push', command: 'git push'},
        command: 'git push',
        status: 'failure',
        message: 'Requires approval',
      },
    ]);
  });

  it('fails a non-success result even when Antigravity exits 0', () => {
    const result = new AntigravityHarness().extractResult({
      exitCode: 0,
      stdout: jsonl({
        event: 'result',
        result: {
          status: 'ERROR',
          response: '',
          error: 'authentication required',
        },
      }),
      stderr: 'authentication required',
      durationMs: 50,
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalMessage).toBeUndefined();
    expect(result.errorMessage).toBe('authentication required');
  });

  it('rejects malformed JSON with its line number', () => {
    expect(() => parseAntigravityJson('{not json}\n')).toThrow(
      'Failed to parse Antigravity JSON event 1',
    );
  });

  it('ignores non-tool step updates', () => {
    expect(
      parseAntigravityJsonLine(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            state: 'DONE',
            step_type: 'agent_response',
            text_delta: 'Done.',
          },
        }),
      ).toolEvents,
    ).toEqual([]);
  });
});
