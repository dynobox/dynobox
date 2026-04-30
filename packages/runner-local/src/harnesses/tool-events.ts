import type {ToolKind} from './types.js';

export function normalizeToolKind(rawName: string): ToolKind {
  if (rawName.startsWith('mcp__')) {
    return 'mcp';
  }

  switch (rawName) {
    case 'Bash':
      return 'shell';
    case 'Read':
      return 'read_file';
    case 'Write':
      return 'write_file';
    case 'Edit':
    case 'MultiEdit':
      return 'edit_file';
    case 'Glob':
    case 'Grep':
      return 'search_files';
    case 'WebFetch':
      return 'web_fetch';
    case 'WebSearch':
      return 'web_search';
    case 'Task':
      return 'task';
    default:
      return 'unknown';
  }
}
