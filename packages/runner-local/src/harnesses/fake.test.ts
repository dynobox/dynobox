import {HARNESS_IDS} from '@dynobox/sdk';
import {describe, expect, it} from 'vitest';

import {FakeHarness} from './fake.js';
import {normalizeToolKind} from './toolEvents.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './types.js';

const input: HarnessInput = {
  prompt: 'Find the latest version of prettier.',
  workDir: '/tmp/dynobox-test',
  env: {HTTPS_PROXY: 'http://localhost:8080'},
};

const shellToolEvent: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'pnpm test'},
  command: 'pnpm test',
  status: 'success',
};

const toolEvents: ToolEvent[] = [
  shellToolEvent,
  {
    kind: 'edit_file',
    rawName: 'Edit',
    input: {file_path: 'src/index.ts'},
  },
  {
    kind: 'mcp',
    rawName: 'mcp__github__search',
    input: {query: 'dynobox'},
  },
  {
    kind: 'web_search',
    rawName: 'WebSearch',
    input: {query: 'typescript'},
  },
  {
    kind: 'unknown',
    rawName: 'UnexpectedTool',
    input: {value: true},
  },
];

describe('Harness contract (FakeHarness)', () => {
  it('has a valid harness id', () => {
    const harness = new FakeHarness();
    expect(HARNESS_IDS).toContain(harness.id);
  });

  it('uses a configured harness id', () => {
    const harness = new FakeHarness(undefined, {id: 'codex'});

    expect(harness.id).toBe('codex');
    expect(HARNESS_IDS).toContain(harness.id);
  });

  it('run returns a valid HarnessRunOutput', async () => {
    const harness = new FakeHarness();
    const output = await harness.run(input);

    expect(typeof output.exitCode).toBe('number');
    expect(typeof output.stdout).toBe('string');
    expect(typeof output.stderr).toBe('string');
    expect(typeof output.durationMs).toBe('number');
  });

  it('extractResult produces transcript and finalMessage from stdout', () => {
    const harness = new FakeHarness();
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout: 'The latest version is 3.5.0.',
      stderr: '',
      durationMs: 500,
    };

    const result = harness.extractResult(raw);

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(500);
    expect(result.transcript).toBe('The latest version is 3.5.0.');
    expect(result.finalMessage).toBe('The latest version is 3.5.0.');
    expect(result.toolEvents).toEqual([]);
  });

  it('extractResult returns undefined finalMessage when stdout is empty', () => {
    const harness = new FakeHarness();
    const raw: HarnessRunOutput = {
      exitCode: 1,
      stdout: '',
      stderr: 'process timed out',
      durationMs: 30000,
    };

    const result = harness.extractResult(raw);

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toBe('');
    expect(result.finalMessage).toBeUndefined();
    expect(result.toolEvents).toEqual([]);
  });

  it('returns the configured canned response from run', async () => {
    const harness = new FakeHarness({exitCode: 1, stdout: 'custom output'});
    const output = await harness.run(input);

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe('custom output');
  });

  it('extractResult returns configured tool events', () => {
    const harness = new FakeHarness(undefined, {toolEvents});
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout: 'used tools',
      stderr: '',
      durationMs: 250,
    };

    const result = harness.extractResult(raw);

    expect(result.toolEvents).toEqual(toolEvents);
  });

  it('preserves raw names and inputs on tool events', () => {
    const harness = new FakeHarness(undefined, {toolEvents});
    const result = harness.extractResult({
      exitCode: 0,
      stdout: 'used tools',
      stderr: '',
      durationMs: 250,
    });

    expect(result.toolEvents.map((event) => event.rawName)).toEqual([
      'Bash',
      'Edit',
      'mcp__github__search',
      'WebSearch',
      'UnexpectedTool',
    ]);
    expect(result.toolEvents[0]?.input).toEqual({command: 'pnpm test'});
    expect(result.toolEvents[2]?.input).toEqual({query: 'dynobox'});
  });

  it('returns stable canonical tool kinds', () => {
    const harness = new FakeHarness(undefined, {toolEvents});
    const result = harness.extractResult({
      exitCode: 0,
      stdout: 'used tools',
      stderr: '',
      durationMs: 250,
    });

    expect(result.toolEvents.map((event) => event.kind)).toEqual([
      'shell',
      'edit_file',
      'mcp',
      'web_search',
      'unknown',
    ]);
    expect(result.toolEvents[0]).toMatchObject({
      kind: 'shell',
      command: 'pnpm test',
    });
  });
});

