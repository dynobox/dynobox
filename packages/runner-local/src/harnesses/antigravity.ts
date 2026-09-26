import {realpathSync} from 'node:fs';
import {readdir, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import type {PermissionMode} from '@dynobox/sdk';

import {
  createToolEvent,
  isRecord,
  jsonLines,
  type JsonObject,
  parseJsonObjectLine,
} from './parsing.js';
import {resolveMcpExecutable} from './resolveMcpExecutable.js';
import {runStreamingHarness} from './runStreamingHarness.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  PreparedMcpHarness,
  ToolEvent,
} from './types.js';
import {createVersionProbe} from './version.js';

export type AntigravityHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

export type AntigravityParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
  errorMessage: string | undefined;
  terminalFailure: boolean;
};

export type AntigravityParsedLine = {
  toolEvents: ToolEvent[];
  finalMessage?: string;
  errorMessage?: string;
  terminalFailure?: boolean;
};

export class AntigravityHarness implements Harness {
  readonly id = 'antigravity' as const;

  readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: AntigravityHarnessOptions = {}) {
    this.executable = options.executable ?? 'agy';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async prepareMcp(
    input: Pick<HarnessInput, 'workDir' | 'env'>,
  ): Promise<PreparedMcpHarness> {
    const {runAntigravityWithMcp} = await import('./antigravityMcp.js');
    const {executable, workDir} = await resolveMcpExecutable(
      this.executable,
      input,
    );
    const extraArgs = [...this.extraArgs];
    return {
      run: (runInput, servers) =>
        runAntigravityWithMcp({
          executable,
          input: {...runInput, workDir},
          servers,
          extraArgs,
        }),
    };
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const workDir = realpathSync(input.workDir);
    const home = input.env.HOME ?? process.env.HOME;
    await removeDynoboxProjectRecords(home);
    try {
      return await runStreamingHarness({
        executable: this.executable,
        args: buildAntigravityArgs(
          workDir,
          input.prompt,
          this.extraArgs,
          input.model,
          input.permissionMode,
          input.timeoutMs,
        ),
        input,
        cwd: workDir,
        stdin: 'ignore',
        parseLine: parseAntigravityJsonLine,
      });
    } finally {
      // `--new-project` leaves a record for this work directory behind.
      await removeDynoboxProjectRecords(home, workDir);
    }
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const parsed = parseAntigravityJson(raw.stdout);
    return {
      exitCode: raw.exitCode === 0 && parsed.terminalFailure ? 1 : raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: parsed.finalMessage,
      toolEvents: parsed.toolEvents,
      ...(parsed.errorMessage === undefined
        ? {}
        : {errorMessage: parsed.errorMessage}),
    };
  }
}

/** AGY print mode defaults to 5m; other harnesses have no inner cap. */
const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = '30m';

// Records this old cannot belong to a run that is still active.
const STALE_PROJECT_MS = 24 * 60 * 60 * 1000;

/**
 * Best effort: Antigravity keeps a project record for every run in the real
 * HOME. Remove dynobox records that are over a day old (from interrupted
 * runs), plus the record for `workDir` when given.
 */
export async function removeDynoboxProjectRecords(
  home: string | undefined,
  workDir?: string,
): Promise<void> {
  if (!home) return;
  const directory = join(home, '.gemini', 'config', 'projects');
  const folder =
    workDir === undefined ? undefined : pathToFileURL(workDir).href;
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      try {
        const record: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (
          !isRecord(record) ||
          typeof record.name !== 'string' ||
          !record.name.startsWith('dynobox-')
        )
          return;
        const resources = isRecord(record.projectResources)
          ? record.projectResources.resources
          : undefined;
        const ownsWorkDir =
          folder !== undefined &&
          Array.isArray(resources) &&
          resources.some(
            (resource) => isRecord(resource) && resource.folderUri === folder,
          );
        const stale =
          Date.now() - (await stat(path)).mtimeMs > STALE_PROJECT_MS;
        if (ownsWorkDir || stale) await rm(path, {force: true});
      } catch {
        // Skip records that are unreadable or already gone.
      }
    }),
  );
}

