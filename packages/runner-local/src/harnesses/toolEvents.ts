import type {ToolKind} from './types.js';

export function normalizeToolKind(rawName: string): ToolKind {
  if (
    rawName.startsWith('mcp__') ||
    rawName.startsWith('mcp_') ||
    rawName.startsWith('mcp-') ||
    rawName === 'mcp' ||
    rawName === 'list_mcp_resources' ||
    rawName === 'list_mcp_resource_templates' ||
    rawName === 'read_mcp_resource'
  ) {
    return 'mcp';
  }

  switch (rawName) {
    case 'Bash':
    case 'bash':
    case 'shell':
    case 'command_execution':
    case 'local_shell_call':
    case 'run_command':
      return 'shell';
    case 'Read':
    case 'read':
    case 'read_file':
    case 'view_file':
      return 'read_file';
    case 'Write':
    case 'write':
    case 'write_file':
    case 'write_to_file':
      return 'write_file';
    case 'Edit':
    case 'MultiEdit':
    case 'edit':
    case 'multi_edit':
    case 'apply_patch':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return 'edit_file';
    case 'Glob':
    case 'Grep':
    case 'glob':
    case 'grep':
    case 'list':
    case 'find':
    case 'ls':
    case 'search':
    case 'search_files':
    case 'list_dir':
    case 'find_by_name':
    case 'grep_search':
    case 'code_search':
      return 'search_files';
    case 'WebFetch':
    case 'webfetch':
    case 'webFetch':
    case 'web_fetch':
    case 'read_url_content':
      return 'web_fetch';
    case 'WebSearch':
    case 'websearch':
    case 'webSearch':
    case 'web_search':
    case 'search_web':
      return 'web_search';
    case 'Task':
    case 'task':
    case 'invoke_subagent':
    case 'background_task':
    case 'manage_task':
    case 'schedule':
    case 'define_subagent':
    case 'send_message':
    case 'manage_subagents':
      return 'task';
    default:
      return 'unknown';
  }
}
