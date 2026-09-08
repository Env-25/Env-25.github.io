import { createSign, randomUUID } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListGroupsCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import sanitizeHtml from "sanitize-html";

const REGION = process.env.AWS_REGION || "us-east-2";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
const INVENTORY_TABLE = process.env.INVENTORY_TABLE || "inventory";
const LOCKER_CHANGES_TABLE = process.env.LOCKER_CHANGES_TABLE || "locker-changes";
const ADMIN_AUDIT_TABLE = process.env.ADMIN_AUDIT_TABLE || "admin-audit";
const SES_FROM = process.env.SES_FROM || "notifications@ubcchbecouncil.com";
const SITE_URL = (process.env.SITE_URL || "https://ubcchbecouncil.com").replace(/\/$/, "");
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_PRIVATE_KEY_SECRET_ID = process.env.GITHUB_PRIVATE_KEY_SECRET_ID || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ses = new SESClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_ID })
  : null;

const WORKSPACES = {
  lockers: { group: "lockers", path: "public/lockers/lockers.csv", kind: "locker" },
  merch: { group: "merch", path: "public/merch/merch.csv", kind: "merch" },
  events: { group: "events", path: "public/events/events.csv" },
  members: { group: "members" },
  resources: { group: "resources", path: "public/resources/resources.csv" },
};
const ADMIN_GROUPS = ["superusers", "merch", "lockers", "notifications", "members", "events", "resources", "admin"];
const FILE_LIMIT_BYTES = 5 * 1024 * 1024;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function getBearer(event) {
  const headers = event?.headers || {};
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

async function requireUser(event) {
  if (!verifier) throw Object.assign(new Error("Admin API authentication is not configured."), { status: 500 });
  const token = getBearer(event);
  if (!token) throw Object.assign(new Error("Sign in required."), { status: 401 });
  try {
    const payload = await verifier.verify(token);
    const rawGroups = payload["cognito:groups"];
    const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    if (!groups.includes("superusers")) {
      throw Object.assign(new Error("Admin console access is required."), { status: 403 });
    }
    return {
      sub: String(payload.sub || ""),
      email: String(payload.email || ""),
      name: String(payload.name || ""),
      groups,
    };
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error("Invalid or expired session. Sign in again."), { status: 401 });
  }
}

function requireGroup(user, group) {
  if (!user.groups.includes(group)) {
    throw Object.assign(new Error("Access denied. Please contact the web team if this is a mistake."), { status: 403 });
  }
}

function parseBody(event) {
  if (!event?.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  } catch {
    throw bad("Request body must be valid JSON.");
  }
}

function workspaceFor(name, year) {
  const workspace = WORKSPACES[name];
  if (!workspace) throw bad("Unknown workspace.");
  if (name === "members") {
    if (!/^\d{4}$/.test(String(year || ""))) throw bad("A four-digit council year is required.");
    return { ...workspace, path: `public/council/${year}/members.csv`, textPath: `public/council/${year}/leftToRight.txt` };
  }
  return workspace;
}

function assertSafeContent(content, workspace) {
  if (typeof content !== "string" || !content.trim()) throw bad("Content is required.");
  if (Buffer.byteLength(content, "utf8") > FILE_LIMIT_BYTES) throw bad("Content is too large.");
  if (content.includes("\0")) throw bad("Content contains an invalid character.");
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
  const expected = {
    lockers: "ID,Name,Desc,Location,Size,Price,Availability_Top,Availability_Mid,Availability_Bottom,Rental_Term,Lock_Included,Cover_photo,Add_photos",
    merch: "ID,Name,type_id,Type,Color,Desc,Price,Sizes_Stock,Cover_image,Additional_images",
    events: "ID,Name,StartDate,StartTime,EndDate,EndTime,Location,Image,Email,CalendarLink,Desc",
    members: "ID,Name,Title,Image,Bio,Contact,LinkedIn",
    resources: "Title,Description,Href,Icon,Alt",
  }[workspace];
  if (expected && firstLine !== expected) throw bad(`Invalid ${workspace} CSV columns.`);
}

function parseCsv(content) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const cells = (line) => {
    const values = [];
    let current = "", quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { values.push(current); current = ""; }
      else current += char;
    }
    values.push(current);
    return values;
  };
  const headers = cells(lines[0]).map((value) => value.trim());
  return {
    headers,
    rows: lines.slice(1).map((line) => {
      const values = cells(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    }),
  };
}

