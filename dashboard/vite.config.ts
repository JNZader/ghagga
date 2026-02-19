import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// GitHub Pages base path: set VITE_BASE_PATH to match your repo name
// e.g., VITE_BASE_PATH=/my-repo/ npm run build
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/ghagga/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
