import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  buildCodexArgs,
  CodexHarness,
  parseCodexJson,
  parseCodexJsonLine,
} from './codex.js';
import type {HarnessRunOutput, ToolEvent} from './types.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-codex-test-'));
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

describe('CodexHarness', () => {
  it('has the codex harness id', () => {
    expect(new CodexHarness().id).toBe('codex');
  });

  it('builds non-interactive JSONL arguments', () => {
    expect(buildCodexArgs('Say hello.', ['--model', 'gpt-5.1-codex'])).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--full-auto',
      '--model',
      'gpt-5.1-codex',
      'Say hello.',
    ]);
  });

  it('extractResult returns transcript, final message, and tool events', () => {
    const harness = new CodexHarness();
    const stdout = jsonl(
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'pnpm test',
          exit_code: 0,
        },
      },
      {
        type: 'item.completed',
        item: {type: 'agent_message', text: 'Tests passed.'},
      },
    );
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 250,
    };

    const result = harness.extractResult(raw);

    expect(result).toMatchObject({
      exitCode: 0,
      durationMs: 250,
      transcript: stdout,
      finalMessage: 'Tests passed.',
    });
    expect(result.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'command_execution',
        input: {command: 'pnpm test'},
        status: 'success',
        command: 'pnpm test',
      },
    ]);
  });

  it('emits tool events while run streams stdout', async () => {
    const scratchRoot = createScratchRoot();
    const executable = join(scratchRoot, 'fake-codex');
    writeFileSync(
      executable,
      `#!/bin/sh
cat <<'JSONL'
{"type":"item.started","item":{"type":"command_execution","command":"pnpm test"}}
{"type":"item.completed","item":{"type":"agent_message","text":"Tests passed."}}
JSONL
`,
      {mode: 0o755},
    );
    const harness = new CodexHarness({executable});
    const toolEvents: ToolEvent[] = [];

    const result = await harness.run({
      prompt: 'Run tests.',
      workDir: scratchRoot,
      env: {},
      onToolEvent: (toolEvent) => toolEvents.push(toolEvent),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Tests passed.');
    expect(toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'command_execution',
        input: {command: 'pnpm test'},
        command: 'pnpm test',
      },
    ]);
  });
});

describe('parseCodexJson', () => {
  it('extracts the last agent message as the final message', () => {
    const parsed = parseCodexJson(
      jsonl(
        {
          type: 'item.completed',
          item: {type: 'agent_message', text: 'Interim message.'},
        },
        {type: 'agent_message', message: 'Final result.'},
      ),
    );

    expect(parsed.finalMessage).toBe('Final result.');
  });

  it('parses a single JSONL line for incremental consumers', () => {
    const parsed = parseCodexJsonLine(
      JSON.stringify({
        type: 'item.started',
        item: {type: 'command_execution', command: 'cat package.json'},
      }),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'command_execution',
        input: {command: 'cat package.json'},
        command: 'cat package.json',
      },
    ]);
  });

  it('normalizes representative Codex tool names', () => {
    const parsed = parseCodexJson(
      jsonl(
        {
          type: 'item.completed',
          item: {type: 'command_execution', command: 'pnpm test'},
        },
        {
          type: 'item.completed',
          item: {type: 'apply_patch', input: {patch: '*** Begin Patch'}},
        },
        {
          type: 'item.completed',
          item: {type: 'web_search', input: {query: 'typescript'}},
        },
        {
          type: 'item.completed',
          item: {type: 'mcp__github__search', input: {query: 'dynobox'}},
        },
      ),
    );

    expect(parsed.toolEvents.map((event) => event.kind)).toEqual([
      'shell',
      'edit_file',
      'web_search',
      'mcp',
    ]);
    expect(parsed.toolEvents.map((event) => event.rawName)).toEqual([
      'command_execution',
      'apply_patch',
      'web_search',
      'mcp__github__search',
    ]);
  });

  it('parses function call arguments for shell commands', () => {
    const parsed = parseCodexJson(
      jsonl({
        type: 'item.completed',
        item: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({cmd: 'git status'}),
        },
      }),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'shell',
        input: {command: 'git status'},
        command: 'git status',
      },
    ]);
  });

  it('sets status from completed command exit codes', () => {
    const parsed = parseCodexJson(
      jsonl(
        {
          type: 'item.completed',
          item: {type: 'command_execution', command: 'pnpm test', exit_code: 0},
        },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'pnpm build',
            exit_code: 1,
          },
        },
      ),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'command_execution',
        input: {command: 'pnpm test'},
        status: 'success',
        command: 'pnpm test',
      },
      {
        kind: 'shell',
        rawName: 'command_execution',
        input: {command: 'pnpm build'},
        status: 'failure',
        command: 'pnpm build',
      },
    ]);
  });

  it('throws a clear error for malformed JSONL', () => {
    expect(() => parseCodexJson('{"type":"agent_message"}\nnope')).toThrow(
      /Failed to parse Codex JSON line 2/,
    );
  });
});
