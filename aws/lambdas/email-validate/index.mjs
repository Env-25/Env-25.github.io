/**
 * Email validation proxy for the static site.
 * POST { email, turnstileToken } → { valid, message? }
 * Uses SES GetEmailAddressInsights + optional Turnstile siteverify.
 *
 * CORS is configured on the Function URL — do not set CORS headers here
 * (duplicates break browsers).
 */
import {
  SESv2Client,
  GetEmailAddressInsightsCommand,
} from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

/** Minimum IsValid confidence to accept: HIGH | MEDIUM | LOW */
const MIN_VALID = (process.env.MIN_VALID_VERDICT || "MEDIUM").toUpperCase();
const VERDICT_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function looksLikeEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn("TURNSTILE_SECRET_KEY unset — skipping CAPTCHA verification");
    return true;
  }
  if (!token || typeof token !== "string") return false;

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  );
  if (!res.ok) return false;
  const data = await res.json();
  return Boolean(data.success);
}

function meetsMinVerdict(verdict, min) {
  const got = VERDICT_RANK[String(verdict || "").toUpperCase()] || 0;
  const need = VERDICT_RANK[min] || VERDICT_RANK.MEDIUM;
  return got >= need;
}

function evaluateMailbox(mailbox) {
  const isValid = mailbox?.IsValid?.ConfidenceVerdict;
  const ev = mailbox?.Evaluations || {};

  if (!meetsMinVerdict(isValid, MIN_VALID)) {
    return {
      valid: false,
      message:
        "This email address does not appear to be deliverable. Please check for typos.",
    };
  }

  if (String(ev.HasValidSyntax?.ConfidenceVerdict).toUpperCase() === "LOW") {
    return {
      valid: false,
      message: "Please enter a valid email address.",
    };
  }

  if (String(ev.IsDisposable?.ConfidenceVerdict).toUpperCase() === "HIGH") {
    return {
      valid: false,
      message: "Disposable email addresses are not allowed. Please use a permanent email.",
    };
  }

  if (String(ev.IsRandomInput?.ConfidenceVerdict).toUpperCase() === "HIGH") {
    return {
      valid: false,
      message: "This email address does not appear to be valid.",
    };
  }

  return { valid: true };
}

export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method ||
    event?.httpMethod ||
    "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, body: "" };
  }

  if (method !== "POST") {
    return json(405, { valid: false, message: "Method not allowed" });
  }

  const body = parseBody(event);
  const email = String(body.email || "")
    .toLowerCase()
    .trim();
  const turnstileToken = body.turnstileToken || body.captchaToken;

  if (!looksLikeEmail(email)) {
    return json(200, {
      valid: false,
      message: "Please enter a valid email address.",
    });
  }

  const remoteIp =
    event?.requestContext?.http?.sourceIp ||
    event?.requestContext?.identity?.sourceIp ||
    undefined;

  try {
    const captchaOk = await verifyTurnstile(turnstileToken, remoteIp);
    if (!captchaOk) {
      return json(200, {
        valid: false,
        message: "CAPTCHA verification failed. Please refresh and try again.",
      });
    }

    const out = await ses.send(
      new GetEmailAddressInsightsCommand({ EmailAddress: email })
    );
    const result = evaluateMailbox(out.MailboxValidation);
    return json(200, result);
  } catch (err) {
    console.error("email-validate error:", err?.name, err?.message);
    return json(500, {
      valid: false,
      message:
        "Could not validate email. Please try again. If the problem persists, please contact us.",
    });
  }
};
