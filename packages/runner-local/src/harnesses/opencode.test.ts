import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  buildOpenCodeArgs,
  OpenCodeHarness,
  parseOpenCodeJson,
  parseOpenCodeJsonLine,
} from './opencode.js';
import type {HarnessRunOutput, ToolEvent} from './types.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-opencode-test-'));
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

function toolUse(
  tool: string,
  input: unknown,
  state: Record<string, unknown> = {status: 'completed'},
): unknown {
  return {
    type: 'tool_use',
    part: {
      id: `part-${tool}`,
      type: 'tool',
      tool,
      state: {input, ...state},
    },
  };
}

describe('OpenCodeHarness', () => {
  it('has the opencode harness id', () => {
    expect(new OpenCodeHarness().id).toBe('opencode');
  });

  it('captures a custom executable version once', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-opencode');
    const probeLog = join(scratchRoot, 'version-probes.log');
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '1.18.3'
  printf 'probe\\n' >> '${probeLog}'
  exit 0
fi
`,
      {mode: 0o755},
    );
    const harness = new OpenCodeHarness({executable});

    await expect(
      Promise.all([harness.version(), harness.version()]),
    ).resolves.toEqual(['1.18.3', '1.18.3']);
    expect(readFileSync(probeLog, 'utf8')).toBe('probe\n');
  });

  it('builds non-interactive JSONL arguments', () => {
    expect(buildOpenCodeArgs('/tmp/work', [], 'openai/gpt-5.6')).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp/work',
      '--model',
      'openai/gpt-5.6',
    ]);
  });

  it('adds --auto only in dangerous permission mode', () => {
    expect(buildOpenCodeArgs('/tmp/work', [], undefined, 'dangerous')).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp/work',
      '--auto',
    ]);
    expect(
      buildOpenCodeArgs('/tmp/work', [], undefined, 'default'),
    ).not.toContain('--auto');
  });

  it('extractResult returns transcript, final message, and tool events', () => {
    const harness = new OpenCodeHarness();
    const stdout = jsonl(
      toolUse(
        'bash',
        {command: 'pnpm test'},
        {
          status: 'completed',
          metadata: {exit: 0},
        },
      ),
      {type: 'text', part: {type: 'text', text: 'Tests passed.'}},
    );
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 250,
    };

    expect(harness.extractResult(raw)).toEqual({
      exitCode: 0,
      durationMs: 250,
      transcript: stdout,
      finalMessage: 'Tests passed.',
      toolEvents: [
        {
          kind: 'shell',
          rawName: 'bash',
          input: {command: 'pnpm test'},
          status: 'success',
          command: 'pnpm test',
        },
      ],
    });
  });

  it('pipes the exact prompt and deduplicates streamed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-opencode');
    const promptLog = join(scratchRoot, 'prompt.log');
    const event = JSON.stringify(
      toolUse(
        'bash',
        {command: 'pnpm test'},
        {
          status: 'completed',
          metadata: {exit: 0},
        },
      ),
    );
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "debug" ]; then
  printf '%s\\n' '{}'
  exit 0
fi
cat > '${promptLog}'
cat <<'JSONL'
${event}
${event}
JSONL
`,
      {mode: 0o755},
    );
    const harness = new OpenCodeHarness({executable});
    const toolEvents: ToolEvent[] = [];
    const prompt = '- Keep "quotes" exact.\n\nPreserve spacing.';

    await harness.run({
      prompt,
      workDir: scratchRoot,
      env: {},
      onToolEvent: (toolEvent) => toolEvents.push(toolEvent),
    });

    expect(toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'bash',
        input: {command: 'pnpm test'},
        status: 'success',
        command: 'pnpm test',
      },
    ]);
    expect(readFileSync(promptLog, 'utf8')).toBe(prompt);
  });

  it('classifies tools from configured MCP servers', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-opencode');
    const event = JSON.stringify(
      toolUse('linear-api_search', {query: 'dynobox'}),
    );
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "debug" ]; then
  printf '%s\\n' '{"mcp":{"linear-api":{"type":"remote"}}}'
  exit 0
