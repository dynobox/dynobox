import {
  brandToolCalled,
  type ShellToolMatcher,
  type ToolCalledAssertion,
  type ToolKind,
} from '../types/brands.js';

type NonShellToolKind = Exclude<ToolKind, 'shell'>;

function called(
  kind: 'shell',
  matcher?: ShellToolMatcher,
): ToolCalledAssertion<'shell'>;
function called<K extends NonShellToolKind>(kind: K): ToolCalledAssertion<K>;
function called(
  kind: ToolKind,
  matcher?: ShellToolMatcher,
): ToolCalledAssertion {
  return brandToolCalled(kind, matcher);
}

export const tool = {
  called,
};
