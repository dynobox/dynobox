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
 * Node programs use the HTTP mock proxy through `NODE_USE_ENV_PROXY`. Node
 * 22.21+ and 24.5+ apply it to fetch, http, and https. Node 24.0 to 24.4 apply
 * it to fetch only, and older Node ignores it. Jobs run the `node` on PATH,
 * which is the one that runs this CLI.
 */
export function httpMockNodeWarning(
  jobs: readonly LocalRunnerJob[],
  nodeVersion: string = process.versions.node,
): string | undefined {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  if (
    major > 24 ||
    (major === 24 && minor >= 5) ||
    (major === 22 && minor >= 21)
  )
    return undefined;
  const hosts = mockedHosts(jobs);
  if (hosts.length === 0) return undefined;
  return `warning: Node ${nodeVersion} does not send all requests through the HTTP mock proxy. Node programs can reach the real hosts: ${hosts.join(', ')}. Use Node 24.5 or later.\n`;
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
