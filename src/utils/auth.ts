/**
 * Cognito auth helpers (Amplify Auth v6).
 * Requires PUBLIC_COGNITO_USER_POOL_ID and PUBLIC_COGNITO_CLIENT_ID.
 */
import { Amplify } from "aws-amplify";
import {
  signUp,
  signIn,
  signOut,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
  getCurrentUser,
  fetchAuthSession,
  fetchUserAttributes,
  updateUserAttributes,
  sendUserAttributeVerificationCode,
  confirmUserAttribute,
  autoSignIn,
} from "aws-amplify/auth";
import { AUTH_CONFIG, isAuthConfigured } from "./auth-config";

let configured = false;

export function ensureAmplify(): void {
  if (configured) return;
  if (!isAuthConfigured()) {
    throw new Error(
      "Cognito is not configured. Set PUBLIC_COGNITO_USER_POOL_ID and PUBLIC_COGNITO_CLIENT_ID."
    );
  }
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: AUTH_CONFIG.userPoolId!,
        userPoolClientId: AUTH_CONFIG.userPoolClientId!,
      },
    },
  });
  configured = true;
}

export type UserProfile = {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
  studentNumber: string;
  enrollmentYear: string;
  department: string;
  profileComplete: boolean;
  subImportant: boolean;
  subGeneral: boolean;
  subEvents: boolean;
  emailChangedAt: string;
  isAdmin: boolean;
};

function attr(attrs: Record<string, string>, key: string, fallback = ""): string {
  return attrs[key] ?? attrs[`custom:${key}`] ?? fallback;
}

function asBool(v: string | undefined, fallback = false): boolean {
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1";
}

export async function getSessionProfile(options?: {
  forceRefresh?: boolean;
}): Promise<UserProfile | null> {
  ensureAmplify();
  try {
    const user = await getCurrentUser();
    const [attrs, session] = await Promise.all([
      fetchUserAttributes(),
      fetchAuthSession({ forceRefresh: options?.forceRefresh === true }),
    ]);
    const accessGroups =
      (session.tokens?.accessToken?.payload["cognito:groups"] as string[] | undefined) ??
      [];
    const idGroups =
      (session.tokens?.idToken?.payload["cognito:groups"] as string[] | undefined) ??
      [];
    const groups = [...new Set([...accessGroups, ...idGroups])];
    const record = attrs as Record<string, string>;

    return {
      sub: user.userId,
      email: record.email ?? "",
      name: record.name ?? "",
      emailVerified: asBool(record.email_verified),
      studentNumber: attr(record, "student_number"),
      enrollmentYear: attr(record, "enrollment_year"),
      department: attr(record, "department"),
      profileComplete: asBool(attr(record, "profile_complete")),
      subImportant: asBool(attr(record, "sub_important"), true),
      subGeneral: asBool(attr(record, "sub_general"), true),
      subEvents: asBool(attr(record, "sub_events"), true),
      emailChangedAt: attr(record, "email_changed_at"),
      isAdmin: groups.includes(AUTH_CONFIG.adminGroup),
    };
  } catch {
    return null;
  }
}

export function firstName(fullName: string): string {
  const part = fullName.trim().split(/\s+/)[0];
  return part || "Account";
}

export type SignUpInput = {
  name: string;
  email: string;
  password: string;
};

export async function registerUser(input: SignUpInput) {
  ensureAmplify();
  // Standard Cognito flow: user must confirm with the emailed code before signing in.
  return signUp({
    username: input.email.toLowerCase().trim(),
    password: input.password,
    options: {
      userAttributes: {
        email: input.email.toLowerCase().trim(),
        name: input.name.trim(),
        "custom:profile_complete": "false",
        "custom:sub_important": "true",
        "custom:sub_general": "true",
        "custom:sub_events": "true",
      },
      autoSignIn: true,
    },
  });
}

export async function confirmRegistration(email: string, code: string) {
  ensureAmplify();
  const username = email.toLowerCase().trim();
  const result = await confirmSignUp({
    username,
    confirmationCode: code.trim(),
  });

  // Prefer Amplify autoSignIn (works when signup used autoSignIn: true in this browser)
  try {
    await autoSignIn();
  } catch {
    /* fall through to password from this verify session */
  }

  let profile = await getSessionProfile();
  if (!profile) {
    const password = takePendingPassword();
    if (password) {
      try {
        await signIn({ username, password });
      } catch (err) {
        if ((err as { name?: string }).name === "UserAlreadyAuthenticatedException") {
          await signOut();
          await signIn({ username, password });
        } else {
          throw err;
        }
      }
      profile = await getSessionProfile();
    }
  }

  if (!profile) {
    const err = new Error(
      "Email verified, but automatic sign-in failed. Please sign in to continue."
    );
    err.name = "AutoSignInFailed";
    throw err;
  }

  return result;
}

