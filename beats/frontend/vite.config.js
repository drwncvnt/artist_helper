import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Served behind the gateway under /beats/, so built asset URLs are prefixed.
  base: '/beats/',
  plugins: [react()],
});
