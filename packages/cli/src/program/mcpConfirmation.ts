import {createInterface} from 'node:readline';

import type {Harness} from '@dynobox/runner-local';
import {CommanderError} from 'commander';

import type {OutputWriter} from './execute.js';
import {cancelledExitCode, configErrorExitCode} from './exitCodes.js';

type Request = {
  harness: Harness['id'];
  mocks: readonly string[];
  workDir: string;
};

/** One invocation-wide consent gate, before setup, probes, or MCP clients. */
export async function confirmUnmockedMcp(input: {
  requests: readonly Request[];
  harnesses: readonly Harness[];
  env: Record<string, string> | undefined;
  allow: boolean;
  writeStderr: OutputWriter;
  readLine: (() => Promise<string | undefined>) | undefined;
}): Promise<boolean> {
  const inspections = new Map<
    string,
    Promise<{servers: readonly string[]; complete: boolean}>
  >();
  const inventories = await Promise.all(
    input.requests.map(async (request) => {
      const harness = input.harnesses.find((h) => h.id === request.harness);
      // An adapter without inspection must execute with mocks only.
      if (!harness?.inspectMcp) return undefined;
      const key = `${request.harness}\0${request.workDir}`;
      let inspection = inspections.get(key);
      if (!inspection) {
        inspection = Promise.resolve()
          .then(() =>
            harness.inspectMcp!({
              workDir: request.workDir,
              env: input.env ?? {},
            }),
          )
          .catch(() => ({servers: [], complete: false}));
        inspections.set(key, inspection);
      }
      const inventory = await inspection;
      return {
        harness: request.harness,
        servers: inventory.servers.filter(
          (name) => !request.mocks.includes(name),
        ),
        complete: inventory.complete,
      };
    }),
  );
  const warnings = new Map<string, {servers: Set<string>; complete: boolean}>();
  for (const inventory of inventories) {
    if (!inventory) continue;
    if (inventory.complete && inventory.servers.length === 0) continue;
    const warning = warnings.get(inventory.harness) ?? {
      servers: new Set<string>(),
      complete: true,
    };
    for (const name of inventory.servers) warning.servers.add(name);
    warning.complete &&= inventory.complete;
    warnings.set(inventory.harness, warning);
  }
  if (warnings.size === 0) return input.allow;

  input.writeStderr(
    'MCP mocks replace only the declared servers. Other MCPs remain real and may be used during this run.\n',
  );
  for (const [harness, warning] of warnings) {
    if (warning.servers.size > 0)
      input.writeStderr(
        `${harness}: other configured MCPs: ${[...warning.servers]
          .sort()
          .map((name) => JSON.stringify(name))
          .join(', ')}.\n`,
      );
    if (!warning.complete)
      input.writeStderr(
        `${harness}: additional MCPs may load; inventory is incomplete.\n`,
      );
  }
  if (input.allow) return true;
  const env = {...process.env, ...input.env};
  if (!input.readLine && (!process.stdin.isTTY || env.CI)) {
    const message =
      'Use --allow-unmocked-mcp to permit other MCP servers in a noninteractive run.';
    input.writeStderr(`error: ${message}\n`);
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.mcpConsent',
      message,
    );
  }

  const reader = input.readLine
    ? undefined
    : createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
  reader?.on('SIGINT', () => reader.close());
  const lines = reader?.[Symbol.asyncIterator]();
  const readLine = input.readLine ?? (async () => (await lines!.next()).value);
  try {
    for (;;) {
      input.writeStderr('Continue? [Y/n] ');
      const line = await readLine();
      const answer = line?.trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') return true;
      if (answer === undefined || answer === 'n' || answer === 'no') {
        input.writeStderr('Run cancelled.\n');
        throw new CommanderError(
          cancelledExitCode,
          'dynobox.cancelled',
          'run cancelled',
        );
      }
      input.writeStderr('Please answer y or n.\n');
    }
  } finally {
    reader?.close();
  }
}