/**
 * Verify email for either:
 * - Unconfirmed signup (confirmSignUp), or
 * - Auto-confirmed user with email_verified=false (confirmUserAttribute)
 */
export async function verifyEmailCode(email: string, code: string) {
  ensureAmplify();
  try {
    const session = await getSessionProfile();
    if (session && !session.emailVerified) {
      await confirmUserAttribute({
        userAttributeKey: "email",
        confirmationCode: code.trim(),
      });
      return { mode: "attribute" as const };
    }
  } catch {
    /* fall through to signup confirmation */
  }

  await confirmRegistration(email, code);
  return { mode: "signup" as const };
}

export async function resendConfirmation(email: string) {
  ensureAmplify();
  try {
    const session = await getSessionProfile();
    if (session) {
      await sendUserAttributeVerificationCode({ userAttributeKey: "email" });
      return { mode: "attribute" as const };
    }
  } catch {
    /* not signed in — use signup resend */
  }
  await resendSignUpCode({ username: email.toLowerCase().trim() });
  return { mode: "signup" as const };
}

/** Send a Cognito forgot-password code to the email. */
export async function requestPasswordReset(email: string) {
  ensureAmplify();
  return resetPassword({ username: email.toLowerCase().trim() });
}

/** Confirm forgot-password with code + new password. */
export async function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string
) {
  ensureAmplify();
  return confirmResetPassword({
    username: email.toLowerCase().trim(),
    confirmationCode: code.trim(),
    newPassword,
  });
}

export async function loginUser(email: string, password: string) {
  ensureAmplify();
  const username = email.toLowerCase().trim();
  try {
    const result = await signIn({ username, password });
    // Amplify v6 often returns this instead of throwing for unconfirmed users
    if (result.nextStep?.signInStep === "CONFIRM_SIGN_UP") {
      const err = new Error("User is not confirmed.");
      err.name = "UserNotConfirmedException";
      throw err;
    }
    return result;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "UserAlreadyAuthenticatedException") {
      await signOut();
      const result = await signIn({ username, password });
      if (result.nextStep?.signInStep === "CONFIRM_SIGN_UP") {
        const e = new Error("User is not confirmed.");
        e.name = "UserNotConfirmedException";
        throw e;
      }
      return result;
    }
    throw err;
  }
}

export async function logoutUser() {
  ensureAmplify();
  await signOut();
}

export async function saveSubscriptionPrefs(prefs: {
  important: boolean;
  general: boolean;
  events: boolean;
}) {
  ensureAmplify();
  await updateUserAttributes({
    userAttributes: {
      "custom:sub_important": String(prefs.important),
      "custom:sub_general": String(prefs.general),
      "custom:sub_events": String(prefs.events),
    },
  });
}

export async function saveProfileDetails(details: {
  name?: string;
  studentNumber: string;
  enrollmentYear: string;
  department: string;
  complete: boolean;
}) {
  ensureAmplify();
  const userAttributes: Record<string, string> = {
    "custom:student_number": details.studentNumber.trim(),
    "custom:enrollment_year": details.enrollmentYear.trim(),
    "custom:department": details.department.trim(),
    "custom:profile_complete": String(details.complete),
  };
  if (details.name?.trim()) {
    userAttributes.name = details.name.trim();
  }
  await updateUserAttributes({ userAttributes });
}

export async function requestEmailChange(newEmail: string) {
  ensureAmplify();
  await updateUserAttributes({
    userAttributes: {
      email: newEmail.toLowerCase().trim(),
      "custom:email_changed_at": new Date().toISOString(),
    },
  });
}

export async function sendEmailVerificationCode() {
  ensureAmplify();
  return sendUserAttributeVerificationCode({ userAttributeKey: "email" });
}

export async function confirmEmailVerification(code: string) {
  ensureAmplify();
  return confirmUserAttribute({
    userAttributeKey: "email",
    confirmationCode: code.trim(),
  });
}

/** Client-side resend cooldown helpers */
const RESEND_KEY = "chbe_resend_email_at";

