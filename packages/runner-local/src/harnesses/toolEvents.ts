import type {ToolKind} from './types.js';

export function normalizeToolKind(rawName: string): ToolKind {
  if (rawName.startsWith('mcp__')) {
    return 'mcp';
  }

  switch (rawName) {
    case 'Bash':
    case 'bash':
    case 'shell':
    case 'command_execution':
    case 'local_shell_call':
      return 'shell';
    case 'Read':
    case 'read':
    case 'read_file':
      return 'read_file';
    case 'Write':
    case 'write':
    case 'write_file':
      return 'write_file';
    case 'Edit':
    case 'MultiEdit':
    case 'edit':
    case 'multi_edit':
    case 'apply_patch':
      return 'edit_file';
    case 'Glob':
    case 'Grep':
    case 'glob':
    case 'grep':
    case 'search_files':
      return 'search_files';
    case 'WebFetch':
    case 'web_fetch':
      return 'web_fetch';
    case 'WebSearch':
    case 'web_search':
      return 'web_search';
    case 'Task':
    case 'task':
      return 'task';
    default:
      return 'unknown';
  }
}
