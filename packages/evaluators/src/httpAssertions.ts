import type {JsonValue} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {matchesMcpInput} from './mcpAssertions.js';
import {failed, passed} from './results.js';
import type {AssertionResult, HttpEvent} from './types.js';

type HttpCalledAssertion = Extract<IrAssertion, {type: 'http.called'}>;
type HttpNotCalledAssertion = Extract<IrAssertion, {type: 'http.notCalled'}>;

export function evaluateHttpCalled(
  assertion: HttpCalledAssertion,
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

  const hasBodyMatcher =
    assertion.json !== undefined || assertion.bodyIncludes !== undefined;

  if (assertion.status === undefined && !hasBodyMatcher) {
    return passed(
      assertion,
      `Observed HTTP endpoint "${assertion.endpointId}".`,
      matches[0],
    );
  }

  const fullMatch = matches.find((event) =>
    httpEventMatchesCriteria(event, assertion),
  );
  if (fullMatch !== undefined) {
    const qualifiers = describeHttpCriteria(assertion);
    return passed(
      assertion,
      `Observed HTTP endpoint "${assertion.endpointId}" with ${qualifiers}.`,
      fullMatch,
    );
  }

  if (!hasBodyMatcher && assertion.status !== undefined) {
    const observedStatuses = [
      ...new Set(matches.map((event) => event.status ?? 'unknown')),
    ].join(', ');
    return failed(
      assertion,
      `Expected HTTP endpoint "${assertion.endpointId}" to return status ${assertion.status}, but observed ${observedStatuses}.`,
    );
  }

  const statusMatches =
    assertion.status === undefined
      ? matches
      : matches.filter((event) => event.status === assertion.status);
  if (assertion.status !== undefined && statusMatches.length === 0) {
    const observedStatuses = [
      ...new Set(matches.map((event) => event.status ?? 'unknown')),
    ].join(', ');
    return failed(
      assertion,
      `Expected HTTP endpoint "${assertion.endpointId}" with ${describeHttpCriteria(assertion)}, but observed status ${observedStatuses}.`,
    );
  }

  return failed(
    assertion,
    `Expected HTTP endpoint "${assertion.endpointId}" with ${describeHttpCriteria(assertion)}, but no request body matched (${statusMatches.length} ${statusMatches.length === 1 ? 'request' : 'requests'} observed).`,
  );
}

export function evaluateHttpNotCalled(
  assertion: HttpNotCalledAssertion,
  httpEvents: readonly HttpEvent[],
): AssertionResult {
  const match = httpEvents.find(
    (event) =>
      event.endpointId === assertion.endpointId &&
      httpEventMatchesCriteria(event, assertion),
  );

  const qualifiers = describeHttpCriteria(assertion);
  const suffix = qualifiers.length === 0 ? '' : ` with ${qualifiers}`;

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: `Expected HTTP endpoint "${assertion.endpointId}"${suffix} not to be called, but observed a matching request.`,
      evidence: match,
    };
  }

  return passed(
    assertion,
    `Observed no calls to HTTP endpoint "${assertion.endpointId}"${suffix}.`,
  );
}

function httpEventMatchesCriteria(
  event: HttpEvent,
  criteria: {
    status?: number | undefined;
    json?: JsonValue | undefined;
    bodyIncludes?: string | undefined;
  },
): boolean {
  if (criteria.status !== undefined && event.status !== criteria.status) {
    return false;
  }
  if (criteria.bodyIncludes !== undefined) {
    if (
      typeof event.requestBody !== 'string' ||
      !event.requestBody.includes(criteria.bodyIncludes)
    ) {
      return false;
    }
  }
  if (criteria.json !== undefined) {
    if (typeof event.requestBody !== 'string') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.requestBody);
    } catch {
      return false;
    }
    if (!matchesMcpInput(parsed as JsonValue, criteria.json)) {
      return false;
    }
  }
  return true;
}

function describeHttpCriteria(criteria: {
  status?: number | undefined;
  json?: JsonValue | undefined;
  bodyIncludes?: string | undefined;
}): string {
  const parts: string[] = [];
  if (criteria.status !== undefined) parts.push(`status ${criteria.status}`);
  if (criteria.json !== undefined) {
    parts.push(`JSON body matching ${JSON.stringify(criteria.json)}`);
  }
  if (criteria.bodyIncludes !== undefined) {
    parts.push(`body including ${JSON.stringify(criteria.bodyIncludes)}`);
  }
  return parts.join(', ');
}
