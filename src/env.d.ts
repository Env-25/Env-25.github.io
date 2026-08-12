/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_COGNITO_USER_POOL_ID?: string;
  readonly PUBLIC_COGNITO_CLIENT_ID?: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  readonly PUBLIC_EMAIL_VALIDATE_URL?: string;
  readonly PUBLIC_ORDERS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
