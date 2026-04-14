import { defineConfig } from 'astro/config';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3001,
  },
  vite: {
    server: {
      hmr: {
        host: '0.0.0.0',
      },
      allowedHosts: [
        'elwood-unimagined-tasha.ngrok-free.dev',
        'localhost',
        'chbe-site.akshajs.org',
      ]
    }
  }
});
