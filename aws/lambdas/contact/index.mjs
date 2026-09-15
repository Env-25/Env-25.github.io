/**
 * CHBE contact form API (Function URL).
 * POST { inquiryType, name, email, subject, message, turnstileToken }
 * → verify Turnstile → enqueue SES email via SQS FIFO queue.
 *
 * CORS is configured on the Function URL — do not set CORS headers here.
 */
import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const REGION = process.env.AWS_REGION || "us-east-2";
const EMAIL_QUEUE_URL = process.env.EMAIL_QUEUE_URL || "";
const SES_FROM =
  process.env.SES_FROM || "UBC CHBE Support <support@ubcchbecouncil.com>";
const SITE_URL = (process.env.SITE_URL || "https://ubcchbecouncil.com").replace(/\/$/, "");

const INQUIRY_EMAIL = {
  general: "chbevpinternal@gmail.com",
  merch: "communications@chbecouncil.com",
  academic: "chbeacademics@chbecouncil.com",
  "2nd-year": "2ndyearrep@chbecouncil.com",
  "3rd-year": "3rdyearrep@chbecouncil.com",
  "4th-year": "4thyearrep@chbecouncil.com",
  sponsorship: "ubcenvision@gmail.com",
};

const INQUIRY_LABEL = {
  general: "General Inquiries / Lockers / Other",
  merch: "Merch & Orders",
  academic: "Academic Support",
  "2nd-year": "2nd Year Representative",
  "3rd-year": "3rd Year Representative",
  "4th-year": "4th Year Representative",
  sponsorship: "Sponsorship",
};

const sqs = new SQSClient({ region: REGION });

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function looksLikeEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clampText(value, max) {
  return String(value || "").trim().slice(0, max);
}

async function verifyTurnstile(token, remoteIp, event) {
  const secrets = [process.env.TURNSTILE_SECRET_KEY].filter(Boolean);
  const origin = String(
    event?.headers?.origin ||
      event?.headers?.Origin ||
      event?.headers?.referer ||
      event?.headers?.Referer ||
      ""
  );
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(origin) ||
    String(remoteIp || "") === "127.0.0.1";
  // Cloudflare always-pass secret — only accepted for local origins so prod stays locked down.
  if (isLocal) secrets.push("1x0000000000000000000000000000000AA");

  if (!secrets.length) {
    console.warn("TURNSTILE_SECRET_KEY unset — skipping CAPTCHA verification");
    return true;
  }
  if (!token || typeof token !== "string") return false;

  for (const secret of secrets) {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.success) return true;
  }
  return false;
}

function buildStaffHtml({ inquiryType, name, email, subject, message }) {
  const label = INQUIRY_LABEL[inquiryType] || inquiryType;
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>");
  return `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:24px;background:#fdf9ef;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
  <h1 style="font-family:Georgia,serif;font-size:22px;">New contact form message</h1>
  <p><strong>Inquiry:</strong> ${escapeHtml(label)}<br/>
     <strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br/>
     <strong>Subject:</strong> ${escapeHtml(subject)}</p>
  <div style="margin-top:16px;padding:16px;background:#fff;border:1px solid rgba(58,75,74,0.15);line-height:1.6;">
    ${safeMessage}
  </div>
  <p style="margin-top:18px;font-size:13px;color:rgba(58,75,74,0.7);">
    Reply directly to this email to respond to ${escapeHtml(name)}.
  </p>
  <p style="font-size:12px;"><a href="${SITE_URL}/contact" style="color:#4a8550;">ubcchbecouncil.com/contact</a></p>
</body></html>`;
}

function buildConfirmHtml({ name, subject }) {
  return `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:24px;background:#fdf9ef;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
  <h1 style="font-family:Georgia,serif;font-size:22px;">We received your message</h1>
  <p>Hi ${escapeHtml(name || "there")},</p>
  <p>Thanks for contacting UBC CHBE Council. We received your message about <strong>${escapeHtml(subject)}</strong> and will get back to you soon.</p>
  <p style="font-size:13px;color:rgba(58,75,74,0.7);">
    If you need to reach us sooner, use the emails listed on
    <a href="${SITE_URL}/contact" style="color:#4a8550;">our contact page</a>.
  </p>
</body></html>`;
}

async function enqueueEmail(job) {
  if (!EMAIL_QUEUE_URL) throw new Error("The email queue is not configured.");
  const payload = {
    to: String(job.to || "").trim().toLowerCase(),
    subject: String(job.subject || "").trim(),
    html: String(job.html || ""),
    source: job.source || SES_FROM,
    replyTo: job.replyTo ? String(job.replyTo).trim().toLowerCase() : undefined,
  };
  if (!payload.to || !payload.subject || !payload.html) {
    throw new Error("Invalid email job.");
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 250 * 1024) {
    throw new Error("Message is too large to send.");
  }
  await sqs.send(new SendMessageCommand({
    QueueUrl: EMAIL_QUEUE_URL,
    MessageBody: JSON.stringify(payload),
    MessageGroupId: "ses",
    MessageDeduplicationId: randomUUID(),
  }));
}

export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method ||
    event?.httpMethod ||
    "POST";

  if (method === "OPTIONS") return { statusCode: 204, body: "" };
  if (method !== "POST") return json(405, { error: "Method not allowed." });

  const body = parseBody(event);
  const inquiryType = String(body.inquiryType || body.inquiry_type || "").trim();
  const name = clampText(body.name || body.from_name, 120);
  const email = clampText(body.email || body.from_email, 200).toLowerCase();
  const subject = clampText(body.subject, 200);
  const message = clampText(body.message, 5000);
  const turnstileToken = body.turnstileToken || body.captchaToken || "";

  const to = INQUIRY_EMAIL[inquiryType];
  if (!to) return json(400, { error: "Please select a type of inquiry." });
  if (!name) return json(400, { error: "Please enter your name." });
  if (!looksLikeEmail(email)) return json(400, { error: "Please enter a valid email address." });
  if (!subject) return json(400, { error: "Please enter a subject." });
  if (!message) return json(400, { error: "Please enter a message." });

  const remoteIp =
    event?.requestContext?.http?.sourceIp ||
    event?.requestContext?.identity?.sourceIp ||
    undefined;

  try {
    const captchaOk = await verifyTurnstile(turnstileToken, remoteIp, event);
    if (!captchaOk) {
      return json(403, {
        error: "CAPTCHA verification failed. Please refresh and try again.",
        code: "CAPTCHA_FAILED",
      });
    }

    const label = INQUIRY_LABEL[inquiryType] || inquiryType;
    await enqueueEmail({
      to,
      subject: `[CHBE Contact] ${subject}`,
      html: buildStaffHtml({ inquiryType, name, email, subject, message }),
      source: SES_FROM,
      replyTo: email,
    });

    try {
      await enqueueEmail({
        to: email,
        subject: `We received your message — ${subject}`,
        html: buildConfirmHtml({ name, subject }),
        source: SES_FROM,
      });
    } catch (confirmErr) {
      console.error("Contact confirmation email failed", confirmErr);
    }

    return json(200, { ok: true, inquiry: label });
  } catch (err) {
    console.error("contact error:", err?.name, err?.message);
    return json(500, {
      error: "Could not send your message. Please try again or email us directly.",
    });
  }
};
