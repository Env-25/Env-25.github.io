import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ubcchbecouncil.com',
  redirects: {
    '/sign-in': '/account/sign-in',
    '/sign-up': '/account/sign-up',
    '/verify-email': '/account/verify-email',
    '/complete-profile': '/account/complete-profile',
    '/profile': '/account/profile',
    '/orders': '/account/orders',
    '/subscriptions': '/account/subscriptions',
    '/admin': '/account/admin',
  },
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
