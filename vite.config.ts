import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { deny: ['**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/data/**', '**/*.sqlite*'] },
  },
  build: { outDir: 'dist/web' },
});