export function getResendRemainingSec(): number {
  const raw = localStorage.getItem(RESEND_KEY);
  if (!raw) return 0;
  const elapsed = (Date.now() - Number(raw)) / 1000;
  return Math.max(0, Math.ceil(AUTH_CONFIG.resendCooldownSec - elapsed));
}

export function markResendSent(): void {
  localStorage.setItem(RESEND_KEY, String(Date.now()));
}

export function canChangeEmail(emailChangedAt: string): {
  allowed: boolean;
  daysLeft: number;
} {
  if (!emailChangedAt) return { allowed: true, daysLeft: 0 };
  const changed = new Date(emailChangedAt).getTime();
  if (Number.isNaN(changed)) return { allowed: true, daysLeft: 0 };
  const ms = AUTH_CONFIG.emailChangeCooldownDays * 24 * 60 * 60 * 1000;
  const remaining = changed + ms - Date.now();
  if (remaining <= 0) return { allowed: true, daysLeft: 0 };
  return { allowed: false, daysLeft: Math.ceil(remaining / (24 * 60 * 60 * 1000)) };
}

/**
 * Optional deliverability check via your SES Email Validation proxy
 * (GetEmailAddressInsights). Returns ok if valid or if no URL is configured.
 */
export async function validateEmailRemote(
  email: string,
  turnstileToken?: string | null
): Promise<{
  ok: boolean;
  message?: string;
}> {
  const url = AUTH_CONFIG.emailValidateUrl;
  if (!url) return { ok: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    });
    if (!res.ok) {
      return { ok: false, message: "Could not validate email. Please try again. If the problem persists, please contact us." };
    }
    const data = (await res.json()) as { valid?: boolean; message?: string };
    if (data.valid === false) {
      return {
        ok: false,
        message: data.message || "This email address does not appear to be valid.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not validate email. Please try again. If the problem persists, please contact us." };
  }
}

export function cognitoErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string };
  const name = e?.name || e?.code || "";
  switch (name) {
    case "AutoSignInFailed":
      return "Email verified. Please sign in to continue.";
    case "UsernameExistsException":
      return "An account with this email already exists. Sign in instead — if you never verified, sign in with your password to finish verification.";
    case "UserNotFoundException":
      return "No account found with this email.";
    case "NotAuthorizedException":
      if (/secret hash/i.test(e.message || "")) {
        return "This Cognito app client has a client secret. Create a new app client with “Generate client secret” turned OFF, then update PUBLIC_COGNITO_CLIENT_ID.";
      }
      return e.message || "Incorrect email or password.";
    case "UserNotConfirmedException":
      return "Please verify your email before signing in.";
    case "CodeMismatchException":
      return "Invalid verification code. Please try again.";
    case "ExpiredCodeException":
      return "This code has expired. Request a new one.";
    case "LimitExceededException":
    case "TooManyRequestsException":
      return "Too many attempts. Please wait a moment and try again.";
    case "InvalidPasswordException":
      return "Password does not meet requirements.";
    case "InvalidParameterException":
      return e.message || "Invalid input. Please check your details.";
    default:
      // Surface Cognito's real message so misconfig is visible during setup
      return e?.message || name || "Something went wrong. Please try again.";
  }
}

/** Pending signup email stored between pages */
const PENDING_EMAIL_KEY = "chbe_pending_email";
const PENDING_NAME_KEY = "chbe_pending_name";
/** Cognito username for the unverified signup (usually the original email). */
const PENDING_USERNAME_KEY = "chbe_pending_username";
const VERIFY_GATE_KEY = "chbe_verify_gate";
/** Session-only password so confirmSignUp can auto sign-in after refresh-safe verify. Cleared after use. */
const PENDING_PASSWORD_KEY = "chbe_pending_pw";
const VERIFY_GATE_TTL_MS = 2 * 60 * 60 * 1000;

export function setPendingSignup(email: string, name: string, cognitoUsername?: string) {
  const normalized = email.toLowerCase().trim();
  sessionStorage.setItem(PENDING_EMAIL_KEY, normalized);
  sessionStorage.setItem(PENDING_NAME_KEY, name.trim());
  sessionStorage.setItem(
    PENDING_USERNAME_KEY,
    (cognitoUsername || normalized).toLowerCase().trim()
  );
}

export function getPendingSignup(): {
  email: string;
  name: string;
  cognitoUsername: string;
} | null {
  const email = sessionStorage.getItem(PENDING_EMAIL_KEY);
  if (!email) return null;
  return {
    email,
    name: sessionStorage.getItem(PENDING_NAME_KEY) || "",
    cognitoUsername:
      sessionStorage.getItem(PENDING_USERNAME_KEY) || email,
  };
}

