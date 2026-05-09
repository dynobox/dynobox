/**
 * Shared test fixtures and harness helpers used by the per-module test
 * files. Excluded from the published bundle (test files are not in the
 * tsup `entry`) but can be imported via relative paths from any test file.
 *
 * Vitest runs test files in parallel by default, so each file should
 * allocate its own fixture set via `createFixtureSet('<file-tag>')` to
 * avoid stomping on a shared directory.
 */

import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  FakeHarness,
  type Harness,
  type HarnessInput,
  type HarnessResult,
  type HarnessRunOutput,
  type ShellToolEvent,
} from '@dynobox/runner-local';

const ANSI_ESCAPE_PATTERN = /\x5B[0-9;]*m/g;

/** Strip ANSI color codes for plain-text comparison. */
export function stripAnsi(text: string): string {
  return text.replaceAll('\x1B', '').replace(ANSI_ESCAPE_PATTERN, '');
}

const VALID_CONFIG = `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'cli-local-runner',
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test and summarize the result.',
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'pnpm test'}),
      ],
    },
  ],
});
`;

const INVALID_CONFIG = `export default {
  scenarios: [{name: 'missing prompt'}],
};
`;

const SETUP_FAIL_CONFIG = `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'setup breaks',
      prompt: 'Run pnpm test.',
      setup: ['echo setup failed >&2 && exit 7'],
      assertions: [tool.called('shell')],
    },
  ],
});
`;

const MODALITIES_CONFIG = `import {artifact, defineDyno, finalMessage, sequence, tool, transcript} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'modalities',
      prompt: 'Test assertion modalities.',
      setup: ['printf dynobox@0.0.5 > CHANGELOG.md'],
      assertions: [
        tool.notCalled('shell', {includes: 'npm publish'}),
        artifact.exists('CHANGELOG.md'),
        artifact.contains('CHANGELOG.md', 'dynobox@0.0.5'),
        transcript.contains('EOTP'),
        finalMessage.contains('working tree is dirty'),
        sequence.inOrder([
          tool.called('shell', {includes: 'git status'}),
          tool.called('shell', {includes: 'git commit'}),
        ]),
      ],
    },
  ],
});
`;

const SEQUENCE_FAIL_CONFIG = `import {defineDyno, sequence, tool} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'sequence fails',
      prompt: 'Commit safely.',
      assertions: [
        sequence.inOrder([
          tool.called('shell', {includes: 'git status'}),
          tool.called('shell', {includes: 'git commit'}),
        ]),
      ],
    },
  ],
});
`;

const DYNO_MJS_CONFIG = `import {defineDyno, dyno, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  scenarios: [
    {
      name: 'uses dyno mjs',
      prompt: 'Run pnpm test.',
      setup: [
        'cp ' + here.q('fixtures/repo/marker.txt') + ' marker.txt',
      ],
      assertions: [tool.called('shell')],
    },
  ],
});
`;

export type FixtureSet = {
  dir: string;
  validConfigPath: string;
  invalidConfigPath: string;
  setupFailConfigPath: string;
  modalitiesConfigPath: string;
  sequenceFailConfigPath: string;
  dynoMjsConfigPath: string;
  setup: () => void;
  teardown: () => void;
};

/**
 * Create a fixture set rooted at a file-unique directory.
 *
 * Each test file should pass a unique tag (typically derived from the file
 * name) so parallel Vitest runs don't race on the same directory.
 */
export function createFixtureSet(tag: string): FixtureSet {
  const dir = join(process.cwd(), `.tmp-dynobox-cli-tests-${tag}`);
  const validConfigPath = join(dir, 'valid.config.ts');
  const invalidConfigPath = join(dir, 'invalid.config.ts');
  const setupFailConfigPath = join(dir, 'setup-fail.config.ts');
  const modalitiesConfigPath = join(dir, 'modalities.config.ts');
  const sequenceFailConfigPath = join(dir, 'sequence-fail.config.ts');
  const dynoMjsConfigPath = join(dir, 'typed.dyno.mjs');

  return {
    dir,
    validConfigPath,
    invalidConfigPath,
    setupFailConfigPath,
    modalitiesConfigPath,
    sequenceFailConfigPath,
    dynoMjsConfigPath,
    setup() {
      rmSync(dir, {force: true, recursive: true});
      mkdirSync(dir, {recursive: true});
      writeFileSync(validConfigPath, VALID_CONFIG);
      writeFileSync(invalidConfigPath, INVALID_CONFIG);
      writeFileSync(setupFailConfigPath, SETUP_FAIL_CONFIG);
      writeFileSync(modalitiesConfigPath, MODALITIES_CONFIG);
      writeFileSync(sequenceFailConfigPath, SEQUENCE_FAIL_CONFIG);
      mkdirSync(join(dir, 'fixtures/repo'), {recursive: true});
      writeFileSync(join(dir, 'fixtures/repo/marker.txt'), 'ready');
      writeFileSync(dynoMjsConfigPath, DYNO_MJS_CONFIG);
    },
    teardown() {
      rmSync(dir, {force: true, recursive: true});
    },
  };
}

export const SHELL_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'pnpm test'},
  command: 'pnpm test',
};

export const MISMATCHED_SHELL_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'npm test'},
  command: 'npm test',
};

export const GIT_STATUS_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'git status'},
  command: 'git status',
};

export const GIT_COMMIT_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'git commit -m test'},
  command: 'git commit -m test',
};

export const MULTILINE_GIT_COMMIT_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {
    command: `pnpm test && git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
  },
  command: `pnpm test && git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
};

/** A `FakeHarness` preconfigured to emit a single `pnpm test` shell event. */
export function createPassingHarness(): FakeHarness {
  return new FakeHarness(undefined, {toolEvents: [SHELL_EVENT]});
}

/**
 * Streams a tool event through `onToolEvent` mid-run, so live-progress tests
 * can observe the live writer reacting to in-flight events.
 */
export class StreamingHarness implements Harness {
  readonly id = 'claude-code' as const;

  constructor(private readonly toolEvent: ShellToolEvent = SHELL_EVENT) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    input.onToolEvent?.(this.toolEvent);
    return {exitCode: 0, stdout: 'fake output', stderr: '', durationMs: 100};
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout,
      toolEvents: [this.toolEvent],
    };
  }
}

/** Always-passing harness that doesn't stream tool events. */
export class PassingHarness implements Harness {
  constructor(readonly id: 'claude-code' | 'codex') {}

  async run(_input: HarnessInput): Promise<HarnessRunOutput> {
    return {exitCode: 0, stdout: 'fake output', stderr: '', durationMs: 100};
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout,
      toolEvents: [SHELL_EVENT],
    };
  }
}
