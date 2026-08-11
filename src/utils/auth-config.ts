/** Public Cognito / Turnstile config (safe for the browser). */

export const AUTH_CONFIG = {
  userPoolId: import.meta.env.PUBLIC_COGNITO_USER_POOL_ID as string | undefined,
  userPoolClientId: import.meta.env.PUBLIC_COGNITO_CLIENT_ID as string | undefined,
  /** Cognito group name for website superusers */
  adminGroup: "superusers",
  /** Cloudflare Turnstile site key (same as contact page) */
  turnstileSiteKey:
    (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined) ||
    "1x00000000000000000000AA",
  /** Optional: API URL that wraps SES GetEmailAddressInsights (keeps AWS creds off the browser) */
  emailValidateUrl: import.meta.env.PUBLIC_EMAIL_VALIDATE_URL as string | undefined,
  resendCooldownSec: 60,
  emailChangeCooldownDays: 7,
};

export function isAuthConfigured(): boolean {
  return Boolean(AUTH_CONFIG.userPoolId && AUTH_CONFIG.userPoolClientId);
}
