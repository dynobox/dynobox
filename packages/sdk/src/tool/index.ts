import {
  brandToolCalled,
  brandToolNotCalled,
  type ShellToolMatcher,
  type ToolCalledAssertion,
  type ToolKind,
  type ToolNotCalledAssertion,
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

function notCalled(
  kind: 'shell',
  matcher?: ShellToolMatcher,
): ToolNotCalledAssertion<'shell'>;
function notCalled<K extends NonShellToolKind>(
  kind: K,
): ToolNotCalledAssertion<K>;
function notCalled(
  kind: ToolKind,
  matcher?: ShellToolMatcher,
): ToolNotCalledAssertion {
  return brandToolNotCalled(kind, matcher);
}

export const tool = {
  called,
  notCalled,
};