function lockerChanges(before, after, user) {
  const oldRows = new Map(parseCsv(before).rows.map((row) => [String(row.ID), row]));
  const nextRows = new Map(parseCsv(after).rows.map((row) => [String(row.ID), row]));
  const at = new Date().toISOString();
  const changes = [];
  for (const [id, row] of nextRows) {
    const old = oldRows.get(id) || {};
    for (const [field, value] of Object.entries(row)) {
      if (String(old[field] ?? "") !== String(value ?? "")) {
        changes.push({
          changeId: randomUUID(), productId: id, field, oldValue: String(old[field] ?? ""),
          newValue: String(value ?? ""), editedBy: user.email, editedBySub: user.sub, editedAt: at,
        });
      }
    }
  }
  for (const [id, row] of oldRows) {
    if (!nextRows.has(id)) {
      changes.push({
        changeId: randomUUID(), productId: id, field: "__deleted__", oldValue: JSON.stringify(row),
        newValue: "", editedBy: user.email, editedBySub: user.sub, editedAt: at,
      });
    }
  }
  return changes;
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function githubToken() {
  if (![GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_OWNER, GITHUB_REPO, GITHUB_PRIVATE_KEY_SECRET_ID].every(Boolean)) {
    throw Object.assign(new Error("GitHub App publishing is not configured."), { status: 500 });
  }
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: GITHUB_PRIVATE_KEY_SECRET_ID }));
  const privateKey = String(secret.SecretString || Buffer.from(secret.SecretBinary || "").toString("utf8")).replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: GITHUB_APP_ID }))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const appJwt = `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(GITHUB_INSTALLATION_ID)}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt}`, Accept: "application/vnd.github+json", "User-Agent": "chbe-admin" },
  });
  if (!response.ok) throw Object.assign(new Error("Could not obtain GitHub publishing access."), { status: 502 });
  return (await response.json()).token;
}

async function githubRequest(path, options = {}) {
  const token = await githubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "chbe-admin",
      ...(options.headers || {}),
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    console.error("GitHub request failed", response.status, detail);
    throw Object.assign(new Error("GitHub could not publish this change. Please retry."), { status: 502 });
  }
  return response.status === 204 ? null : response.json();
}

async function readRepoFile(path) {
  const file = await githubRequest(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  if (!file?.content) return null;
  return { content: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
}

async function writeRepoFile(path, contentBase64, message) {
  const current = await githubRequest(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  await githubRequest(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: contentBase64,
      branch: GITHUB_BRANCH,
      ...(current?.sha ? { sha: current.sha } : {}),
    }),
  });
}

async function dispatchInventorySync() {
  try {
    await githubRequest(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/actions/workflows/sync-inventory.yml/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: GITHUB_BRANCH }),
    });
  } catch (error) {
    console.error("Could not dispatch inventory sync", error);
  }
}

async function recordAudit(action, user, details) {
  if (!ADMIN_AUDIT_TABLE) return;
  await ddb.send(new PutCommand({
    TableName: ADMIN_AUDIT_TABLE,
    Item: { auditId: randomUUID(), action, actorEmail: user.email, actorSub: user.sub, createdAt: new Date().toISOString(), details },
  }));
}

async function handleContent(event, user) {
  const qs = event.queryStringParameters || {};
  const workspaceName = String(qs.workspace || "");
  const workspace = workspaceFor(workspaceName, qs.year);
  requireGroup(user, workspace.group);
  const file = await readRepoFile(workspace.path);
  if (!file) {
    if (workspaceName === "members") return json(200, { content: "ID,Name,Title,Image,Bio,Contact,LinkedIn\n", caption: "" });
    throw Object.assign(new Error("Content file was not found."), { status: 404 });
  }
  const result = { content: file.content };
  if (workspace.textPath) result.caption = (await readRepoFile(workspace.textPath))?.content || "";
  return json(200, result);
}

