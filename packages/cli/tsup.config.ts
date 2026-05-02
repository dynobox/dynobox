import {defineConfig} from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/index.ts', 'src/bin.ts'],
  external: ['@dynobox/sdk', 'commander', 'execa', 'tsx'],
  format: ['esm'],
  noExternal: ['@dynobox/runner-local', '@dynobox/evaluators'],
  platform: 'node',
  splitting: false,
});