export function clearPendingSignup() {
  sessionStorage.removeItem(PENDING_EMAIL_KEY);
  sessionStorage.removeItem(PENDING_NAME_KEY);
  sessionStorage.removeItem(PENDING_USERNAME_KEY);
  sessionStorage.removeItem(VERIFY_GATE_KEY);
  sessionStorage.removeItem(PENDING_PASSWORD_KEY);
}

function takePendingPassword(): string | null {
  const password = sessionStorage.getItem(PENDING_PASSWORD_KEY);
  sessionStorage.removeItem(PENDING_PASSWORD_KEY);
  return password;
}

/** Only call after a successful signup or password-proven unconfirmed sign-in. */
export function grantVerifyAccess(
  email: string,
  name: string,
  cognitoUsername?: string,
  password?: string
) {
  setPendingSignup(email, name, cognitoUsername);
  sessionStorage.setItem(
    VERIFY_GATE_KEY,
    JSON.stringify({
      t: Date.now(),
      e: email.toLowerCase().trim(),
    })
  );
  if (password) {
    sessionStorage.setItem(PENDING_PASSWORD_KEY, password);
  }
}

/** True if this browser was granted verify access for the pending email. */
export function hasVerifyAccess(): boolean {
  const pending = getPendingSignup();
  const raw = sessionStorage.getItem(VERIFY_GATE_KEY);
  if (!pending?.email || !raw) return false;
  try {
    const gate = JSON.parse(raw) as { t?: number; e?: string };
    if (!gate.t || !gate.e) return false;
    if (gate.e !== pending.email.toLowerCase().trim()) return false;
    if (Date.now() - gate.t > VERIFY_GATE_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Fix a mistyped signup email. Cognito usernames cannot be renamed when email
 * is the username, so we create/resend against the corrected address.
 * Requires the account password. Never resends for an existing email without
 * proving password ownership first.
 */
export async function correctSignupEmail(input: {
  newEmail: string;
  password: string;
  name: string;
  previousUsername: string;
}) {
  ensureAmplify();
  const newEmail = input.newEmail.toLowerCase().trim();
  const previous = input.previousUsername.toLowerCase().trim();

  if (newEmail === previous) {
    await resendSignUpCode({ username: newEmail });
    grantVerifyAccess(newEmail, input.name, newEmail, input.password);
    return { mode: "resend" as const };
  }

  try {
    await signUp({
      username: newEmail,
      password: input.password,
      options: {
        userAttributes: {
          email: newEmail,
          name: input.name.trim() || "Member",
          "custom:profile_complete": "false",
          "custom:sub_important": "true",
          "custom:sub_general": "true",
          "custom:sub_events": "true",
        },
        autoSignIn: true,
      },
    });
    grantVerifyAccess(newEmail, input.name, newEmail, input.password);
    return { mode: "created" as const };
  } catch (err) {
    if ((err as { name?: string }).name !== "UsernameExistsException") throw err;
  }

  // Email already in pool — only continue if this password owns that unconfirmed account
  try {
    const result = await signIn({
      username: newEmail,
      password: input.password,
    });
    if (result.nextStep?.signInStep === "CONFIRM_SIGN_UP") {
      try {
        await resendSignUpCode({ username: newEmail });
      } catch {
        /* code may already be valid */
      }
      try {
        await signOut();
      } catch {
        /* ignore */
      }
      grantVerifyAccess(newEmail, input.name, newEmail, input.password);
      return { mode: "resend_owned" as const };
    }
    try {
      await signOut();
    } catch {
      /* ignore */
    }
    const exists = new Error(
      "An account with this email already exists and is verified. Sign in instead."
    );
    exists.name = "UsernameExistsException";
    throw exists;
  } catch (signInErr) {
    const name = (signInErr as { name?: string }).name;
    if (name === "UserNotConfirmedException") {
      try {
        await resendSignUpCode({ username: newEmail });
      } catch {
        /* ignore */
      }
      grantVerifyAccess(newEmail, input.name, newEmail, input.password);
      return { mode: "resend_owned" as const };
    }
    if (name === "UsernameExistsException") throw signInErr;
    if (name === "NotAuthorizedException") {
      const bad = new Error(
        "That email is already registered. Check the password, or sign in if it’s your account."
      );
      bad.name = "NotAuthorizedException";
      throw bad;
    }
    throw signInErr;
  }
}
