/**
 * Action handler for `dynobox init`.
 *
 * Creates a starter `*.dyno.{mjs,yaml}` under `./dynobox/` so a brand-new
 * project can go from `npm i -g dynobox` to a passing `dynobox run` in
 * two commands. Refuses to overwrite an existing file unless `--force`
 * is passed.
 */

import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {relative, resolve} from 'node:path';

import {type HarnessId} from '@dynobox/sdk';
import {CommanderError} from 'commander';

import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {validateHarnessOverrides} from './options.js';

export type InitCommandFlags = {
  yaml?: boolean;
  harness?: string;
  force?: boolean;
};

export type InitCommandActionInput = {
  commandFlags: InitCommandFlags;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
  /** Defaults to `process.cwd()`. Exposed for tests. */
  cwd?: string;
};

const STARTER_DIR = 'dynobox';
const MJS_BASENAME = 'example.dyno.mjs';
const YAML_BASENAME = 'example.dyno.yaml';

export async function initCommandAction(
  input: InitCommandActionInput,
): Promise<void> {
  const {commandFlags, writeStdout, writeStderr} = input;
  const cwd = input.cwd ?? process.cwd();
  const harness = validateStarterHarness(
    commandFlags.harness ?? 'claude-code',
    writeStderr,
  );

  const dir = resolve(cwd, STARTER_DIR);
  const basename = commandFlags.yaml === true ? YAML_BASENAME : MJS_BASENAME;
  const filePath = resolve(dir, basename);
  const relPath = relative(cwd, filePath) || filePath;

  if (existsSync(filePath) && commandFlags.force !== true) {
    writeStderr(
      `error: ${relPath} already exists. Pass --force to overwrite.\n`,
    );
    throw new CommanderError(configErrorExitCode, 'dynobox.init', 'exists');
  }

  mkdirSync(dir, {recursive: true});
  const body =
    commandFlags.yaml === true ? yamlTemplate(harness) : mjsTemplate(harness);
  writeFileSync(filePath, body);

  writeStdout(`Created ${relPath}

Next:
  dynobox run

`);
}

function validateStarterHarness(
  rawHarness: string,
  writeStderr: OutputWriter,
): HarnessId {
  try {
    const harnesses = validateHarnessOverrides([rawHarness]);
    const harness = harnesses?.[0];
    if (harness !== undefined) return harness;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`error: ${message}\n`);
    throw error;
  }

  const error = new CommanderError(
    configErrorExitCode,
    'dynobox.harness',
    'Harness id cannot be empty.',
  );
  writeStderr(`error: ${error.message}\n`);
  throw error;
}

function mjsTemplate(harness: HarnessId): string {
  return `import {artifact, defineDyno, finalMessage, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'example',
  harnesses: ['${harness}'],
  scenarios: [
    {
      name: 'inspects package.json',
      prompt:
        'Read package.json with a shell command and tell me whether a test script exists.',
      setup: [
        \`cat > package.json <<'JSON'
{
  "name": "dynobox-example",
  "scripts": {"test": "echo ok"}
}
JSON\`,
      ],
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'package.json'}),
        tool.notCalled('edit_file'),
        artifact.contains('package.json', 'echo ok'),
        finalMessage.contains('test'),
      ],
    },
  ],
});
`;
}

function yamlTemplate(harness: HarnessId): string {
  return `name: example
harnesses:
  - ${harness}
scenarios:
  - name: inspects package.json
    prompt: >-
      Read package.json with a shell command and tell me whether a test script
      exists.
    setup:
      - |
        cat > package.json <<'JSON'
        {
          "name": "dynobox-example",
          "scripts": {"test": "echo ok"}
        }
        JSON
    assertions:
      - label: uses shell
        type: tool.called
        tool: shell
      - label: reads package.json
        type: tool.called
        tool: shell
        command:
          includes: package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: echo ok
      - type: finalMessage.contains
        text: test
`;
}
