import {describe, expect, it} from 'vitest';

import {isShellToolEvent, type ToolEvent} from './brands.js';

describe('isShellToolEvent', () => {
  it('identifies shell tool events with a command', () => {
    const event: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    };

    expect(isShellToolEvent(event)).toBe(true);
  });

  it('rejects shell tool events without a promoted command', () => {
    const event: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {},
    };

    expect(isShellToolEvent(event)).toBe(false);
  });

  it('rejects non-shell tool events', () => {
    const event: ToolEvent = {
      kind: 'read_file',
      rawName: 'Read',
      input: {file_path: 'README.md'},
    };

    expect(isShellToolEvent(event)).toBe(false);
  });
});
