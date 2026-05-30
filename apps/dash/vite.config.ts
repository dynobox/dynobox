import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  envPrefix: ['PUBLIC_', 'API_BASE_URL'],
  plugins: [react()],
});
