import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ubcchbecouncil.com',
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
        'ubcchbecouncil.com',
        'env-25.github.io',
      ]
    }
  }
});