fi
cat >/dev/null
printf '%s\\n' '${event}'
`,
      {mode: 0o755},
    );
    const harness = new OpenCodeHarness({executable});

    const raw = await harness.run({
      prompt: 'Search Linear.',
      workDir: scratchRoot,
      env: {},
    });

    expect(harness.extractResult(raw).toolEvents).toEqual([
      {
        kind: 'mcp',
        rawName: 'linear-api_search',
        input: {query: 'dynobox'},
        status: 'success',
      },
    ]);
  });
});

describe('parseOpenCodeJson', () => {
  it('combines text parts from the last assistant message', () => {
    const parsed = parseOpenCodeJson(
      jsonl(
        {
          type: 'text',
          part: {
            id: 'part-0',
            messageID: 'message-0',
            type: 'text',
            text: 'Interim.',
          },
        },
        {type: 'step_finish', part: {type: 'step-finish'}},
        {
          type: 'text',
          part: {
            id: 'part-1',
            messageID: 'message-1',
            type: 'text',
            text: 'Final ',
          },
        },
        {
          type: 'text',
          part: {
            id: 'part-2',
            messageID: 'message-1',
            type: 'text',
            text: 'result.',
          },
        },
        {
          type: 'text',
          part: {
            id: 'part-3',
            messageID: 'message-1',
            type: 'text',
            text: '',
          },
        },
      ),
    );

    expect(parsed.finalMessage).toBe('Final result.');
  });

  it('parses a single JSONL line for incremental consumers', () => {
    const parsed = parseOpenCodeJsonLine(
      JSON.stringify(toolUse('read', {filePath: 'README.md'})),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'read_file',
        rawName: 'read',
        input: {filePath: 'README.md'},
        status: 'success',
      },
    ]);
  });

  it('deduplicates completed tool parts during final extraction', () => {
    const event = toolUse(
      'bash',
      {command: 'pnpm test'},
      {
        status: 'completed',
        metadata: {exit: 0},
      },
    );

    const parsed = parseOpenCodeJson(jsonl(event, event));

    expect(parsed.toolEvents).toHaveLength(1);
  });

  it('uses shell exit metadata before the completed state', () => {
    const parsed = parseOpenCodeJson(
      jsonl(
        toolUse(
          'bash',
          {command: 'pnpm test'},
          {
            status: 'completed',
            output: 'test failed',
            metadata: {exit: 1},
          },
        ),
      ),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'bash',
        input: {command: 'pnpm test'},
        status: 'failure',
        message: 'test failed',
        command: 'pnpm test',
      },
    ]);
  });

  it('treats a completed shell command with a null exit as failure', () => {
    const parsed = parseOpenCodeJson(
      jsonl(
        toolUse(
          'bash',
          {command: 'pnpm test'},
          {
            status: 'completed',
            output: 'shell tool terminated command after exceeding timeout',
            metadata: {exit: null},
          },
        ),
      ),
    );

    expect(parsed.toolEvents[0]).toMatchObject({
      kind: 'shell',
      status: 'failure',
      message: 'shell tool terminated command after exceeding timeout',
    });
  });

  it('extracts explicit OpenCode tool errors', () => {
    const parsed = parseOpenCodeJson(
      jsonl(
        toolUse(
          'edit',
          {filePath: 'README.md'},
          {
            status: 'error',
            error: {message: 'permission denied'},
          },
        ),
      ),
    );

    expect(parsed.toolEvents[0]).toMatchObject({
      kind: 'edit_file',
      status: 'failure',
      message: 'permission denied',
    });
  });

  it('extracts structured OpenCode session errors', () => {
    const parsed = parseOpenCodeJson(
      jsonl({
        type: 'error',
        error: {
          name: 'ProviderModelNotFoundError',
          data: {message: 'Model fake/model was not found.'},
        },
      }),
    );

    expect(parsed.errorMessage).toBe('Model fake/model was not found.');
  });

  it('throws a clear error for malformed JSONL', () => {
    expect(() => parseOpenCodeJson('{"type":"text"}\nnope')).toThrow(
      /Failed to parse OpenCode JSON line 2/,
    );
  });
});
