import {defineConfig} from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/bin.ts'],
  external: ['@dynobox/sdk', 'commander', 'execa', 'tinyglobby', 'tsx', 'yaml'],
  format: ['esm'],
  noExternal: ['@dynobox/runner-local', '@dynobox/evaluators'],
  platform: 'node',
  splitting: false,
});
