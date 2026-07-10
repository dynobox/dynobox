/**
 * For every file extension `discoverDynos` globs for, confirm the full
 * load pipeline (`loadDyno` → `resolveConfigModule` → `compile`) actually
 * produces an IR. Without these tests, the help text and docs are
 * making promises the loader has never been asked to keep.
 *
 * `.yaml` / `.yml` are covered separately in `yamlLoader.test.ts`.
 *
 * `.cjs` / `.cts` are intentionally NOT supported and intentionally
 * NOT covered here. See `DYNO_FILE_GLOBS` in `discoverDynos.ts` for the
 * reasoning (the SDK has no `"require"` condition in its exports map).
 */

import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {compile, resolveConfigModule} from '@dynobox/sdk/compiler';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {loadDyno, normalizeLoadedModule} from './configLoader.js';
import {DYNO_FILE_GLOBS} from './discoverDynos.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-loader-ext');

const ESM_BODY = `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: '__NAME__',
  harnesses: ['claude-code'],
  scenarios: [
    {
      name: 'noop',
      prompt: 'do nothing',
      assertions: [tool.notCalled('shell')],
    },
  ],
});
`;

function writeFixture(name: string, body: string): string {
  const file = join(ROOT, name);
  writeFileSync(file, body);
  return file;
}

async function compileFixture(file: string) {
  const loaded = await loadDyno(file);
  const config = resolveConfigModule(normalizeLoadedModule(loaded));
  return compile(config);
}

describe('loadDyno extension coverage', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
    // Force `.js` files written here to be ESM. tsx infers module kind
    // partly from the nearest package.json; without this, a stray
    // ancestor with `"type": "commonjs"` could flip the result.
    writeFileSync(join(ROOT, 'package.json'), JSON.stringify({type: 'module'}));
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('loads .mjs (ESM JavaScript)', async () => {
    const file = writeFixture(
      'roundtrip.dyno.mjs',
      ESM_BODY.replace('__NAME__', 'ext-mjs'),
    );
    const ir = await compileFixture(file);
    expect(ir.name).toBe('ext-mjs');
  });

  it('loads .js with ESM (parent package.json has type:module)', async () => {
    const file = writeFixture(
      'roundtrip.dyno.js',
      ESM_BODY.replace('__NAME__', 'ext-js'),
    );
    const ir = await compileFixture(file);
    expect(ir.name).toBe('ext-js');
  });

  it('loads .ts (TypeScript via tsx)', async () => {
    const file = writeFixture(
      'roundtrip.dyno.ts',
      ESM_BODY.replace('__NAME__', 'ext-ts'),
    );
    const ir = await compileFixture(file);
    expect(ir.name).toBe('ext-ts');
  });

  it('loads .mts (TypeScript ESM)', async () => {
    const file = writeFixture(
      'roundtrip.dyno.mts',
      ESM_BODY.replace('__NAME__', 'ext-mts'),
    );
    const ir = await compileFixture(file);
    expect(ir.name).toBe('ext-mts');
  });

  // Exercises skill/fixtures defaults through the CLI loadDyno pipeline in the
  // workspace. SDK resolves to packages/sdk/dist/, which already matched
  // isSdkFrame before SDK_MODULE_FILE. Npx/published-path caller inference is
  // covered in packages/sdk/src/index.test.ts.
  it('loads skill dynos with fixtures and skill setup defaults', async () => {
    const skillDir = join(ROOT, '.agents', 'skills', 'commit');
    const dynoDir = join(skillDir, 'dyno');
    mkdirSync(join(dynoDir, 'fixtures'), {recursive: true});
    writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
    writeFileSync(join(dynoDir, 'fixtures', 'README.md'), '# Fixture');
    const file = join(dynoDir, 'commit.dyno.ts');
    writeFileSync(
      file,
      `import {defineDyno} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
    );

    const loaded = await loadDyno(file);
    const config = resolveConfigModule(normalizeLoadedModule(loaded));
    const scenario = config.scenarios[0];
    if (!scenario) {
      throw new Error('Expected loaded dyno to contain a scenario');
    }
    expect(scenario.fixtures).toBe(join(dynoDir, 'fixtures'));
    expect(scenario.setup).toEqual([
      "mkdir -p '.agents/skills/commit'",
      expect.stringMatching(
        /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
      ),
      "mkdir -p '.claude/skills/commit'",
      expect.stringMatching(
        /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
      ),
    ]);
  });

  it('DYNO_FILE_GLOBS contains exactly the extensions exercised here plus yaml/yml', () => {
    // Guards against silent drift: if anyone adds a new extension to
    // `DYNO_FILE_GLOBS` without adding a test for it, this fails and
    // they're forced to either back it out or prove it works.
    const exercised = new Set([
      '.mjs',
      '.js',
      '.ts',
      '.mts',
      '.yaml', // covered in yamlLoader.test.ts
      '.yml', // covered in yamlLoader.test.ts
    ]);
    const glob = new Set(
      DYNO_FILE_GLOBS.map((g) => g.replace('**/*.dyno', '')),
    );
    expect(glob).toEqual(exercised);
  });
});
