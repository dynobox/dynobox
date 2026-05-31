import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  envPrefix: ['VITE_', 'API_BASE_URL'],
  plugins: [react()],
});
