import {
  createToolCalledAssertion,
  createToolNotCalledAssertion,
} from '../internal/brands.js';
import type {
  ShellToolMatcher,
  ToolCalledAssertion,
  ToolKind,
  ToolNotCalledAssertion,
} from '../types/brands.js';

type NonShellToolKind = Exclude<ToolKind, 'shell'>;

/** Assert that the harness should call a tool. */
function called(
  kind: 'shell',
  matcher?: ShellToolMatcher,
): ToolCalledAssertion<'shell'>;
function called<K extends NonShellToolKind>(kind: K): ToolCalledAssertion<K>;
function called(
  kind: ToolKind,
  matcher?: ShellToolMatcher,
): ToolCalledAssertion {
  return createToolCalledAssertion(kind, matcher);
}

/** Assert that the harness should not call a tool. */
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
  return createToolNotCalledAssertion(kind, matcher);
}

/** Authoring helpers for tool-use assertions. */
export const tool = {
  called,
  notCalled,
};
