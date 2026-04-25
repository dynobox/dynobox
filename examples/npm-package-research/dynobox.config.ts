import {defineConfig, http} from '@dynobox/sdk';

export default defineConfig({
  endpoints: {
    npm: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/prettier',
    }),
  },
  scenarios: [
    {
      name: 'lookup prettier',
      prompt: 'Find the latest prettier version.',
      assertions: [http.called('npm', {status: 200})],
    },
  ],
});
