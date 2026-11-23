import type {LocalRunnerJob} from '@dynobox/runner-local';

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
  const hosts = new Set(
    jobs.flatMap((job) => Object.keys(job.scenario.httpMocks ?? {})),
  );
  if (hosts.size === 0) return undefined;
  return `warning: HTTP mocks need Node 24 or later, and this is Node ${nodeVersion}. On older Node, fetch in Node programs ignores the proxy, so their requests to ${[...hosts].join(', ')} reach the real hosts.\n`;
}
