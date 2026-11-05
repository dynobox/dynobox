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

  it('pins the MCP executable before the CLI mock PATH changes', async () => {
    const root = createScratchRoot();
    const executable = join(root, 'pi');
    const marker = join(root, 'pinned');
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf pinned > '${marker}'\nprintf 'unsupported-version'\n`,
      {mode: 0o755},
    );
    const harness = new PiHarness();
    const prepared = await harness.prepareMcp({
      workDir: root,
      env: {PATH: root},
    });
    await expect(
      prepared.run(
        {workDir: root, env: {PATH: '/nonexistent'}, prompt: 'Hello'},
        {
          linear: {url: 'http://127.0.0.1:1234/mock', tools: ['get_issue']},
        },
      ),
    ).rejects.toMatchObject({category: 'unsupported_version'});
    expect(readFileSync(marker, 'utf8')).toBe('pinned');
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
    expect(buildPiArgs(['--tools', 'bash'], 'openai/gpt-5.1')).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--no-approve',
      '--model',
      'openai/gpt-5.1',
      '--tools',
      'bash',
    ]);
  });

  it('approves project resources only in dangerous permission mode', () => {
    expect(buildPiArgs([], undefined, 'dangerous')).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--approve',
    ]);
  });

  it.each(['- list the open issues', '@literal prompt'])(
    'sends %s through stdin and emits streamed tool events',
    async (prompt) => {
      const scratchRoot = createScratchRoot();
      const executable = join(scratchRoot, 'fake-pi');
      const configLog = join(scratchRoot, 'config.log');
      const stdinLog = join(scratchRoot, 'stdin.log');
      writeFileSync(
        executable,
        `#!/bin/sh
printf '%s' "$PI_OFFLINE" > '${configLog}'
cat > '${stdinLog}'
cat <<'JSONL'
{"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"pnpm test"}}
{"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":{"content":[{"type":"text","text":"tests passed"}],"details":{}},"isError":false}
JSONL
`,
        {mode: 0o755},
      );
      const toolEvents: ToolEvent[] = [];
      const output = await new PiHarness({executable}).run({
        prompt,
        workDir: scratchRoot,
        env: {},
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(output.exitCode).toBe(0);
      expect(readFileSync(configLog, 'utf8')).toBe('1');
      expect(readFileSync(stdinLog, 'utf8')).toBe(prompt);
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
    },
  );

  it.each(['0.47.0', '0.65.0', '0.65.1'])(
    'selects compatible prompt transport for Pi %s',
    async (version) => {
      const root = createScratchRoot();
      const executable = join(root, 'fake-pi');
      const log = join(root, 'prompt');
      writeFileSync(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${version}'; exit 0; fi
if [ '${version}' = '0.65.1' ]; then cat > '${log}'; else
  for arg in "$@"; do printf '%s' "$arg" > '${log}'; done
fi
printf '%s' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}'
`,
        {mode: 0o755},
      );
      const output = await new PiHarness({executable}).run({
        workDir: root,
        env: {},
        prompt: 'Run the tests.',
      });
      expect(readFileSync(log, 'utf8')).toBe('Run the tests.');
      expect(new PiHarness().extractResult(output).finalMessage).toBe('OK');
    },
  );

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
      exitCode: 0,
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

  it('fails an aborted stream even when Pi omits the error message', () => {
    const stdout = jsonl({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{type: 'text', text: 'Stopped.'}],
        stopReason: 'aborted',
      },
    });

    const result = new PiHarness().extractResult({
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 50,
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe('Pi stream aborted');
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

  it('uses the last assistant outcome after a provider retry', () => {
    const error = {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Temporary 503',
      },
    };
    const success = {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{type: 'text', text: 'Recovered'}],
      },
    };
    expect(parsePiJson(jsonl(error, success))).toMatchObject({
      terminalFailure: false,
      errorMessage: undefined,
      finalMessage: 'Recovered',
    });
    expect(
      parsePiJson(
        jsonl(success, {
          type: 'message_end',
          message: {role: 'assistant', stopReason: 'stop', content: []},
        }),
      ),
    ).toMatchObject({finalMessage: undefined, terminalFailure: false});
    expect(parsePiJson(jsonl(success, error))).toMatchObject({
      terminalFailure: true,
      errorMessage: 'Temporary 503',
    });
  });

  it('rejects malformed JSON with its line number', () => {
    expect(() => parsePiJson('{not json}\n')).toThrow(
      'Failed to parse Pi JSON event 1',
    );
  });
});
