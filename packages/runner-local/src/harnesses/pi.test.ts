import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
if [ "$1" = "--version" ]; then printf '0.86.0'; exit 0; fi
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

  it.each([
    ['refuses', "printf '0.85.1'", false],
    ['allows an unknown version and', 'exit 1', true],
  ])('%s runs Pi below the minimum', async (_label, versionProbe, runs) => {
    const root = createScratchRoot();
    const executable = join(root, 'fake-pi');
    const ran = join(root, 'ran');
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then ${versionProbe}; exit 0; fi
touch '${ran}'
`,
      {mode: 0o755},
    );
    const run = new PiHarness({executable}).run({
      workDir: root,
      env: {},
      prompt: 'Run the tests.',
    });
    if (runs) await run;
    else
      await expect(run).rejects.toThrow(
        'Pi 0.86.0 or newer is required (found 0.85.1).',
      );
    expect(existsSync(ran)).toBe(runs);
  });

  it('rejects a blank prompt before starting Pi', async () => {
    const root = createScratchRoot();
    const ran = join(root, 'ran');
    const executable = join(root, 'fake-pi');
    writeFileSync(executable, `#!/bin/sh\ntouch '${ran}'\n`, {mode: 0o755});
    await expect(
      new PiHarness({executable}).run({workDir: root, env: {}, prompt: '  \n'}),
    ).rejects.toThrow('Pi cannot run a blank prompt.');
    expect(existsSync(ran)).toBe(false);
  });

  it('keeps earlier answer text when the last turn has none', () => {
    const turn = (stopReason: string, content: unknown[]) => ({
      type: 'message_end',
      message: {role: 'assistant', stopReason, content},
    });
    const parsed = parsePiJson(
      jsonl(
        turn('toolUse', [{type: 'text', text: 'DYNO-1 is titled Foo.'}]),
        turn('stop', []),
      ),
    );
    expect(parsed.finalMessage).toBe('DYNO-1 is titled Foo.');
    expect(parsed.terminalFailure).toBe(false);
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
    ).toMatchObject({finalMessage: 'Recovered', terminalFailure: false});
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

describe('Pi native MCP identities', () => {
  const native = 'mcp__dxb_private__get_issue_a1b2c3';
  const tools = {[native]: 'mcp__linear__get-issue'};
  const start = {
    type: 'tool_execution_start',
    toolCallId: 'call',
    toolName: native,
    args: {id: 'dxb_private'},
  };
  const end = (isError: boolean, details?: unknown) => ({
    type: 'tool_execution_end',
    toolCallId: 'call',
    toolName: native,
    isError,
    result: {
      content: [{type: 'text', text: 'dxb_private service response'}],
      ...(details ? {details} : {}),
    },
  });

  it('normalizes hashed native identities in parser and harness extraction', () => {
    const stdout = jsonl(
      start,
      end(false, {server: 'dxb_private', tool: 'get-issue'}),
    );
    const parsed = parsePiJson(stdout, tools);
    expect(parsed.toolEvents).toMatchObject([
      {
        rawName: 'mcp__linear__get-issue',
        kind: 'mcp',
        input: {id: 'dxb_private'},
        status: 'success',
        message: 'dxb_private service response',
      },
    ]);
    expect(
      new PiHarness().extractResult({
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: 1,
        metadata: {piMcpTools: tools},
      }).toolEvents,
    ).toEqual(parsed.toolEvents);
  });

  it('preserves received MCP error payloads and arguments', () => {
    expect(
      parsePiJson(
        jsonl(start, end(true, {server: 'dxb_private', tool: 'get-issue'})),
        tools,
      ).toolEvents,
    ).toMatchObject([
      {
        rawName: 'mcp__linear__get-issue',
        status: 'failure',
        input: {id: 'dxb_private'},
        message: 'dxb_private service response',
      },
    ]);
  });

  it('keeps failed attempt identities logical and preserves diagnostic text', () => {
    expect(
      parsePiJson(jsonl(start, end(true)), tools).toolEvents,
    ).toMatchObject([
      {
        rawName: 'mcp__linear__get-issue',
        status: 'failure',
        message: 'dxb_private service response',
      },
    ]);
  });

  it('ignores malformed invocation metadata', () => {
    const result = new PiHarness().extractResult({
      exitCode: 0,
      stdout: jsonl(start, end(false)),
      stderr: '',
      durationMs: 1,
      metadata: {piMcpTools: {[native]: 42}},
    });
    expect(result.toolEvents[0]?.rawName).toBe(native);
  });

  it('keeps unmapped and prototype-like native tool names unchanged', () => {
    const event = {...end(false), toolName: 'constructor'};
    expect(parsePiJson(jsonl(event), tools).toolEvents[0]?.rawName).toBe(
      'constructor',
    );
  });
});
