import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import * as configLoader from './configLoader.js';

describe('configLoader', () => {
  it('exports loadDyno without a loadConfigModule alias', () => {
    expect(configLoader.loadDyno).toBeTypeOf('function');
    expect('loadConfigModule' in configLoader).toBe(false);
  });

  it('unwraps one level of default nesting from loaded modules', () => {
    expect(
      configLoader.normalizeLoadedModule({
        default: {default: {name: 'nested'}},
      }),
    ).toEqual({
      default: {name: 'nested'},
    });
    expect(
      configLoader.normalizeLoadedModule({default: {name: 'plain'}}),
    ).toEqual({
      default: {name: 'plain'},
    });
  });

  it('loads external TypeScript dynos with all CLI-owned SDK entrypoints without deprecated hooks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dynobox-config-loader-'));
    const warnings: NodeJS.ErrnoException[] = [];
    const onWarning = (warning: NodeJS.ErrnoException) =>
      warnings.push(warning);
    process.on('warning', onWarning);
    try {
      writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(directory, 'helper.ts'),
        'export const prompt: string = "Do nothing.";',
      );
      const file = join(directory, 'external.dyno.mts');
      writeFileSync(
        file,
        `import {defineDyno} from '@dynobox/sdk';
import {compile} from '@dynobox/sdk/compiler';
import {irSchema} from '@dynobox/sdk/ir';
import {prompt} from './helper.ts';

const name: string = 'external';
const dyno = defineDyno({name, scenarios: [{name, prompt}]});
export const valid = irSchema.safeParse(compile(dyno)).success;
export default dyno;
`,
      );

      const loaded = configLoader.normalizeLoadedModule(
        await configLoader.loadDyno(file),
      );
      expect(loaded).toMatchObject({
        default: {name: 'external', scenarios: [{prompt: 'Do nothing.'}]},
        valid: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warnings.filter((warning) => warning.code === 'DEP0205')).toEqual(
        [],
      );
    } finally {
      process.off('warning', onWarning);
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
