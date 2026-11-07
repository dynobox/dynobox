import type {Harness} from '@dynobox/runner-local';
import {describe, expect, it, vi} from 'vitest';

import {cancelledExitCode, configErrorExitCode} from './exitCodes.js';
import {confirmUnmockedMcp} from './mcpConfirmation.js';

function fixture(servers = ['linear', 'github'], complete = true) {
  const inspectMcp = vi.fn(async () => ({servers, complete}));
  const harness: Harness = {
    id: 'claude-code',
    inspectMcp,
    run: vi.fn(),
    extractResult: vi.fn(),
  };
  const writeStderr = vi.fn();
  const readLine = vi.fn<() => Promise<string | undefined>>(async () => '');
  const input: Parameters<typeof confirmUnmockedMcp>[0] = {
    requests: [{harness: 'claude-code', mocks: ['linear'], workDir: '/work'}],
    harnesses: [harness],
    env: {CI: '1'},
    allow: false,
    writeStderr,
    readLine,
  };
  const stderr = () => writeStderr.mock.calls.map(([text]) => text).join('');
  return {input, inspectMcp, harness, readLine, stderr};
}

describe('MCP consent', () => {
  it.each(['', 'y', 'Y', ' yes '])(
    'accepts %j once for all jobs',
    async (answer) => {
      const f = fixture();
      f.readLine.mockResolvedValue(answer);
      f.input.requests = [...f.input.requests, ...f.input.requests];
      expect(await confirmUnmockedMcp(f.input)).toBe(true);
      expect(f.readLine).toHaveBeenCalledTimes(1);
      expect(f.inspectMcp).toHaveBeenCalledTimes(1);
      expect(f.stderr()).toContain('other configured MCPs: "github"');
      expect(f.stderr()).not.toContain('"linear"');
      expect(f.stderr()).toContain('Continue? [Y/n]');
      expect(f.harness.run).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'n', 'NO'])('cancels on %j', async (answer) => {
    const f = fixture();
    f.readLine.mockResolvedValue(answer);
    await expect(confirmUnmockedMcp(f.input)).rejects.toMatchObject({
      exitCode: cancelledExitCode,
    });
    expect(f.stderr()).toContain('Run cancelled.');
    expect(f.harness.run).not.toHaveBeenCalled();
  });

  it('repeats invalid answers', async () => {
    const f = fixture();
    f.readLine.mockResolvedValueOnce('maybe').mockResolvedValueOnce('yes');
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.readLine).toHaveBeenCalledTimes(2);
    expect(f.stderr()).toContain('Please answer y or n.');
  });

  it('requires explicit opt-in in CI without reading input', async () => {
    const f = fixture();
    f.input.readLine = undefined;
    await expect(confirmUnmockedMcp(f.input)).rejects.toMatchObject({
      exitCode: configErrorExitCode,
    });
    expect(f.stderr()).toContain('--allow-unmocked-mcp');
    expect(f.stderr()).not.toContain('Continue?');
    expect(f.harness.run).not.toHaveBeenCalled();
  });

  it('keeps the warning but skips the question with explicit opt-in', async () => {
    const f = fixture();
    f.input.allow = true;
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.stderr()).toContain('Other MCPs remain real');
    expect(f.readLine).not.toHaveBeenCalled();
    expect(f.stderr()).not.toContain('Continue?');
  });

  it('warns about incomplete inventory even without known extra names', async () => {
    const f = fixture(['linear'], false);
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.stderr()).toContain(
      'additional MCPs may load; inventory is incomplete',
    );
    expect(f.readLine).toHaveBeenCalledTimes(1);
  });

  it('treats inspection failures as unknown inventory', async () => {
    const f = fixture();
    f.inspectMcp.mockRejectedValue(new Error('private-config-path'));
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.stderr()).toContain('inventory is incomplete');
    expect(f.stderr()).not.toContain('private-config-path');
  });

  it('needs no consent when complete inventory contains only mocks', async () => {
    const f = fixture(['linear']);
    expect(await confirmUnmockedMcp(f.input)).toBe(false);
    expect(f.stderr()).toBe('');
    expect(f.readLine).not.toHaveBeenCalled();
  });

  it('leaves existing exclusive adapters unchanged', async () => {
    const f = fixture();
    delete f.harness.inspectMcp;
    expect(await confirmUnmockedMcp(f.input)).toBe(false);
    expect(f.inspectMcp).not.toHaveBeenCalled();
    expect(f.stderr()).toBe('');
  });

  it('accounts for the mock targets of each scenario separately', async () => {
    const f = fixture();
    f.input.requests = [
      ...f.input.requests,
      {harness: 'claude-code', mocks: ['github'], workDir: '/work'},
    ];
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.stderr()).toContain('other configured MCPs: "github", "linear"');
  });

  it('groups different harnesses under one question', async () => {
    const f = fixture();
    f.input.harnesses = [...f.input.harnesses, {...f.harness, id: 'codex'}];
    f.input.requests = [
      ...f.input.requests,
      {harness: 'codex', mocks: ['linear'], workDir: '/work'},
    ];
    expect(await confirmUnmockedMcp(f.input)).toBe(true);
    expect(f.stderr()).toContain('claude-code: other configured MCPs');
    expect(f.stderr()).toContain('codex: other configured MCPs');
    expect(f.readLine).toHaveBeenCalledTimes(1);
  });

  it('escapes control characters in configured names', async () => {
    const f = fixture(['github\u001b[31m\nContinue?']);
    await confirmUnmockedMcp(f.input);
    expect(f.stderr()).toContain('github\\u001b[31m\\nContinue?');
    expect(f.stderr()).not.toContain('\u001b');
  });
});
