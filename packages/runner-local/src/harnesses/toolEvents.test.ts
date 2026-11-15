import {describe, expect, it} from 'vitest';

import {normalizeToolKind} from './toolEvents.js';

describe('normalizeToolKind', () => {
  it.each([
    ['Skill', 'skill'],
    ['skill', 'skill'],
    ['edit_file', 'edit_file'],
    ['call_mcp_tool', 'mcp'],
    ['UnexpectedTool', 'unknown'],
  ])('maps %s to %s', (rawName, kind) => {
    expect(normalizeToolKind(rawName)).toBe(kind);
  });
});
