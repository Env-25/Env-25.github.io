/**
 * CHBE Hackathon API (Function URL).
 *
 * All write actions require a valid Cognito ID token (Bearer).
 *
 * GET  ?me=1                                   → current user's participant record (or null)
 * GET  ?status=1                               → { signupEnabled }
 * POST { action:"validate-partner", ... }      → check a first-year partner is eligible (no write)
 * POST { action:"register-first-year", ... }   → register a 2-person first-year team
 * POST { action:"register-upper-year", ... }   → register an upper-year participant
 *
 * CORS is configured on the Function URL — do not set CORS headers here.
 */
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.HACKATHON_TABLE || "hackathon-participants";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
/** FIFO email queue drained by the chbe-admin consumer (same queue orders/contact use). */
const EMAIL_QUEUE_URL = process.env.EMAIL_QUEUE_URL || "";
const SES_FROM =
  process.env.SES_FROM || "UBC CHBE Hackathon <hackathon@ubcchbecouncil.com>";
const SITE_URL = (process.env.SITE_URL || "https://ubcchbecouncil.com").replace(/\/$/, "");

/** Flip to false to close signups (page still loads, register calls are rejected). */
const SIGNUP_ENABLED = process.env.HACKATHON_SIGNUP_ENABLED !== "false";
/** Require a verified email before registering (matches the orders flow). */
const REQUIRE_VERIFIED_EMAIL = process.env.HACKATHON_REQUIRE_VERIFIED !== "false";

/** Reserved partition-key row that stores the incrementing team-number counter. */
const COUNTER_KEY = "__TEAM_COUNTER__";
/** First team number handed out. */
const TEAM_NUMBER_START = 1;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

const verifier =
  USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID,
      })
    : null;

const ACADEMIC_YEARS = ["2nd", "3rd", "4th", "5th", "other"];

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

function getBearer(event) {
  const h = event?.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

async function requireUser(event) {
  if (!verifier) {
    throw Object.assign(new Error("Auth is not configured on the server."), {
      status: 500,
    });
  }
  const token = getBearer(event);
  if (!token) {
    throw Object.assign(new Error("Sign in required."), { status: 401 });
  }
  try {
    const payload = await verifier.verify(token);
    return {
      sub: String(payload.sub || ""),
      email: String(payload.email || "").trim().toLowerCase(),
      name: String(payload.name || ""),
      emailVerified:
        payload.email_verified === true || payload.email_verified === "true",
    };
  } catch {
    throw Object.assign(
      new Error("Invalid or expired session. Sign in again."),
      { status: 401 }
    );
  }
}

function normalizeStudentNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits;
}

function looksLikeEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Registration confirmation email — matches the site's email template/branding. */
function buildRegistrationEmailHtml({ name, teamNumber }) {
  const participantUrl = `${SITE_URL}/hackathon/participant`;
  const contactUrl = `${SITE_URL}/contact?topic=hackathon`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>CHBE Hackathon registration</title>
</head>
<body style="margin:0;padding:0;background-color:#fdf9ef;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">You're registered for the CHBE Hackathon.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#fdf9ef;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border:1px solid rgba(58,75,74,0.15);">
          <tr>
            <td align="center" style="background-color:#3a4b4a;padding:28px 24px 24px;">
              <a href="${SITE_URL}" target="_blank" rel="noopener" style="text-decoration:none;">
                <img src="${SITE_URL}/logos/logo-text-white.png" alt="CHBE" width="168" style="display:block;width:168px;max-width:70%;height:auto;border:0;" />
              </a>
              <p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(253,249,239,0.65);">UBC CHBE Council</p>
            </td>
          </tr>
          <tr><td style="height:4px;background-color:#72a691;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:36px 32px 8px;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
              <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;line-height:1.25;color:#3a4b4a;">You're registered!</h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:rgba(58,75,74,0.8);">
                Hi ${escapeHtml(name || "there")}, you have registered for the <strong>CHBE Hackathon</strong>.
              </p>
              <p style="margin:0 0 6px;font-size:13px;color:rgba(58,75,74,0.65);">Your team number</p>
              <p style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#4a8550;">#${escapeHtml(String(teamNumber))}</p>
              <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:rgba(58,75,74,0.8);">
                You can access the hackathon participant page any time to view your team info and, later, submission instructions.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#3a4b4a;">
                    <a href="${participantUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#fdf9ef;text-decoration:none;">Open participant page</a>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:rgba(58,75,74,0.8);">
                Please keep an eye out for any announcements in your inbox.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f7f3e8;border-top:1px solid rgba(58,75,74,0.12);padding:20px 32px;">
              <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:rgba(58,75,74,0.65);">UBC Chemical &amp; Biological Engineering Student Council</p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;">
                Questions? <a href="${contactUrl}" target="_blank" rel="noopener" style="color:#4a8550;text-decoration:underline;">Contact us</a>
                · <a href="${SITE_URL}" target="_blank" rel="noopener" style="color:#4a8550;text-decoration:underline;">ubcchbecouncil.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Queue a confirmation email via the shared FIFO queue (drained by chbe-admin). */
async function sendRegistrationEmails(recipients, teamNumber) {
  if (!EMAIL_QUEUE_URL) {
    console.warn("EMAIL_QUEUE_URL unset — skipping registration emails.");
    return;
  }
  await Promise.all(
    recipients
      .filter((r) => looksLikeEmail(r?.email))
      .map(async (r) => {
        const job = {
          to: String(r.email).trim().toLowerCase(),
          subject: `You're registered — CHBE Hackathon (Team #${teamNumber})`,
          html: buildRegistrationEmailHtml({ name: r.name, teamNumber }),
          source: SES_FROM,
        };
        if (Buffer.byteLength(JSON.stringify(job), "utf8") > 250 * 1024) {
          console.error("Registration email job too large; skipping", job.to);
          return;
        }
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: EMAIL_QUEUE_URL,
            MessageBody: JSON.stringify(job),
            MessageGroupId: "ses",
            MessageDeduplicationId: randomUUID(),
          })
        );
      })
  );
}

/** Look up a confirmed Cognito user by email. Returns { sub, email, name } or null. */
async function findUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const result = await cognito.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      // Email is quoted to allow the exact-match filter.
      Filter: `email = "${normalized.replace(/"/g, '\\"')}"`,
      Limit: 5,
    })
  );
  const match = (result.Users || []).find((u) => {
    const attrs = Object.fromEntries(
      (u.Attributes || []).map((a) => [a.Name, a.Value])
    );
    return String(attrs.email || "").trim().toLowerCase() === normalized;
  });
  if (!match) return null;
  const attrs = Object.fromEntries(
    (match.Attributes || []).map((a) => [a.Name, a.Value])
  );
  return {
    sub: String(attrs.sub || match.Username || ""),
    email: String(attrs.email || normalized).trim().toLowerCase(),
    name: String(attrs.name || ""),
  };
}

async function getParticipant(userSub) {
  if (!userSub) return null;
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { userSub } })
  );
  return res.Item || null;
}

/** Atomically allocate the next incremental team number (shared across all teams). */
async function allocateTeamNumber() {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { userSub: COUNTER_KEY },
      UpdateExpression: "SET seq = if_not_exists(seq, :start) + :one",
      ExpressionAttributeValues: {
        ":start": TEAM_NUMBER_START - 1,
        ":one": 1,
      },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return Number(res.Attributes?.seq);
}

/** Public shape returned to the browser for a participant record. */
function publicParticipant(item) {
  if (!item) return null;
  return {
    teamNumber: Number(item.teamNumber),
    role: item.role,
    name: item.name || "",
    email: item.email || "",
    studentNumber: item.studentNumber || "",
    academicYear: item.academicYear || "",
    academicYearOther: item.academicYearOther || "",
    isTeamLead: item.isTeamLead === true,
    teammate: item.teammateSub
      ? {
          name: item.teammateName || "",
          email: item.teammateEmail || "",
          studentNumber: item.teammateStudentNumber || "",
        }
      : null,
    createdAt: item.createdAt || "",
  };
}

async function handleMe(user) {
  const item = await getParticipant(user.sub);
  return json(200, { participant: publicParticipant(item) });
}

/**
 * Shared first-year partner validation.
 * Returns { ok:true, partner } or { ok:false, status, error }.
 */
