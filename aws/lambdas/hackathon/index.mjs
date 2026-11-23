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
import { CognitoJwtVerifier } from "aws-jwt-verify";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.HACKATHON_TABLE || "hackathon-participants";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";

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