async function handleInventory(event, user) {
  const kind = String(event.queryStringParameters?.kind || "");
  if (!["locker", "merch"].includes(kind)) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = [];
  let startKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: INVENTORY_TABLE,
      FilterExpression: "kind = :kind",
      ExpressionAttributeValues: { ":kind": kind },
      ExclusiveStartKey: startKey,
    }));
    items.push(...(result.Items || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return json(200, { items });
}

async function handleWriteContent(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = workspaceFor(workspaceName, body.year);
  requireGroup(user, workspace.group);
  assertSafeContent(body.content, workspaceName);
  const old = await readRepoFile(workspace.path);
  if (workspaceName !== "members" && !old) throw Object.assign(new Error("Content file was not found."), { status: 404 });
  await writeRepoFile(workspace.path, Buffer.from(body.content, "utf8").toString("base64"), `admin(${workspaceName}): update content`);
  if (workspace.textPath && typeof body.caption === "string") {
    await writeRepoFile(workspace.textPath, Buffer.from(body.caption, "utf8").toString("base64"), "admin(members): update caption");
  }
  if (workspaceName === "lockers" && old) {
    const changes = lockerChanges(old.content, body.content, user);
    await Promise.all(changes.map((item) => ddb.send(new PutCommand({ TableName: LOCKER_CHANGES_TABLE, Item: item }))));
  }
  await recordAudit("content.publish", user, { workspace: workspaceName, path: workspace.path });
  return json(200, { ok: true, message: "Published. GitHub Pages will update shortly." });
}

function validateInventoryItem(item, kind) {
  if (!item || typeof item !== "object") throw bad("Invalid inventory item.");
  const sku = String(item.sku || "");
  const productId = String(item.productId || "");
  const label = String(item.label || "");
  const quantity = Number(item.quantity);
  if (!productId || !label || !Number.isInteger(quantity) || quantity < 0 || quantity > 100000) throw bad("Invalid inventory quantity.");
  const expected = `${kind}#${productId}#${label}`;
  if (sku !== expected) throw bad("Invalid inventory SKU.");
  return { sku, kind, productId, label, name: String(item.name || "").slice(0, 200), color: String(item.color || "").slice(0, 100), quantity, updatedAt: new Date().toISOString() };
}

async function handleSaveInventory(body, user) {
  const kind = body.kind === "locker" ? "locker" : body.kind === "merch" ? "merch" : "";
  if (!kind) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => validateInventoryItem(item, kind));
  if (!items.length || items.length > 90) throw bad("Provide between 1 and 90 inventory items.");
  await ddb.send(new TransactWriteCommand({
    TransactItems: items.map((item) => ({ Put: { TableName: INVENTORY_TABLE, Item: item } })),
  }));
  await dispatchInventorySync();
  await recordAudit("inventory.save", user, { kind, count: items.length });
  return json(200, { ok: true, message: "Inventory saved. The public CSV sync has been requested." });
}

async function handleDeleteInventory(body, user) {
  const kind = body.kind === "locker" ? "locker" : body.kind === "merch" ? "merch" : "";
  if (!kind) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => validateInventoryItem(item, kind));
  await ddb.send(new TransactWriteCommand({
    TransactItems: items.map((item) => ({ Delete: { TableName: INVENTORY_TABLE, Key: { sku: item.sku } } })),
  }));
  await dispatchInventorySync();
  await recordAudit("inventory.delete", user, { kind, count: items.length });
  return json(200, { ok: true });
}

function assetPath(workspace, filename, year) {
  const clean = String(filename || "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!clean || !/\.(png|jpe?g|webp|gif)$/i.test(clean)) throw bad("Only PNG, JPEG, WebP, and GIF images are allowed.");
  const prefix = {
    lockers: "public/lockers/images",
    merch: "public/merch/images",
    events: "public/events/images",
    resources: "public/resources",
  }[workspace] || (workspace === "members" && /^\d{4}$/.test(String(year || "")) ? `public/council/${year}` : "");
  if (!prefix) throw bad("Invalid image destination.");
  return `${prefix}/${clean}`;
}

async function handleUploadAsset(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = workspaceFor(workspaceName, body.year);
  requireGroup(user, workspace.group);
  const path = assetPath(workspaceName, body.filename, body.year);
  const bytes = Buffer.from(String(body.base64 || ""), "base64");
  if (!bytes.length || bytes.length > FILE_LIMIT_BYTES) throw bad("Image must be between 1 byte and 5 MB.");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(body.mime || ""))) throw bad("Unsupported image type.");
  await writeRepoFile(path, bytes.toString("base64"), `admin(${workspaceName}): upload image`);
  await recordAudit("asset.upload", user, { workspace: workspaceName, path });
  return json(200, { path: path.replace(/^public/, "") });
}

function cleanRichHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: ["p", "br", "strong", "em", "u", "s", "ul", "ol", "li", "h1", "h2", "h3", "blockquote", "a", "img"],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "width", "height"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    disallowedTagsMode: "discard",
  });
}

function notificationHtml(content) {
  return `<!doctype html><html><body style="margin:0;background:#fdf9ef;color:#3a4b4a;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #dce3df;"><tr><td style="padding:28px 32px;background:#3a4b4a;color:#fff;text-align:center;"><img src="${SITE_URL}/logos/logo-text-white.png" alt="CHBE" width="160" style="display:block;margin:auto;border:0;"><p style="margin:14px 0 0;font-size:11px;letter-spacing:2px;">UBC CHBE COUNCIL</p></td></tr><tr><td style="padding:34px 32px;font-size:16px;line-height:1.65;">${content}</td></tr><tr><td style="padding:0 32px 32px;text-align:center;"><a href="${SITE_URL}/account/subscriptions" style="display:inline-block;padding:12px 18px;background:#3a4b4a;color:#fff;text-decoration:none;font-weight:bold;font-size:13px;">Want to unsubscribe? Manage subscriptions</a><p style="margin:20px 0 0;font-size:12px;color:#667572;"><a href="${SITE_URL}/contact" style="color:#3a4b4a;">Contact us</a></p></td></tr></table></td></tr></table></body></html>`;
}