async function checkPartner(user, partnerEmail) {
  if (!looksLikeEmail(partnerEmail)) {
    return {
      ok: false,
      status: 400,
      error: "Please enter a valid email for your partner.",
    };
  }
  if (partnerEmail === user.email) {
    return {
      ok: false,
      status: 400,
      error: "You cannot list yourself as your own partner.",
    };
  }

  const partner = await findUserByEmail(partnerEmail);
  if (!partner || !partner.sub) {
    return {
      ok: false,
      status: 404,
      error:
        "Your partner needs to create a CHBE account with this email before you can add them to your team.",
    };
  }
  if (partner.sub === user.sub) {
    return {
      ok: false,
      status: 400,
      error: "You cannot list yourself as your own partner.",
    };
  }

  const partnerRecord = await getParticipant(partner.sub);
  if (partnerRecord) {
    return {
      ok: false,
      status: 409,
      error: `Your partner is already part of a team (team #${partnerRecord.teamNumber}).`,
    };
  }

  return { ok: true, partner };
}

async function handleValidatePartner(event, user) {
  const body = parseBody(event);
  const partnerEmail = String(body.partnerEmail || "").trim().toLowerCase();

  const existing = await getParticipant(user.sub);
  if (existing) {
    return json(409, {
      error: `You have already signed up (team #${existing.teamNumber}).`,
      code: "ALREADY_REGISTERED",
    });
  }

  const check = await checkPartner(user, partnerEmail);
  if (!check.ok) {
    return json(check.status, { error: check.error, code: "PARTNER_INVALID" });
  }
  return json(200, {
    ok: true,
    partner: { name: check.partner.name, email: check.partner.email },
  });
}

async function handleRegisterFirstYear(event, user) {
  if (!SIGNUP_ENABLED) {
    return json(503, {
      error: "Hackathon signups are currently closed.",
      code: "SIGNUP_CLOSED",
    });
  }
  if (REQUIRE_VERIFIED_EMAIL && !user.emailVerified) {
    return json(403, {
      error: "Please verify your email before signing up.",
      code: "EMAIL_UNVERIFIED",
    });
  }

  const body = parseBody(event);
  const studentNumber = normalizeStudentNumber(body.studentNumber);
  const partnerStudentNumber = normalizeStudentNumber(body.partnerStudentNumber);
  const partnerEmail = String(body.partnerEmail || "").trim().toLowerCase();

  if (studentNumber.length < 5 || studentNumber.length > 12) {
    return json(400, { error: "Please enter a valid student number." });
  }
  if (partnerStudentNumber.length < 5 || partnerStudentNumber.length > 12) {
    return json(400, { error: "Please enter a valid partner student number." });
  }

  const existing = await getParticipant(user.sub);
  if (existing) {
    return json(409, {
      error: `You have already signed up (team #${existing.teamNumber}).`,
      code: "ALREADY_REGISTERED",
    });
  }

  const check = await checkPartner(user, partnerEmail);
  if (!check.ok) {
    return json(check.status, { error: check.error, code: "PARTNER_INVALID" });
  }
  const partner = check.partner;

  const teamNumber = await allocateTeamNumber();
  const now = new Date().toISOString();

  const leadItem = {
    userSub: user.sub,
    teamNumber,
    role: "first-year",
    isTeamLead: true,
    name: user.name,
    email: user.email,
    studentNumber,
    teammateSub: partner.sub,
    teammateName: partner.name,
    teammateEmail: partner.email,
    teammateStudentNumber: partnerStudentNumber,
    createdAt: now,
    updatedAt: now,
  };
  const partnerItem = {
    userSub: partner.sub,
    teamNumber,
    role: "first-year",
    isTeamLead: false,
    addedByPartner: true,
    name: partner.name,
    email: partner.email,
    studentNumber: partnerStudentNumber,
    teammateSub: user.sub,
    teammateName: user.name,
    teammateEmail: user.email,
    teammateStudentNumber: studentNumber,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: leadItem,
              ConditionExpression: "attribute_not_exists(userSub)",
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: partnerItem,
              ConditionExpression: "attribute_not_exists(userSub)",
            },
          },
        ],
      })
    );
  } catch (err) {
    const msg = String(err?.name || err?.message || "");
    if (msg.includes("ConditionalCheckFailed") || msg.includes("TransactionCanceled")) {
      return json(409, {
        error:
          "Either you or your partner was just signed up to another team. Please refresh and try again.",
        code: "RACE_CONFLICT",
      });
    }
    console.error("First-year register failed", err);
    return json(500, { error: "Could not complete registration. Try again." });
  }

  try {
    await sendRegistrationEmails(
      [
        { email: user.email, name: user.name },
        { email: partner.email, name: partner.name },
      ],
      teamNumber
    );
  } catch (err) {
    console.error("First-year confirmation email failed", err);
  }

  return json(201, { ok: true, teamNumber, role: "first-year" });
}

