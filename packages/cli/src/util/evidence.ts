import type {AssertionResult} from '@dynobox/evaluators';
import type {HttpEvent, ToolEvent} from '@dynobox/runner-local';

export function assertionResultEvidence(
  results: readonly AssertionResult[],
  assertionId: string,
): unknown {
  return results.find((candidate) => candidate.assertionId === assertionId)
    ?.evidence;
}

export function isToolEvent(value: unknown): value is ToolEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'rawName' in value &&
    typeof value.rawName === 'string'
  );
}

export function isHttpEvent(value: unknown): value is HttpEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

export function formatHttpEvent(event: HttpEvent): string {
  const status = event.status === undefined ? '' : ` -> ${event.status}`;
  return `${event.method} ${event.url}${status}`;
}