function attributeMap(attributes) {
  return Object.fromEntries((attributes || []).map((attribute) => [attribute.Name, attribute.Value]));
}

async function subscribedRecipients(audiences) {
  const recipients = new Set();
  let token;
  do {
    const result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, PaginationToken: token, Limit: 60 }));
    for (const user of result.Users || []) {
      const attrs = attributeMap(user.Attributes);
      const selected = audiences.some((audience) => attrs[`custom:sub_${audience}`] === "true");
      if (selected && attrs.email && user.UserStatus !== "ARCHIVED") recipients.add(String(attrs.email).trim().toLowerCase());
    }
    token = result.PaginationToken;
  } while (token);
  return [...recipients];
}

async function handleSendNotification(body, user) {
  requireGroup(user, "notifications");
  const subject = String(body.subject || "").trim().replace(/[\r\n]+/g, " ");
  const audiences = [...new Set((Array.isArray(body.audiences) ? body.audiences : []).map(String))].filter((item) => ["general", "events", "important"].includes(item));
  if (!subject || subject.length > 160) throw bad("A subject is required and must be 160 characters or fewer.");
  const html = notificationHtml(cleanRichHtml(body.html));
  if (body.test === true) {
    if (!user.email) throw bad("Your account has no email address.");
    await ses.send(new SendEmailCommand({ Source: SES_FROM, Destination: { ToAddresses: [user.email] }, Message: { Subject: { Data: `[TEST] ${subject}`, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" } } } }));
    return json(200, { ok: true, message: "Test email sent to your signed-in address." });
  }
  if (!audiences.length) throw bad("Select at least one audience.");
  const recipients = await subscribedRecipients(audiences);
  let sent = 0, failed = 0;
  for (const email of recipients) {
    try {
      await ses.send(new SendEmailCommand({ Source: SES_FROM, Destination: { ToAddresses: [email] }, Message: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" } } } }));
      sent += 1;
    } catch (error) {
      console.error("Notification email failed", email, error);
      failed += 1;
    }
  }
  await recordAudit("notification.send", user, { subject, audiences, sent, failed });
  return json(200, { ok: true, sent, failed });
}

async function handleListUsers(event, user) {
  requireGroup(user, "admin");
  const query = String(event.queryStringParameters?.query || "").trim().toLowerCase();
  const result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
  const users = [];
  for (const item of result.Users || []) {
    const attrs = attributeMap(item.Attributes);
    const email = String(attrs.email || "");
    if (query && !email.toLowerCase().includes(query) && !String(item.Username || "").toLowerCase().includes(query)) continue;
    const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: item.Username }));
    users.push({ username: item.Username, email, name: String(attrs.name || ""), groups: (groups.Groups || []).map((group) => group.GroupName) });
  }
  return json(200, { users, availableGroups: ADMIN_GROUPS });
}

async function groupHasAnotherUser(group) {
  const result = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: group, Limit: 2 }));
  return (result.Users || []).length > 1;
}

async function handleGroupUpdate(body, user) {
  requireGroup(user, "admin");
  const username = String(body.username || "").trim();
  const group = String(body.group || "").trim();
  const add = body.add === true;
  if (!username || !ADMIN_GROUPS.includes(group)) throw bad("Invalid user or group.");
  if (username.toLowerCase() === user.email.toLowerCase() || username === user.sub) throw bad("You cannot change your own groups.");
  if (!add && ["admin", "superusers"].includes(group) && !(await groupHasAnotherUser(group))) {
    throw bad(`At least one ${group} member must remain.`);
  }
  const command = add ? new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: group })
    : new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: group });
  await cognito.send(command);
  await recordAudit("cognito.group.update", user, { username, group, add });
  return json(200, { ok: true });
}

export async function handler(event) {
  try {
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") return json(204, {});
    const user = await requireUser(event);
    const queryAction = String(event.queryStringParameters?.action || "");
    if (method === "GET" && queryAction === "content") return await handleContent(event, user);
    if (method === "GET" && queryAction === "inventory") return await handleInventory(event, user);
    if (method === "GET" && queryAction === "users") return await handleListUsers(event, user);
    if (method !== "POST") return json(405, { error: "Method not allowed." });
    const body = parseBody(event);
    if (body.action === "writeContent") return await handleWriteContent(body, user);
    if (body.action === "saveInventory") return await handleSaveInventory(body, user);
    if (body.action === "deleteInventory") return await handleDeleteInventory(body, user);
    if (body.action === "uploadAsset") return await handleUploadAsset(body, user);
    if (body.action === "sendNotification") return await handleSendNotification(body, user);
    if (body.action === "groupUpdate") return await handleGroupUpdate(body, user);
    return json(400, { error: "Unknown action." });
  } catch (error) {
    const status = error?.status || 500;
    console.error(error);
    return json(status, { error: error?.message || "Server error." });
  }
}
