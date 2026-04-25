import {defineConfig, http} from '@dynobox/sdk';

export default defineConfig({
  name: 'npm-package-research',
  endpoints: {
    getPrettierMetadata: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/prettier',
    }),
    getTypescriptMetadata: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/typescript',
    }),
    getLeftPadMetadata: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/left-pad',
    }),
  },
  scenarios: [
    {
      name: 'lookup package metadata',
      prompt:
        'Find the latest published version of the npm package prettier and tell me its license.',
      assertions: [http.called('getPrettierMetadata', {status: 200})],
    },
    {
      name: 'avoid unrelated lookup',
      prompt:
        'Find the latest published version of prettier. Do not look up unrelated packages.',
      assertions: [http.notCalled('getLeftPadMetadata')],
    },
    {
      name: 'compare two packages',
      prompt: 'Compare the latest versions of prettier and typescript.',
      assertions: [
        http.called('getPrettierMetadata', {status: 200}),
        http.called('getTypescriptMetadata', {status: 200}),
      ],
    },
  ],
});