describe('normalizeToolKind', () => {
  it('normalizes representative Claude Code raw tool names', () => {
    expect(normalizeToolKind('Bash')).toBe('shell');
    expect(normalizeToolKind('Read')).toBe('read_file');
    expect(normalizeToolKind('Write')).toBe('write_file');
    expect(normalizeToolKind('Edit')).toBe('edit_file');
    expect(normalizeToolKind('MultiEdit')).toBe('edit_file');
    expect(normalizeToolKind('Glob')).toBe('search_files');
    expect(normalizeToolKind('Grep')).toBe('search_files');
    expect(normalizeToolKind('WebFetch')).toBe('web_fetch');
    expect(normalizeToolKind('WebSearch')).toBe('web_search');
    expect(normalizeToolKind('Task')).toBe('task');
    expect(normalizeToolKind('mcp__github__search')).toBe('mcp');
    expect(normalizeToolKind('UnexpectedTool')).toBe('unknown');
  });

  it('normalizes representative OpenCode raw tool names', () => {
    expect(normalizeToolKind('bash')).toBe('shell');
    expect(normalizeToolKind('read')).toBe('read_file');
    expect(normalizeToolKind('write')).toBe('write_file');
    expect(normalizeToolKind('edit')).toBe('edit_file');
    expect(normalizeToolKind('apply_patch')).toBe('edit_file');
    expect(normalizeToolKind('glob')).toBe('search_files');
    expect(normalizeToolKind('grep')).toBe('search_files');
    expect(normalizeToolKind('list')).toBe('search_files');
    expect(normalizeToolKind('find')).toBe('search_files');
    expect(normalizeToolKind('ls')).toBe('search_files');
    expect(normalizeToolKind('search')).toBe('search_files');
    expect(normalizeToolKind('webfetch')).toBe('web_fetch');
    expect(normalizeToolKind('webFetch')).toBe('web_fetch');
    expect(normalizeToolKind('websearch')).toBe('web_search');
    expect(normalizeToolKind('webSearch')).toBe('web_search');
    expect(normalizeToolKind('task')).toBe('task');
    expect(normalizeToolKind('list_mcp_resources')).toBe('mcp');
    expect(normalizeToolKind('list_mcp_resource_templates')).toBe('mcp');
    expect(normalizeToolKind('read_mcp_resource')).toBe('mcp');
  });

  it('normalizes representative Antigravity raw tool names', () => {
    expect(normalizeToolKind('run_command')).toBe('shell');
    expect(normalizeToolKind('view_file')).toBe('read_file');
    expect(normalizeToolKind('write_to_file')).toBe('write_file');
    expect(normalizeToolKind('replace_file_content')).toBe('edit_file');
    expect(normalizeToolKind('multi_replace_file_content')).toBe('edit_file');
    expect(normalizeToolKind('list_dir')).toBe('search_files');
    expect(normalizeToolKind('find_by_name')).toBe('search_files');
    expect(normalizeToolKind('grep_search')).toBe('search_files');
    expect(normalizeToolKind('code_search')).toBe('search_files');
    expect(normalizeToolKind('search_web')).toBe('web_search');
    expect(normalizeToolKind('read_url_content')).toBe('web_fetch');
    expect(normalizeToolKind('invoke_subagent')).toBe('task');
    expect(normalizeToolKind('manage_task')).toBe('task');
    expect(normalizeToolKind('manage_subagents')).toBe('task');
    expect(normalizeToolKind('mcp_github_search')).toBe('mcp');
  });
});
