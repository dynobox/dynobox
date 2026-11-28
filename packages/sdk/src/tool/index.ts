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
  WebFetchMatcher,
} from '../types/brands.js';

type PlainToolKind = Exclude<ToolKind, 'shell' | FileToolKind | 'web_fetch'>;

/** Assert that the harness should call a tool. */
function called(
  kind: 'shell',
  matcher?: ShellCommandMatcher,
): ToolCalledAssertion<'shell'>;
function called<K extends FileToolKind>(
  kind: K,
  matcher?: ToolPathMatcher,
): ToolCalledAssertion<K>;
function called(
  kind: 'web_fetch',
  matcher?: WebFetchMatcher,
): ToolCalledAssertion<'web_fetch'>;
function called<K extends PlainToolKind>(kind: K): ToolCalledAssertion<K>;
function called(
  kind: ToolKind,
  matcher?: ShellCommandMatcher | ToolPathMatcher | WebFetchMatcher,
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
function notCalled(
  kind: 'web_fetch',
  matcher?: WebFetchMatcher,
): ToolNotCalledAssertion<'web_fetch'>;
function notCalled<K extends PlainToolKind>(kind: K): ToolNotCalledAssertion<K>;
function notCalled(
  kind: ToolKind,
  matcher?: ShellCommandMatcher | ToolPathMatcher | WebFetchMatcher,
): ToolNotCalledAssertion {
  return createToolNotCalledAssertion(kind, matcher);
}

/** Authoring helpers for tool-use assertions. */
export const tool = {
  called,
  notCalled,
};
