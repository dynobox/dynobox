import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  envPrefix: ['VITE_', 'API_BASE_URL'],
  plugins: [react()],
  test: {
    environment: 'jsdom',
  },
});
