import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  buildCursorArgs,
  CursorHarness,
  parseCursorJson,
  parseCursorJsonLine,
} from './cursor.js';
import type {HarnessRunOutput, ToolEvent} from './types.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-cursor-test-'));
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

describe('CursorHarness', () => {
  it('has the cursor harness id', () => {
    expect(new CursorHarness().id).toBe('cursor');
  });

  it('defaults to the cursor-agent executable', () => {
    expect(new CursorHarness().executable).toBe('cursor-agent');
  });

  it('captures a custom executable version once', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-cursor');
    const probeLog = join(scratchRoot, 'version-probes.log');
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2026.05.24-dda726e'
  printf 'probe\\n' >> '${probeLog}'
  exit 0
fi
`,
      {mode: 0o755},
    );
    const harness = new CursorHarness({executable});

    await expect(
      Promise.all([harness.version(), harness.version()]),
    ).resolves.toEqual(['2026.05.24-dda726e', '2026.05.24-dda726e']);
    expect(readFileSync(probeLog, 'utf8')).toBe('probe\n');
  });

  it('builds isolated non-interactive stream-json arguments', () => {
    expect(
      buildCursorArgs(
        '/tmp/work',
        'Say hello.',
        ['--approve-mcps'],
        'composer-2',
      ),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--workspace',
      '/tmp/work',
      '--force',
      '--model',
      'composer-2',
      '--approve-mcps',
      'Say hello.',
    ]);
  });

  it('disables sandbox only in dangerous mode', () => {
    expect(
      buildCursorArgs('/tmp/work', 'Say hello.', [], undefined, 'dangerous'),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--workspace',
      '/tmp/work',
      '--force',
      '--sandbox',
      'disabled',
      'Say hello.',
    ]);
  });

  it('ignores stdin and emits streamed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-cursor');
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
{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"pnpm test"}}}}
{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"pnpm test"},"result":{"success":{"exitCode":0}}}}}
JSONL
`,
      {mode: 0o755},
    );
    const toolEvents: ToolEvent[] = [];
    const output = await new CursorHarness({executable}).run({
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
        rawName: 'shell',
        input: {command: 'pnpm test'},
        command: 'pnpm test',
        status: 'success',
      },
    ]);
  });

  it('extracts transcript, final message, and completed tool events', () => {
    const stdout = jsonl(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{type: 'text', text: 'I will write the report.'}],
        },
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        tool_call: {
          writeToolCall: {args: {path: 'report.txt', fileText: 'done'}},
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-1',
        tool_call: {
          writeToolCall: {
            args: {path: 'report.txt', fileText: 'done'},
            result: {success: {linesCreated: 1, fileSize: 4}},
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Wrote report.txt',
      },
    );
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 250,
    };

    const result = new CursorHarness().extractResult(raw);

    expect(result).toMatchObject({
      exitCode: 0,
      durationMs: 250,
      transcript: stdout,
      finalMessage: 'Wrote report.txt',
    });
    expect(result.toolEvents).toEqual([
      {
        kind: 'write_file',
        rawName: 'write',
        input: {path: 'report.txt', fileText: 'done'},
        status: 'success',
      },
    ]);
  });

  it('fails an error result even when Cursor exits 0', () => {
    const stdout = jsonl({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Not authenticated',
    });

    const result = new CursorHarness().extractResult({
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 50,
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalMessage).toBe('Not authenticated');
    expect(result.errorMessage).toBe('Not authenticated');
  });
});

describe('parseCursorJson', () => {
  it('maps failed tools, function calls, and supports incremental parsing', () => {
    const toolInputs = new Map<string, unknown>();
    expect(
      parseCursorJsonLine(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'call-1',
          tool_call: {
            shellToolCall: {args: {command: 'false'}},
          },
        }),
        1,
        toolInputs,
      ).toolEvents,
    ).toEqual([]);

    expect(
      parseCursorJsonLine(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'call-1',
          tool_call: {
            shellToolCall: {
              result: {success: {exitCode: 1}},
            },
          },
        }),
        2,
        toolInputs,
      ).toolEvents,
    ).toEqual([
      {
        kind: 'shell',
        rawName: 'shell',
        input: {command: 'false'},
        command: 'false',
        status: 'failure',
      },
    ]);

    expect(
      parseCursorJson(
        jsonl({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'mcp-1',
          tool_call: {
            function: {
              name: 'mcp_slack_post',
              arguments: '{"channel":"#eng"}',
              result: {success: {ok: true}},
            },
          },
        }),
      ).toolEvents,
    ).toEqual([
      {
        kind: 'mcp',
        rawName: 'mcp_slack_post',
        input: {channel: '#eng'},
        status: 'success',
      },
    ]);
  });

  it('records rejected tool results as failures', () => {
    expect(
      parseCursorJson(
        jsonl({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'call-2',
          tool_call: {
            deleteToolCall: {
              args: {path: 'secret.txt'},
              result: {rejected: {reason: 'permission denied'}},
            },
          },
        }),
      ).toolEvents,
    ).toEqual([
      {
        kind: 'unknown',
        rawName: 'delete',
        input: {path: 'secret.txt'},
        status: 'failure',
        message: 'permission denied',
      },
    ]);
  });

  it('maps typed MCP tool calls to the MCP kind', () => {
    expect(
      parseCursorJson(
        jsonl({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'mcp-typed-1',
          tool_call: {
            mcpToolCall: {
              args: {server: 'linear', tool: 'get_issue'},
              result: {success: {content: 'DYNO-57'}},
            },
          },
        }),
      ).toolEvents,
    ).toEqual([
      {
        kind: 'mcp',
        rawName: 'mcp',
        input: {server: 'linear', tool: 'get_issue'},
        status: 'success',
      },
    ]);
  });

  it('maps read, edit, and search tools to canonical kinds', () => {
    expect(
      parseCursorJson(
        jsonl(
          {
            type: 'tool_call',
            subtype: 'completed',
            call_id: 'read-1',
            tool_call: {
              readToolCall: {
                args: {path: 'README.md'},
                result: {success: {totalLines: 10}},
              },
            },
          },
          {
            type: 'tool_call',
            subtype: 'completed',
            call_id: 'edit-1',
            tool_call: {
              editToolCall: {
                args: {path: 'src/index.ts'},
                result: {success: {}},
              },
            },
          },
          {
            type: 'tool_call',
            subtype: 'completed',
            call_id: 'grep-1',
            tool_call: {
              grepToolCall: {
                args: {pattern: 'dynobox', path: '.'},
                result: {success: {}},
              },
            },
          },
        ),
      ).toolEvents.map((event) => [event.kind, event.rawName]),
    ).toEqual([
      ['read_file', 'read'],
      ['edit_file', 'edit'],
      ['search_files', 'grep'],
    ]);
  });

  it('rejects malformed JSON with its line number', () => {
    expect(() => parseCursorJson('{not json}\n')).toThrow(
      'Failed to parse Cursor JSON line 1',
    );
  });
});
