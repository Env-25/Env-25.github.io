/**
 * Cognito Pre sign-up trigger.
 * Auto-confirms the account so users can sign in with "verify later",
 * but does NOT auto-verify email (email_verified stays false until they enter the code).
 */
export const handler = async (event) => {
  event.response.autoConfirmUser = true;
  // Leave autoVerifyEmail unset/false so Cognito still requires email verification.
  event.response.autoVerifyEmail = false;
  return event;
};
