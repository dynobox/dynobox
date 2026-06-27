import type {IrAssertion} from '@dynobox/sdk/ir';

import {failed, passed} from './results.js';
import type {AssertionResult, HttpEvent} from './types.js';

export function evaluateHttpCalled(
  assertion: Extract<IrAssertion, {kind: 'http.called'}>,
  httpEvents: readonly HttpEvent[],
): AssertionResult {
  const matches = httpEvents.filter(
    (event) => event.endpointId === assertion.endpointId,
  );

  if (matches.length === 0) {
    return failed(
      assertion,
      `Expected HTTP endpoint "${assertion.endpointId}" to be called, but observed none.`,
    );
  }

  if (assertion.status === undefined) {
    return passed(
      assertion,
      `Observed HTTP endpoint "${assertion.endpointId}".`,
      matches[0],
    );
  }

  const statusMatch = matches.find(
    (event) => event.status === assertion.status,
  );
  if (statusMatch !== undefined) {
    return passed(
      assertion,
      `Observed HTTP endpoint "${assertion.endpointId}" with status ${assertion.status}.`,
      statusMatch,
    );
  }

  const observedStatuses = [
    ...new Set(matches.map((event) => event.status ?? 'unknown')),
  ].join(', ');
  return failed(
    assertion,
    `Expected HTTP endpoint "${assertion.endpointId}" to return status ${assertion.status}, but observed ${observedStatuses}.`,
  );
}

export function evaluateHttpNotCalled(
  assertion: Extract<IrAssertion, {kind: 'http.notCalled'}>,
  httpEvents: readonly HttpEvent[],
): AssertionResult {
  const match = httpEvents.find(
    (event) => event.endpointId === assertion.endpointId,
  );

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: `Expected HTTP endpoint "${assertion.endpointId}" not to be called, but observed a matching request.`,
      evidence: match,
    };
  }

  return passed(
    assertion,
    `Observed no calls to HTTP endpoint "${assertion.endpointId}".`,
  );
}
