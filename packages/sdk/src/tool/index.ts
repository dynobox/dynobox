import {
  createToolCalledAssertion,
  createToolNotCalledAssertion,
} from '../internal/brands.js';
import type {
  FileToolKind,
  ShellCommandMatcher,
  ToolCalledAssertion,
  ToolKind,
  ToolNotCalledAssertion,
  ToolPathMatcher,
} from '../types/brands.js';

type PlainToolKind = Exclude<ToolKind, 'shell' | FileToolKind>;

/** Assert that the harness should call a tool. */
function called(
  kind: 'shell',
  matcher?: ShellCommandMatcher,
): ToolCalledAssertion<'shell'>;
function called<K extends FileToolKind>(
  kind: K,
  matcher?: ToolPathMatcher,
): ToolCalledAssertion<K>;
function called<K extends PlainToolKind>(kind: K): ToolCalledAssertion<K>;
function called(
  kind: ToolKind,
  matcher?: ShellCommandMatcher | ToolPathMatcher,
): ToolCalledAssertion {
  return createToolCalledAssertion(kind, matcher);
}

/** Assert that the harness should not call a tool. */
function notCalled(
  kind: 'shell',
  matcher?: ShellCommandMatcher,
): ToolNotCalledAssertion<'shell'>;
function notCalled<K extends FileToolKind>(
  kind: K,
  matcher?: ToolPathMatcher,
): ToolNotCalledAssertion<K>;
function notCalled<K extends PlainToolKind>(kind: K): ToolNotCalledAssertion<K>;
function notCalled(
  kind: ToolKind,
  matcher?: ShellCommandMatcher | ToolPathMatcher,
): ToolNotCalledAssertion {
  return createToolNotCalledAssertion(kind, matcher);
}

/** Authoring helpers for tool-use assertions. */
export const tool = {
  called,
  notCalled,
};
