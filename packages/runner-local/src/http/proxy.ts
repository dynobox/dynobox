import type {HttpEvent} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk/ir';
import type {InitiatedRequest, Mockttp} from 'mockttp';
import {getLocal} from 'mockttp';

import {ensureDynoboxCA} from './ca.js';
import {
  buildHttpRoutes,
  createHttpEvent,
  type HttpRoute,
  scenarioNeedsHttpCapture,
} from './events.js';

export type HttpCapture = {
  env: Record<string, string>;
  events: readonly HttpEvent[];
  stop(): Promise<void>;
};

export async function startHttpCapture(
  scenario: IrScenario,
): Promise<HttpCapture | undefined> {
  if (!scenarioNeedsHttpCapture(scenario)) return undefined;

  const routes = buildHttpRoutes(scenario);
  const ca = await ensureDynoboxCA();
  const server = getLocal({
    https: {
      certPath: ca.certPath,
      keyPath: ca.keyPath,
      tlsInterceptOnly: uniqueHosts(routes).map((hostname) => ({hostname})),
    },
  });
  const events: HttpEvent[] = [];
  const byRequestId = new Map<string, HttpEvent>();

  await server.start();
  await subscribeToEvents(server, routes, events, byRequestId);
  await server.forAnyRequest().thenPassThrough();

  const proxyUrl = `http://127.0.0.1:${server.port}`;
  return {
    env: buildProxyEnv(proxyUrl, ca.certPath),
    events,
    stop: async () => {
      await server.stop();
    },
  };
}

async function subscribeToEvents(
  server: Mockttp,
  routes: readonly HttpRoute[],
  events: HttpEvent[],
  byRequestId: Map<string, HttpEvent>,
): Promise<void> {
  await server.on('request-initiated', (request) => {
    const event = eventFromRequest(routes, request);
    events.push(event);
    byRequestId.set(request.id, event);
  });

  await server.on('response-initiated', (response) => {
    const event = byRequestId.get(response.id);
    if (event !== undefined) event.status = response.statusCode;
  });

  await server.on('response', (response) => {
    const event = byRequestId.get(response.id);
    if (event !== undefined) event.status = response.statusCode;
  });
}

function eventFromRequest(
  routes: readonly HttpRoute[],
  request: InitiatedRequest,
): HttpEvent {
  return createHttpEvent({
    routes,
    method: request.method,
    url: request.url,
    host: request.destination.hostname,
    timestamp: new Date(request.timingEvents.startTime).toISOString(),
  });
}

function buildProxyEnv(
  proxyUrl: string,
  caPath: string,
): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
    no_proxy: mergeNoProxy(process.env.no_proxy),
    NODE_EXTRA_CA_CERTS: caPath,
    SSL_CERT_FILE: caPath,
    REQUESTS_CA_BUNDLE: caPath,
    CURL_CA_BUNDLE: caPath,
  };
}

function mergeNoProxy(existing: string | undefined): string {
  const entries = new Set(
    (existing ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const entry of ['localhost', '127.0.0.1', '::1']) {
    entries.add(entry);
  }
  return [...entries].join(',');
}

function uniqueHosts(routes: readonly HttpRoute[]): string[] {
  return [...new Set(routes.map((route) => new URL(route.url).hostname))];
}
