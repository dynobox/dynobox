import type {RunJobProgressEvent} from '@dynobox/runner-local';

import {describeToolEvent} from '../render/describe.js';
import {renderPhaseRow, setupDurationMs} from '../render/phases.js';
import {dim, formatCount, type RenderContext} from '../terminal/index.js';
import type {LiveLine} from './dashboard.js';

export type LiveJobState = {
  setupCommandCount: number;
  fixturesCount: number;
  toolCount: number;
  assertionCount: number;
  phaseStartedAtMs: number;
};

/**
 * Map runner progress events to `LiveLine`s for the live writer. Pure: keeps
 * a small per-job state object (`LiveJobState`) updated as events arrive,
 * but does not own a clock or write to a terminal.
 */
export function renderLiveProgressEvent(
  event: RunJobProgressEvent,
  state: LiveJobState,
  ctx: RenderContext,
): LiveLine {
  if (event.type === 'fixtures.started') {
    state.fixturesCount = event.fixturesCount;
    if (event.fixturesCount === 0) return {kind: 'skip'};
    state.phaseStartedAtMs = Date.now();
    const detail = formatCount(event.fixturesCount, 'path');
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'fixtures',
          detail,
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'fixtures.completed') {
    if (state.fixturesCount === 0) return {kind: 'skip'};
    const status = event.fixturesResult.success ? 'pass' : 'fail';
    return {
      kind: 'commit',
      text: renderPhaseRow(ctx, {
        status,
        label: 'fixtures',
        detail: formatCount(state.fixturesCount, 'path'),
        durationMs: setupDurationMs(event.fixturesResult),
      }),
    };
  }

  if (event.type === 'setup.started') {
    state.setupCommandCount = event.commandCount;
    state.phaseStartedAtMs = Date.now();
    const detail = formatCount(event.commandCount, 'command');
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'setup',
          detail,
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'setup.completed') {
    const status = event.setupResult.success ? 'pass' : 'fail';
    return {
      kind: 'commit',
      text: renderPhaseRow(ctx, {
        status,
        label: 'setup',
        detail: formatCount(state.setupCommandCount, 'command'),
        durationMs: setupDurationMs(event.setupResult),
      }),
    };
  }

  if (event.type === 'harness.started') {
    state.phaseStartedAtMs = Date.now();
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'harness',
          detail: 'running prompt...',
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'harness.tool') {
    state.toolCount = event.toolCount;
    const {toolEvent, toolCount} = event;
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'harness',
          detail: `${describeToolEvent(toolEvent)} ${dim(ctx, formatCount(toolCount, 'tool'))}`,
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'harness.completed') {
    state.toolCount = event.toolCount;
    const harnessDurationMs =
      event.durationMs ?? Date.now() - state.phaseStartedAtMs;
    return {
      kind: 'commit',
      text: renderPhaseRow(ctx, {
        status: event.success ? 'pass' : 'fail',
        label: 'harness',
        detail: event.success
          ? `ran prompt ${dim(ctx, formatCount(event.toolCount, 'tool'))}`
          : 'failed',
        durationMs: harnessDurationMs,
      }),
    };
  }

  if (event.type === 'assertions.started') {
    state.assertionCount = event.assertionCount;
    state.phaseStartedAtMs = Date.now();
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'assertions',
          detail: 'evaluating...',
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  // assertions.completed
  const passedCount = event.assertionResults.filter(
    (assertionResult) => assertionResult.passed,
  ).length;
  const status =
    passedCount === event.assertionResults.length && !event.verificationFailed
      ? 'pass'
      : 'fail';
  const detail =
    event.assertionResults.length === 0 && event.verificationFailed
      ? 'verification failed'
      : `${passedCount} of ${state.assertionCount} passed${event.verificationFailed ? '; verification failed' : ''}`;
  return {
    kind: 'commit',
    text: renderPhaseRow(ctx, {
      status,
      label: 'assertions',
      detail,
    }),
  };
}