export function buildAntigravityArgs(
  workDir: string,
  prompt: string,
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
  timeoutMs?: number,
  projectId?: string,
): string[] {
  return [
    ...(projectId === undefined
      ? ['--new-project', '--add-dir', workDir]
      : ['--project', projectId]),
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--print-timeout',
    timeoutMs === undefined
      ? DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT
      : `${timeoutMs}ms`,
    ...(permissionMode === 'dangerous'
      ? ['--dangerously-skip-permissions']
      : []),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
  ];
}

export function parseAntigravityJson(stdout: string): AntigravityParsedOutput {
  let finalMessage: string | undefined;
  let errorMessage: string | undefined;
  let terminalFailure = false;
  const toolEvents: ToolEvent[] = [];

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseAntigravityJsonLine(line, lineNumber);
    toolEvents.push(...parsed.toolEvents);
    if (parsed.finalMessage !== undefined) finalMessage = parsed.finalMessage;
    if (parsed.errorMessage !== undefined) errorMessage = parsed.errorMessage;
    if (parsed.terminalFailure === true) terminalFailure = true;
  }

  return {finalMessage, toolEvents, errorMessage, terminalFailure};
}

export function parseAntigravityJsonLine(
  line: string,
  lineNumber = 1,
): AntigravityParsedLine {
  const event = parseJsonObjectLine(line, lineNumber, 'Antigravity JSON event');

  if (event.event === 'step_update' && isRecord(event.step_update)) {
    return {toolEvents: parseToolStep(event.step_update)};
  }

  if (event.event === 'result' && isRecord(event.result)) {
    return parseResult(event.result);
  }

  return {toolEvents: []};
}

function parseToolStep(step: JsonObject): ToolEvent[] {
  const subagentInfo = isRecord(step.subagent_info)
    ? step.subagent_info
    : undefined;
  if (
    (step.state !== 'DONE' && step.state !== 'ERROR') ||
    (step.step_type !== 'tool' && subagentInfo === undefined)
  ) {
    return [];
  }

  const toolInfo = isRecord(step.tool_info) ? step.tool_info : undefined;
  const rawName =
    stringValue(toolInfo?.name) ??
    stringValue(step.tool_name) ??
    (subagentInfo === undefined ? undefined : 'invoke_subagent');
  if (rawName === undefined) return [];

  const error = toolInfo?.error;
  const status =
    step.state === 'ERROR' || error != null ? 'failure' : 'success';
  const input = normalizeToolInput(toolInfo?.parameters ?? subagentInfo ?? {});
  const message =
    stringFromUnknown(error) ?? stringFromUnknown(toolInfo?.output);

  return [createToolEvent(rawName, input, status, message)];
}

function parseResult(result: JsonObject): AntigravityParsedLine {
  const status = stringValue(result.status);
  const finalMessage = nonEmptyString(result.response);
  const terminalFailure = status !== undefined && status !== 'SUCCESS';
  const errorMessage = terminalFailure
    ? (stringFromUnknown(result.error) ??
      `Antigravity run ended with status ${status}`)
    : undefined;

  return {
    toolEvents: [],
    ...(finalMessage === undefined ? {} : {finalMessage}),
    ...(errorMessage === undefined ? {} : {errorMessage}),
    ...(terminalFailure ? {terminalFailure: true} : {}),
  };
}

function normalizeToolInput(input: unknown): unknown {
  if (!isRecord(input) || typeof input.CommandLine !== 'string') return input;
  return {...input, command: input.CommandLine};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmptyString(value);
  if (!isRecord(value)) return undefined;
  return (
    stringFromUnknown(value.message) ??
    stringFromUnknown(value.error) ??
    stringFromUnknown(value.detail)
  );
}
