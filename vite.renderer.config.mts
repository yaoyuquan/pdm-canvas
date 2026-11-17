import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  // Bind IPv4 explicitly: on some Windows setups `localhost` resolves to ::1 only,
  // and Electron fails to load the dev server.
  server: { host: '127.0.0.1' },
});
