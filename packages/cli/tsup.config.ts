import {defineConfig} from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/bin.ts'],
  external: [
    '@dynobox/sdk',
    'commander',
    'execa',
    'mockttp',
    'tinyglobby',
    'tsx',
    'yaml',
  ],
  format: ['esm'],
  noExternal: [
    '@dynobox/runner-local',
    '@dynobox/evaluators',
    '@dynobox/run-schema',
  ],
  platform: 'node',
  splitting: false,
});
