import {validateHeaderName, validateHeaderValue} from 'node:http';

import type {HttpEvent} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk/ir';
import {httpMockResponseSchema} from '@dynobox/sdk/ir';
import type {
  CompletedRequest,
  InitiatedRequest,
  Mockttp,
  requestSteps,
} from 'mockttp';
import {getLocal} from 'mockttp';

import {errorMessage} from '../diagnostics.js';
import {type DynoboxCA, ensureDynoboxCA} from './ca.js';
import {
  buildHttpRoutes,
  createHttpEvent,
  type HttpRoute,
  scenarioNeedsHttpCapture,
} from './events.js';

export type HttpCapture = {
  env: Record<string, string>;
  events: readonly HttpEvent[];
  /** Handler errors, invalid responses, and unfinished mocks fail the job. */
  failures: readonly string[];
  stop(): Promise<void>;
};

type HttpMockConfig = NonNullable<IrScenario['httpMocks']>[string];

export async function startHttpCapture(
  scenario: IrScenario,
  workDir: string,
): Promise<HttpCapture | undefined> {
  if (!scenarioNeedsHttpCapture(scenario)) return undefined;

  const routes = buildHttpRoutes(scenario);
  const mocks = Object.entries(scenario.httpMocks ?? {});
  const interceptedHosts = new Set([
    ...uniqueHosts(routes),
    ...mocks.map(([hostname]) => hostname),
  ]);
  const ca = await ensureDynoboxCA();
  const server = getLocal({
    https: {
      certPath: ca.certPath,
      keyPath: ca.keyPath,
      tlsInterceptOnly: [...interceptedHosts].map((hostname) => ({hostname})),
    },
  });
  const events: HttpEvent[] = [];
  const failures: string[] = [];
  const byRequestId = new Map<string, HttpEvent>();
  const pendingMocks = new Map<string, string>();
  let stopPromise: Promise<void> | undefined;

  await server.start();
  const mockedHosts = new Set(mocks.map(([hostname]) => hostname));
  await subscribeToEvents(server, routes, mockedHosts, events, byRequestId);
  // Every request to a mocked host goes to its mock, never to the real host.
  // `always()`: by default mockttp prefers an unused rule after the first
  // match, which would send later requests to the pass-through.
  for (const [hostname, mock] of mocks) {
    await server
      .forAnyRequest()
      .forHostname(hostname)
      .always()
      .thenCallback(async (request) => {
        if (stopPromise !== undefined)
          return {statusCode: 500, body: 'HTTP mock capture has stopped.'};
        const url = new URL(request.url);
        const description = `HTTP mock for ${hostname} failed on ${request.method} ${url.origin}${url.pathname}`;
        pendingMocks.set(request.id, description);
        try {
          return await mockResponse(mock, request, workDir);
        } catch (error) {
          const message = `${description}: ${errorMessage(error)}`;
          // stop() already records unfinished callbacks. Their eventual
          // rejection must not change the finalized evidence.
          if (pendingMocks.has(request.id)) failures.push(message);
          return {statusCode: 500, body: message};
        } finally {
          pendingMocks.delete(request.id);
        }
      });
  }
  await server.forAnyRequest().thenPassThrough();

  const proxyUrl = `http://127.0.0.1:${server.port}`;
  return {
    env: buildProxyEnv(proxyUrl, ca),
    events,
    failures,
    stop: () => {
      if (stopPromise !== undefined) return stopPromise;
      for (const description of pendingMocks.values()) {
        failures.push(
          `${description}: did not complete before the harness finished.`,
        );
      }
      pendingMocks.clear();
      stopPromise = server.stop();
      return stopPromise;
    },
  };
}

async function mockResponse(
  mock: HttpMockConfig,
  request: CompletedRequest,
  workDir: string,
): Promise<requestSteps.CallbackResponseMessageResult> {
  const authored =
    'response' in mock
      ? mock.response
      : await mock.handler({
          method: request.method,
          url: request.url,
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: (await request.body.getText()) ?? '',
          workDir,
        });
  const parsed = httpMockResponseSchema.safeParse(authored);
  if (!parsed.success) {
    throw new Error(
      `invalid response: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const {status, headers, body, json} = parsed.data;
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    responseHeaders[name.toLowerCase()] = value;
  }
  let responseBody = body ?? '';
  if (json !== undefined) {
    const serialized = JSON.stringify(json);
    if (serialized === undefined)
      throw new Error('invalid response: json must be JSON-serializable.');
    responseBody = serialized;
    responseHeaders['content-type'] = 'application/json';
  }
  return {
    statusCode: status,
    ...(headers === undefined && json === undefined
      ? {}
      : {headers: responseHeaders}),
    body: responseBody,
  };
}

async function subscribeToEvents(
  server: Mockttp,
  routes: readonly HttpRoute[],
  mockedHosts: ReadonlySet<string>,
  events: HttpEvent[],
  byRequestId: Map<string, HttpEvent>,
): Promise<void> {
  await server.on('request-initiated', (request) => {
    const event = eventFromRequest(routes, mockedHosts, request);
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
  mockedHosts: ReadonlySet<string>,
  request: InitiatedRequest,
): HttpEvent {
  const hostname = request.destination.hostname.toLowerCase();
  return createHttpEvent({
    routes,
    method: request.method,
    url: request.url,
    host: hostname,
    timestamp: new Date(request.timingEvents.startTime).toISOString(),
    mocked: mockedHosts.has(hostname),
  });
}

function buildProxyEnv(
  proxyUrl: string,
  ca: DynoboxCA,
): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
    no_proxy: mergeNoProxy(process.env.no_proxy),
    // Node's built-in fetch ignores the proxy variables without this (Node 24+).
    NODE_USE_ENV_PROXY: '1',
    // Node adds these to its own roots; the others replace the trust store.
    NODE_EXTRA_CA_CERTS: ca.certPath,
    SSL_CERT_FILE: ca.bundlePath,
    REQUESTS_CA_BUNDLE: ca.bundlePath,
    CURL_CA_BUNDLE: ca.bundlePath,
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
