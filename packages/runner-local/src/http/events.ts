import type {HttpEvent} from '@dynobox/evaluators';
import type {IrEndpoint, IrScenario} from '@dynobox/sdk/ir';

export type HttpRoute = {
  endpointId: string;
  method: string;
  url: string;
  host: string;
};

export function scenarioNeedsHttpCapture(scenario: IrScenario): boolean {
  return scenario.assertions.some(
    (assertion) =>
      assertion.type === 'http.called' || assertion.type === 'http.notCalled',
  );
}

export function buildHttpRoutes(scenario: IrScenario): HttpRoute[] {
  const assertedEndpointIds = new Set(
    scenario.assertions.flatMap((assertion) =>
      assertion.type === 'http.called' || assertion.type === 'http.notCalled'
        ? [assertion.endpointId]
        : [],
    ),
  );

  return scenario.endpoints
    .filter((endpoint) => assertedEndpointIds.has(endpoint.id))
    .map(endpointToRoute);
}

export function matchHttpEndpointId(
  routes: readonly HttpRoute[],
  method: string,
  url: string,
): string | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedUrl = normalizeUrl(url);
  const match = routes.find(
    (route) =>
      route.method === normalizedMethod &&
      normalizeUrl(route.url) === normalizedUrl,
  );
  return match?.endpointId ?? null;
}

export function createHttpEvent(input: {
  routes: readonly HttpRoute[];
  method: string;
  url: string;
  host?: string | undefined;
  status?: number | undefined;
  timestamp?: string | undefined;
}): HttpEvent {
  const event: HttpEvent = {
    endpointId: matchHttpEndpointId(input.routes, input.method, input.url),
    method: input.method.toUpperCase(),
    url: normalizeUrl(input.url),
    host: input.host ?? hostFromUrl(input.url),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  if (input.status !== undefined) event.status = input.status;
  return event;
}

function endpointToRoute(endpoint: IrEndpoint): HttpRoute {
  return {
    endpointId: endpoint.id,
    method: endpoint.method.toUpperCase(),
    url: normalizeUrl(endpoint.url),
    host: hostFromUrl(endpoint.url),
  };
}

function normalizeUrl(url: string): string {
  return new URL(url).toString();
}

function hostFromUrl(url: string): string {
  return new URL(url).host;
}