async function handleRegisterUpperYear(event, user) {
  if (!SIGNUP_ENABLED) {
    return json(503, {
      error: "Hackathon signups are currently closed.",
      code: "SIGNUP_CLOSED",
    });
  }
  if (REQUIRE_VERIFIED_EMAIL && !user.emailVerified) {
    return json(403, {
      error: "Please verify your email before signing up.",
      code: "EMAIL_UNVERIFIED",
    });
  }

  const body = parseBody(event);
  const studentNumber = normalizeStudentNumber(body.studentNumber);
  const academicYear = String(body.academicYear || "").trim().toLowerCase();
  const academicYearOther = String(body.academicYearOther || "").trim().slice(0, 120);

  if (studentNumber.length < 5 || studentNumber.length > 12) {
    return json(400, { error: "Please enter a valid student number." });
  }
  if (!ACADEMIC_YEARS.includes(academicYear)) {
    return json(400, { error: "Please select your academic year." });
  }
  if (academicYear === "other" && !academicYearOther) {
    return json(400, { error: "Please describe your academic year." });
  }

  const existing = await getParticipant(user.sub);
  if (existing) {
    return json(409, {
      error: `You have already signed up (team #${existing.teamNumber}).`,
      code: "ALREADY_REGISTERED",
    });
  }

  const teamNumber = await allocateTeamNumber();
  const now = new Date().toISOString();

  const item = {
    userSub: user.sub,
    teamNumber,
    role: "upper-year",
    isTeamLead: true,
    name: user.name,
    email: user.email,
    studentNumber,
    academicYear,
    academicYearOther: academicYear === "other" ? academicYearOther : "",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(userSub)",
      })
    );
  } catch (err) {
    const msg = String(err?.name || err?.message || "");
    if (msg.includes("ConditionalCheckFailed")) {
      return json(409, {
        error: "You have already signed up.",
        code: "ALREADY_REGISTERED",
      });
    }
    console.error("Upper-year register failed", err);
    return json(500, { error: "Could not complete registration. Try again." });
  }

  try {
    await sendRegistrationEmails([{ email: user.email, name: user.name }], teamNumber);
  } catch (err) {
    console.error("Upper-year confirmation email failed", err);
  }

  return json(201, { ok: true, teamNumber, role: "upper-year" });
}

export async function handler(event) {
  try {
    const method = (
      event?.requestContext?.http?.method ||
      event?.httpMethod ||
      "GET"
    ).toUpperCase();

    if (method === "OPTIONS") return json(204, {});

    const qs = event.queryStringParameters || {};

    if (method === "GET" && (qs.status === "1" || qs.status === "true")) {
      return json(200, { signupEnabled: SIGNUP_ENABLED });
    }

    if (method === "GET" && (qs.me === "1" || qs.me === "true")) {
      const user = await requireUser(event);
      return await handleMe(user);
    }

    if (method === "POST") {
      const user = await requireUser(event);
      const body = parseBody(event);
      const action = String(body.action || "").toLowerCase();
      if (action === "validate-partner")
        return await handleValidatePartner(event, user);
      if (action === "register-first-year")
        return await handleRegisterFirstYear(event, user);
      if (action === "register-upper-year")
        return await handleRegisterUpperYear(event, user);
      return json(400, { error: "Unknown action." });
    }

    return json(405, { error: "Method not allowed." });
  } catch (err) {
    const status = err?.status || 500;
    console.error(err);
    return json(status, { error: err?.message || "Server error." });
  }
}
