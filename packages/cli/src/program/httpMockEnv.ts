import type {LocalRunnerJob} from '@dynobox/runner-local';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function mockedHosts(jobs: readonly LocalRunnerJob[]): string[] {
  return [
    ...new Set(
      jobs.flatMap((job) => Object.keys(job.scenario.httpMocks ?? {})),
    ),
  ];
}

/**
 * Node's built-in `fetch` uses the HTTP mock proxy only from Node 24
 * (`NODE_USE_ENV_PROXY`). Jobs run the `node` on PATH, which is the one that
 * runs this CLI. On older Node, Node programs reach the real mocked hosts.
 */
export function httpMockNodeWarning(
  jobs: readonly LocalRunnerJob[],
  nodeVersion: string = process.versions.node,
): string | undefined {
  if (Number(nodeVersion.split('.')[0]) >= 24) return undefined;
  const hosts = mockedHosts(jobs);
  if (hosts.length === 0) return undefined;
  return `warning: HTTP mocks need Node 24 or later, and this is Node ${nodeVersion}. On older Node, fetch in Node programs ignores the proxy, so their requests to ${hosts.join(', ')} reach the real hosts.\n`;
}

/**
 * The proxy keeps the user's NO_PROXY entries, and clients connect directly to
 * hosts they cover. A mocked host in NO_PROXY would reach the real server, so
 * runs with HTTP mocks refuse any entry other than loopback.
 */
export function httpMockNoProxyError(
  jobs: readonly LocalRunnerJob[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (mockedHosts(jobs).length === 0) return undefined;
  const names = ['NO_PROXY', 'no_proxy'].filter((name) =>
    (env[name] ?? '')
      .split(',')
      .some((entry) => entry.trim() !== '' && !LOOPBACK.has(entry.trim())),
  );
  if (names.length === 0) return undefined;
  return `HTTP mocks cannot run with ${names.join(' and ')} set. Clients connect directly to hosts in it, so a mocked host there would reach the real server. Clear it for this run: ${names.map((name) => `${name}=`).join(' ')} dynobox run ...`;
}
