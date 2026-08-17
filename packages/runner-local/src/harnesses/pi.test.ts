import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {buildPiArgs, parsePiJson, parsePiJsonLine, PiHarness} from './pi.js';
import type {HarnessRunOutput, ToolEvent} from './types.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-pi-test-'));
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

describe('PiHarness', () => {
  it('has the pi harness id', () => {
    expect(new PiHarness().id).toBe('pi');
  });

  it('captures a custom executable version once', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-pi');
    const probeLog = join(scratchRoot, 'version-probes.log');
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '0.84.2'
  printf 'probe\\n' >> '${probeLog}'
  exit 0
fi
`,
      {mode: 0o755},
    );
    const harness = new PiHarness({executable});

    await expect(
      Promise.all([harness.version(), harness.version()]),
    ).resolves.toEqual(['0.84.2', '0.84.2']);
    expect(readFileSync(probeLog, 'utf8')).toBe('probe\n');
  });

  it('builds isolated non-interactive JSON arguments', () => {
    expect(
      buildPiArgs('Say hello.', ['--tools', 'bash'], 'openai/gpt-5.1'),
    ).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--no-approve',
      '--model',
      'openai/gpt-5.1',
      '--tools',
      'bash',
      'Say hello.',
    ]);
  });

  it('approves project resources only in dangerous permission mode', () => {
    expect(buildPiArgs('Say hello.', [], undefined, 'dangerous')).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--approve',
      'Say hello.',
    ]);
  });

  it('disables Pi startup network operations and emits streamed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-pi');
    const configLog = join(scratchRoot, 'config.log');
    const stdinLog = join(scratchRoot, 'stdin.log');
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$PI_OFFLINE" > '${configLog}'
if IFS= read -r _; then
  printf 'input' > '${stdinLog}'
else
  printf 'eof' > '${stdinLog}'
fi
cat <<'JSONL'
{"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"pnpm test"}}
{"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":{"content":[{"type":"text","text":"tests passed"}],"details":{}},"isError":false}
JSONL
`,
      {mode: 0o755},
    );
    const toolEvents: ToolEvent[] = [];
    const output = await new PiHarness({executable}).run({
      prompt: 'Run tests.',
      workDir: scratchRoot,
      env: {},
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(output.exitCode).toBe(0);
    expect(readFileSync(configLog, 'utf8')).toBe('1');
    expect(readFileSync(stdinLog, 'utf8')).toBe('eof');
    expect(toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'bash',
        input: {command: 'pnpm test'},
        command: 'pnpm test',
        status: 'success',
        message: 'tests passed',
      },
    ]);
  });

  it('extracts transcript, final message, tool events, and assistant errors', () => {
    const stdout = jsonl(
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'write',
        args: {path: 'report.txt', content: 'done'},
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'write',
        result: {
          content: [{type: 'text', text: 'written'}],
          details: {},
        },
        isError: false,
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {type: 'thinking', thinking: 'done'},
            {type: 'text', text: 'Done.'},
          ],
          stopReason: 'error',
          errorMessage: 'Provider interrupted.',
        },
      },
    );
    const raw: HarnessRunOutput = {
      exitCode: 1,
      stdout,
      stderr: '',
      durationMs: 250,
    };

    const result = new PiHarness().extractResult(raw);

    expect(result).toMatchObject({
      exitCode: 1,
      durationMs: 250,
      transcript: stdout,
      finalMessage: 'Done.',
      errorMessage: 'Provider interrupted.',
    });
    expect(result.toolEvents).toEqual([
      {
        kind: 'write_file',
        rawName: 'write',
        input: {path: 'report.txt', content: 'done'},
        status: 'success',
        message: 'written',
      },
    ]);
  });

  it('extracts assistant errors when the stream is aborted', () => {
    const stdout = jsonl({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{type: 'text', text: 'Stopped.'}],
        stopReason: 'aborted',
        errorMessage: 'User aborted.',
      },
    });

    const result = new PiHarness().extractResult({
      exitCode: 1,
      stdout,
      stderr: '',
      durationMs: 50,
    });

    expect(result.errorMessage).toBe('User aborted.');
  });
});

describe('parsePiJson', () => {
  it('maps failed tool executions and supports incremental parsing', () => {
    const toolInputs = new Map<string, unknown>();
    expect(
      parsePiJsonLine(
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: {command: 'false'},
        }),
        1,
        toolInputs,
      ).toolEvents,
    ).toEqual([]);

    expect(
      parsePiJsonLine(
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          result: {
            content: [{type: 'text', text: 'permission denied'}],
            details: {},
          },
          isError: true,
        }),
        2,
        toolInputs,
      ).toolEvents,
    ).toEqual([
      {
        kind: 'shell',
        rawName: 'bash',
        input: {command: 'false'},
        command: 'false',
        status: 'failure',
        message: 'permission denied',
      },
    ]);
  });

  it('rejects malformed JSON with its line number', () => {
    expect(() => parsePiJson('{not json}\n')).toThrow(
      'Failed to parse Pi JSON event 1',
    );
  });
});
