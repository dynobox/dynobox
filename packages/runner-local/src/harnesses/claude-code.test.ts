import {describe, expect, it} from 'vitest';

import {
  buildClaudeCodeArgs,
  ClaudeCodeHarness,
  parseClaudeCodeStreamJson,
} from './claude-code.js';
import type {HarnessRunOutput} from './types.js';

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('ClaudeCodeHarness', () => {
  it('has the claude-code harness id', () => {
    expect(new ClaudeCodeHarness().id).toBe('claude-code');
  });

  it('builds non-interactive stream-json arguments', () => {
    expect(
      buildClaudeCodeArgs('Say hello.', ['--permission-mode', 'plan']),
    ).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-hook-events',
      '--permission-mode',
      'plan',
      'Say hello.',
    ]);
  });

  it('extractResult returns transcript, final message, and tool events', () => {
    const harness = new ClaudeCodeHarness();
    const stdout = jsonl(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {command: 'pnpm test'},
      },
      {
        type: 'result',
        result: 'Tests passed.',
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
        rawName: 'Bash',
        input: {command: 'pnpm test'},
        command: 'pnpm test',
      },
    ]);
  });
});

describe('parseClaudeCodeStreamJson', () => {
  it('extracts final message from a result event', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl(
        {
          type: 'assistant',
          message: {content: [{type: 'text', text: 'Interim message.'}]},
        },
        {type: 'result', result: 'Final result.'},
      ),
    );

    expect(parsed.finalMessage).toBe('Final result.');
  });

  it('falls back to the last assistant text when no result event exists', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl(
        {
          type: 'assistant',
          message: {content: [{type: 'text', text: 'First.'}]},
        },
        {
          type: 'assistant',
          message: {content: [{type: 'text', text: 'Second.'}]},
        },
      ),
    );

    expect(parsed.finalMessage).toBe('Second.');
  });

  it('preserves raw tool names and raw inputs', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {file_path: 'src/index.ts', old_string: 'a'},
      }),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'edit_file',
        rawName: 'Edit',
        input: {file_path: 'src/index.ts', old_string: 'a'},
      },
    ]);
  });

  it('normalizes representative Claude Code tool names', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: {command: 'pnpm test'},
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: {file_path: 'src/index.ts'},
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'MultiEdit',
          tool_input: {file_path: 'src/index.ts'},
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__github__search',
          tool_input: {query: 'dynobox'},
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'WebSearch',
          tool_input: {query: 'typescript'},
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'UnexpectedTool',
          tool_input: {value: true},
        },
      ),
    );

    expect(parsed.toolEvents.map((event) => event.kind)).toEqual([
      'shell',
      'edit_file',
      'edit_file',
      'mcp',
      'web_search',
      'unknown',
    ]);
    expect(parsed.toolEvents.map((event) => event.rawName)).toEqual([
      'Bash',
      'Edit',
      'MultiEdit',
      'mcp__github__search',
      'WebSearch',
      'UnexpectedTool',
    ]);
  });

  it('adds shell command text to shell events', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {command: 'pnpm test'},
      }),
    );

    expect(parsed.toolEvents[0]).toMatchObject({
      kind: 'shell',
      command: 'pnpm test',
    });
  });

  it('extracts tool events from assistant tool_use stream content', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'Bash',
              input: {command: 'pwd', description: 'Print working directory'},
            },
          ],
        },
      }),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'Bash',
        input: {command: 'pwd', description: 'Print working directory'},
        command: 'pwd',
      },
    ]);
  });

  it('sets status on post-use hook events', () => {
    const parsed = parseClaudeCodeStreamJson(
      jsonl(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: {command: 'pnpm test'},
        },
        {
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: {command: 'pnpm build'},
        },
      ),
    );

    expect(parsed.toolEvents).toEqual([
      {
        kind: 'shell',
        rawName: 'Bash',
        input: {command: 'pnpm test'},
        status: 'success',
        command: 'pnpm test',
      },
      {
        kind: 'shell',
        rawName: 'Bash',
        input: {command: 'pnpm build'},
        status: 'failure',
        command: 'pnpm build',
      },
    ]);
  });

  it('throws a clear error for malformed JSONL', () => {
    expect(() =>
      parseClaudeCodeStreamJson('{"type":"assistant"}\nnope'),
    ).toThrow(/Failed to parse Claude Code stream JSON line 2/);
  });
});
