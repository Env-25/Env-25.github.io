/**
 * Internal / testing email validation proxy.
 * - Skips Turnstile (use Cloudflare always-pass site keys on the site)
 * - Still validates emails with SES GetEmailAddressInsights
 *
 * CORS is configured on the Function URL — do not set CORS headers here.
 */
import {
  SESv2Client,
  GetEmailAddressInsightsCommand,
} from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

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
      message:
        "Disposable email addresses are not allowed. Please use a permanent email.",
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

  if (!looksLikeEmail(email)) {
    return json(200, {
      valid: false,
      message: "Please enter a valid email address.",
    });
  }

  try {
    const out = await ses.send(
      new GetEmailAddressInsightsCommand({ EmailAddress: email })
    );
    return json(200, evaluateMailbox(out.MailboxValidation));
  } catch (err) {
    console.error("email-validate-test error:", err?.name, err?.message);
    return json(500, {
      valid: false,
      message:
        "Could not validate email. Please try again. If the problem persists, please contact us.",
    });
  }
};
