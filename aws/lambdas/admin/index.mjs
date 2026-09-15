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
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import sanitizeHtml from "sanitize-html";

const REGION = process.env.AWS_REGION || "us-east-2";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
const INVENTORY_TABLE = process.env.INVENTORY_TABLE || "inventory";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const ORDERS_COMPLETE_TABLE = process.env.ORDERS_COMPLETE_TABLE || "orders-complete";
const LOCKER_CHANGES_TABLE = process.env.LOCKER_CHANGES_TABLE || "locker-changes";
const ADMIN_AUDIT_TABLE = process.env.ADMIN_AUDIT_TABLE || "admin-audit";
const ADMIN_PUBLISH_QUEUE_TABLE = process.env.ADMIN_PUBLISH_QUEUE_TABLE || "admin-publish-queue";
const SES_FROM = process.env.SES_FROM || "UBC CHBE Council Notifications <notifications@ubcchbecouncil.com>";
const ORDERS_SES_FROM = process.env.ORDERS_SES_FROM || "CHBE Orders <orders@ubcchbecouncil.com>";
const EMAIL_QUEUE_URL = process.env.EMAIL_QUEUE_URL || "";
const SITE_URL = (process.env.SITE_URL || "https://ubcchbecouncil.com").replace(/\/$/, "");
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_PRIVATE_KEY_SECRET_ID = process.env.GITHUB_PRIVATE_KEY_SECRET_ID || "";
const LOCK_PK = "LOCK";
const LOCK_SK = "publish";
const QUEUE_PK = "QUEUE";
const LOCK_TTL_MS = 5 * 60 * 1000;
const DRAIN_BATCH_SIZE = 5;
const QUEUED_MESSAGE = "Your changes are queued and will publish after the current update finishes. Nothing was discarded.";
const ORDER_STATUS = {
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_RECEIVED: "payment_received",
  ORDER_READY: "order_ready",
  ORDER_COMPLETED: "order_completed",
  CANCELLED: "cancelled",
};
const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUS.PAYMENT_PENDING,
  ORDER_STATUS.PAYMENT_RECEIVED,
  ORDER_STATUS.ORDER_READY,
];
const ADMIN_ORDER_STATUSES = [
  ORDER_STATUS.PAYMENT_PENDING,
  ORDER_STATUS.PAYMENT_RECEIVED,
  ORDER_STATUS.ORDER_READY,
  ORDER_STATUS.ORDER_COMPLETED,
];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ses = new SESClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
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

async function tryAcquireLock(holder) {
  const now = Date.now();
  try {
    await ddb.send(new PutCommand({
      TableName: ADMIN_PUBLISH_QUEUE_TABLE,
      Item: { pk: LOCK_PK, sk: LOCK_SK, holder, expiresAt: now + LOCK_TTL_MS, acquiredAt: now },
      ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
    }));
    return true;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function releaseLock(holder) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: ADMIN_PUBLISH_QUEUE_TABLE,
      Key: { pk: LOCK_PK, sk: LOCK_SK },
      ConditionExpression: "holder = :holder OR expiresAt < :now",
      ExpressionAttributeValues: { ":holder": holder, ":now": Date.now() },
    }));
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
  }
}

async function enqueuePublish(action, payload, user) {
  const id = randomUUID();
  const sk = `${String(Date.now()).padStart(15, "0")}#${id}`;
  await ddb.send(new PutCommand({
    TableName: ADMIN_PUBLISH_QUEUE_TABLE,
    Item: {
      pk: QUEUE_PK,
      sk,
      jobId: id,
      status: "pending",
      action,
      payload,
      actorEmail: user.email,
      actorSub: user.sub,
      actorGroups: user.groups,
      createdAt: new Date().toISOString(),
    },
  }));
  return id;
}

async function claimNextJob() {
  const result = await ddb.send(new QueryCommand({
    TableName: ADMIN_PUBLISH_QUEUE_TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": QUEUE_PK },
    ScanIndexForward: true,
    Limit: 40,
  }));
  for (const item of result.Items || []) {
    if (item.status !== "pending") continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: ADMIN_PUBLISH_QUEUE_TABLE,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: "SET #status = :running, startedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":running": "running",
          ":pending": "pending",
          ":at": new Date().toISOString(),
        },
      }));
      return item;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") continue;
      throw error;
    }
  }
  return null;
}

async function finishJob(job, status, errorMessage) {
  if (status === "done" || status === "failed") {
    if (status === "failed") {
      console.error("Removing failed publish job", {
        jobId: job.jobId,
        action: job.action,
        error: errorMessage,
      });
    }
    await ddb.send(new DeleteCommand({
      TableName: ADMIN_PUBLISH_QUEUE_TABLE,
      Key: { pk: job.pk, sk: job.sk },
    }));
    return;
  }
  await ddb.send(new UpdateCommand({
    TableName: ADMIN_PUBLISH_QUEUE_TABLE,
    Key: { pk: job.pk, sk: job.sk },
    UpdateExpression: "SET #status = :status, finishedAt = :at",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": status,
      ":at": new Date().toISOString(),
    },
  }));
}

async function hasPendingJobs() {
  const status = await getPublishStatus();
  return status.pending > 0;
}

async function getPublishStatus() {
  const now = Date.now();
  const [lockResult, queueResult] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: ADMIN_PUBLISH_QUEUE_TABLE,
      Key: { pk: LOCK_PK, sk: LOCK_SK },
    })),
    ddb.send(new QueryCommand({
      TableName: ADMIN_PUBLISH_QUEUE_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": QUEUE_PK },
      ScanIndexForward: true,
      Limit: 40,
    })),
  ]);
  const lockHeld = Boolean(lockResult.Item && Number(lockResult.Item.expiresAt || 0) > now);
  const active = (queueResult.Items || []).filter((item) => item.status === "pending" || item.status === "running");
  const pending = active.filter((item) => item.status === "pending").length;
  const running = active.filter((item) => item.status === "running").length;
  return {
    busy: lockHeld || active.length > 0,
    pending,
    running,
  };
}

async function handlePublishStatus(_event, _user) {
  return json(200, await getPublishStatus());
}

async function scheduleDrain() {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    await drainPublishQueue();
    return;
  }
  await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ drainPublishQueue: true })),
  }));
}

async function executeQueuedJob(job, user) {
  const payload = job.payload || {};
  if (job.action === "publishWorkspace") return executePublishWorkspace(payload, user);
  if (job.action === "writeContent") return executeWriteContent(payload, user);
  if (job.action === "saveInventory") return executeSaveInventory(payload, user);
  if (job.action === "deleteInventory") return executeDeleteInventory(payload, user);
  if (job.action === "uploadAsset") return executeUploadAsset(payload, user);
  throw new Error(`Unknown queued action: ${job.action}`);
}

async function drainPublishQueue() {
  const holder = `drain-${randomUUID()}`;
  if (!(await tryAcquireLock(holder))) return;
  try {
    for (let i = 0; i < DRAIN_BATCH_SIZE; i += 1) {
      const job = await claimNextJob();
      if (!job) break;
      const user = {
        sub: String(job.actorSub || ""),
        email: String(job.actorEmail || ""),
        name: "",
        groups: Array.isArray(job.actorGroups) ? job.actorGroups.map(String) : [],
      };
      try {
        await executeQueuedJob(job, user);
        await finishJob(job, "done");
      } catch (error) {
        console.error("Queued publish failed", { jobId: job.jobId, action: job.action, error });
        await finishJob(job, "failed", error?.message || "failed");
      }
    }
  } finally {
    await releaseLock(holder);
  }
  if (await hasPendingJobs()) await scheduleDrain();
}

async function runOrQueue(action, payload, user, execute) {
  const holder = randomUUID();
  if (!(await tryAcquireLock(holder))) {
    await enqueuePublish(action, payload, user);
    await scheduleDrain();
    return json(200, { ok: true, queued: true, message: QUEUED_MESSAGE });
  }
  try {
    const result = await execute();
    return json(200, { ok: true, queued: false, ...(result || {}) });
  } finally {
    await releaseLock(holder);
    await scheduleDrain();
  }
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

async function executeWriteContent(body, user) {
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
  return { message: "Published. GitHub Pages will update shortly." };
}

async function handleWriteContent(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = workspaceFor(workspaceName, body.year);
  requireGroup(user, workspace.group);
  assertSafeContent(body.content, workspaceName);
  const payload = {
    workspace: workspaceName,
    year: body.year,
    content: body.content,
    caption: typeof body.caption === "string" ? body.caption : undefined,
  };
  return runOrQueue("writeContent", payload, user, () => executeWriteContent(payload, user));
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

async function executeSaveInventory(body, user) {
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
  return { message: "Inventory saved. The public CSV sync has been requested." };
}

async function handleSaveInventory(body, user) {
  const kind = body.kind === "locker" ? "locker" : body.kind === "merch" ? "merch" : "";
  if (!kind) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => validateInventoryItem(item, kind));
  if (!items.length || items.length > 90) throw bad("Provide between 1 and 90 inventory items.");
  const payload = { kind, items };
  return runOrQueue("saveInventory", payload, user, () => executeSaveInventory(payload, user));
}

async function executeDeleteInventory(body, user) {
  const kind = body.kind === "locker" ? "locker" : body.kind === "merch" ? "merch" : "";
  if (!kind) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => validateInventoryItem(item, kind));
  if (items.length) {
    await ddb.send(new TransactWriteCommand({
      TransactItems: items.map((item) => ({ Delete: { TableName: INVENTORY_TABLE, Key: { sku: item.sku } } })),
    }));
    await dispatchInventorySync();
  }
  await recordAudit("inventory.delete", user, { kind, count: items.length });
  return { message: "Inventory items removed." };
}

async function handleDeleteInventory(body, user) {
  const kind = body.kind === "locker" ? "locker" : body.kind === "merch" ? "merch" : "";
  if (!kind) throw bad("Inventory kind is required.");
  requireGroup(user, kind === "locker" ? "lockers" : "merch");
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => validateInventoryItem(item, kind));
  const payload = { kind, items };
  return runOrQueue("deleteInventory", payload, user, () => executeDeleteInventory(payload, user));
}

async function executePublishWorkspace(body, user) {
  const contentResult = await executeWriteContent(body, user);
  const workspaceName = String(body.workspace || "");
  const kind = workspaceName === "lockers" ? "locker" : workspaceName === "merch" ? "merch" : "";
  let inventoryChanged = false;
  if (kind) {
    const removed = (Array.isArray(body.removedInventory) ? body.removedInventory : []).map((item) => validateInventoryItem(item, kind));
    const inventory = (Array.isArray(body.inventory) ? body.inventory : []).map((item) => validateInventoryItem(item, kind));
    if (removed.length > 90 || inventory.length > 90) throw bad("Provide at most 90 inventory items per publish.");
    if (removed.length) {
      await ddb.send(new TransactWriteCommand({
        TransactItems: removed.map((item) => ({ Delete: { TableName: INVENTORY_TABLE, Key: { sku: item.sku } } })),
      }));
      inventoryChanged = true;
      await recordAudit("inventory.delete", user, { kind, count: removed.length });
    }
    if (inventory.length) {
      await ddb.send(new TransactWriteCommand({
        TransactItems: inventory.map((item) => ({ Put: { TableName: INVENTORY_TABLE, Item: item } })),
      }));
      inventoryChanged = true;
      await recordAudit("inventory.save", user, { kind, count: inventory.length });
    }
    if (inventoryChanged) await dispatchInventorySync();
  }
  return { message: contentResult.message || "Published. GitHub Pages will update shortly." };
}

async function handlePublishWorkspace(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = workspaceFor(workspaceName, body.year);
  requireGroup(user, workspace.group);
  assertSafeContent(body.content, workspaceName);
  const kind = workspaceName === "lockers" ? "locker" : workspaceName === "merch" ? "merch" : "";
  const payload = {
    workspace: workspaceName,
    year: body.year,
    content: body.content,
    caption: typeof body.caption === "string" ? body.caption : undefined,
    inventory: kind && Array.isArray(body.inventory) ? body.inventory.map((item) => validateInventoryItem(item, kind)) : [],
    removedInventory: kind && Array.isArray(body.removedInventory) ? body.removedInventory.map((item) => validateInventoryItem(item, kind)) : [],
  };
  if (payload.inventory.length > 90 || payload.removedInventory.length > 90) {
    throw bad("Provide at most 90 inventory items per publish.");
  }
  return runOrQueue("publishWorkspace", payload, user, () => executePublishWorkspace(payload, user));
}

function assetDirectory(workspace, year) {
  const directory = {
    lockers: "public/lockers/images",
    merch: "public/merch/images",
    events: "public/events/images",
    notifications: "public/emails/images",
    resources: "public/resources",
  }[workspace] || (workspace === "members" && /^\d{4}$/.test(String(year || "")) ? `public/council/${year}` : "");
  if (!directory) throw bad("Invalid image destination.");
  return directory;
}

function assetWorkspace(workspaceName, year) {
  if (workspaceName === "notifications") return { group: "notifications" };
  return workspaceFor(workspaceName, year);
}

function assetPath(workspace, filename, year) {
  const clean = String(filename || "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!clean || !/\.(png|jpe?g|webp|gif)$/i.test(clean)) throw bad("Only PNG, JPEG, WebP, and GIF images are allowed.");
  return `${assetDirectory(workspace, year)}/${clean}`;
}

async function handleListAssets(event, user) {
  const qs = event.queryStringParameters || {};
  const workspaceName = String(qs.workspace || "");
  const workspace = assetWorkspace(workspaceName, qs.year);
  requireGroup(user, workspace.group);
  if (!["lockers", "merch", "events", "notifications"].includes(workspaceName)) throw bad("Image browsing is not available for this workspace.");
  const directory = assetDirectory(workspaceName, qs.year);
  const files = await githubRequest(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${directory.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  const assets = Array.isArray(files)
    ? files.filter((file) => file?.type === "file" && /\.(png|jpe?g|webp|gif)$/i.test(String(file.name || "")))
      .map((file) => String(file.name)).sort((a, b) => a.localeCompare(b))
    : [];
  return json(200, { assets });
}

async function executeUploadAsset(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = assetWorkspace(workspaceName, body.year);
  requireGroup(user, workspace.group);
  const path = assetPath(workspaceName, body.filename, body.year);
  const bytes = Buffer.from(String(body.base64 || ""), "base64");
  if (!bytes.length || bytes.length > FILE_LIMIT_BYTES) throw bad("Image must be between 1 byte and 5 MB.");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(body.mime || ""))) throw bad("Unsupported image type.");
  await writeRepoFile(path, bytes.toString("base64"), `admin(${workspaceName}): upload image`);
  await recordAudit("asset.upload", user, { workspace: workspaceName, path });
  return { path: path.replace(/^public/, ""), message: "Image uploaded." };
}

async function handleUploadAsset(body, user) {
  const workspaceName = String(body.workspace || "");
  const workspace = assetWorkspace(workspaceName, body.year);
  requireGroup(user, workspace.group);
  const path = assetPath(workspaceName, body.filename, body.year);
  const bytes = Buffer.from(String(body.base64 || ""), "base64");
  if (!bytes.length || bytes.length > FILE_LIMIT_BYTES) throw bad("Image must be between 1 byte and 5 MB.");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(body.mime || ""))) throw bad("Unsupported image type.");
  const payload = {
    workspace: workspaceName,
    year: body.year,
    filename: body.filename,
    mime: body.mime,
    base64: body.base64,
  };
  const publicPath = path.replace(/^public/, "");
  const holder = randomUUID();
  if (!(await tryAcquireLock(holder))) {
    await enqueuePublish("uploadAsset", payload, user);
    await scheduleDrain();
    return json(200, { ok: true, queued: true, path: publicPath, message: QUEUED_MESSAGE });
  }
  try {
    const result = await executeUploadAsset(payload, user);
    return json(200, { ok: true, queued: false, ...result });
  } finally {
    await releaseLock(holder);
    await scheduleDrain();
  }
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

function emailJob({ to, subject, html, source = SES_FROM }) {
  const job = {
    to: String(to || "").trim().toLowerCase(),
    subject: String(subject || "").trim(),
    html: String(html || ""),
    source: String(source || SES_FROM).trim(),
  };
  if (!job.to || !job.subject || !job.html || !job.source) throw bad("Invalid email job.");
  if (Buffer.byteLength(JSON.stringify(job), "utf8") > 250 * 1024) throw bad("This email is too large to queue.");
  return job;
}

async function enqueueEmails(jobs) {
  if (!EMAIL_QUEUE_URL) throw new Error("The email queue is not configured.");
  for (let index = 0; index < jobs.length; index += 10) {
    const batch = jobs.slice(index, index + 10);
    const result = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: EMAIL_QUEUE_URL,
      Entries: batch.map((job, batchIndex) => ({
        Id: String(batchIndex),
        MessageBody: JSON.stringify(job),
        MessageGroupId: "ses",
        MessageDeduplicationId: randomUUID(),
      })),
    }));
    if (result.Failed?.length) {
      throw new Error(`Could not queue ${result.Failed.length} email(s).`);
    }
  }
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
    await enqueueEmails([emailJob({ to: user.email, subject: `[TEST] ${subject}`, html })]);
    return json(200, { ok: true, message: "Test email queued for delivery." });
  }
  if (!audiences.length) throw bad("Select at least one audience.");
  const recipients = await subscribedRecipients(audiences);
  await enqueueEmails(recipients.map((email) => emailJob({ to: email, subject, html })));
  await recordAudit("notification.queue", user, { subject, audiences, queued: recipients.length });
  return json(200, { ok: true, queued: recipients.length });
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeOrderStatus(status) {
  if (status === 0 || status === "0") return ORDER_STATUS.CANCELLED;
  if (status === 1 || status === "1") return ORDER_STATUS.PAYMENT_PENDING;
  if (status === 2 || status === "2") return ORDER_STATUS.ORDER_COMPLETED;
  const value = String(status || "").trim();
  if (
    value === ORDER_STATUS.PAYMENT_PENDING ||
    value === ORDER_STATUS.PAYMENT_RECEIVED ||
    value === ORDER_STATUS.ORDER_READY ||
    value === ORDER_STATUS.ORDER_COMPLETED ||
    value === ORDER_STATUS.CANCELLED
  ) {
    return value;
  }
  return ORDER_STATUS.PAYMENT_PENDING;
}

function publicOrder(order) {
  if (!order || typeof order !== "object") return order;
  return { ...order, status: normalizeOrderStatus(order.status) };
}

function isActiveOrderStatus(status) {
  return ACTIVE_ORDER_STATUSES.includes(normalizeOrderStatus(status));
}

function orderStatusLabel(status) {
  switch (normalizeOrderStatus(status)) {
    case ORDER_STATUS.PAYMENT_PENDING:
      return "Payment pending";
    case ORDER_STATUS.PAYMENT_RECEIVED:
      return "Payment received";
    case ORDER_STATUS.ORDER_READY:
      return "Order ready";
    case ORDER_STATUS.ORDER_COMPLETED:
      return "Order completed";
    case ORDER_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return "Payment pending";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orderStatusBodyCopy(status) {
  switch (normalizeOrderStatus(status)) {
    case ORDER_STATUS.PAYMENT_PENDING:
      return "A member of our team will contact you for payment details soon.";
    case ORDER_STATUS.PAYMENT_RECEIVED:
      return "Payment received. We are preparing your order.";
    case ORDER_STATUS.ORDER_READY:
      return "Your order is ready for pickup.";
    case ORDER_STATUS.ORDER_COMPLETED:
      return "Your order has been marked completed. Thank you for supporting CHBE Council.";
    default:
      return "Your order status has been updated.";
  }
}

function buildOrderStatusEmailHtml(order, status) {
  const label = orderStatusLabel(status);
  const body = orderStatusBodyCopy(status);
  const orderID = String(order.orderID || "");
  const orderUrl = `${SITE_URL}/account/orders/view/?id=${encodeURIComponent(orderID)}`;
  const allOrdersUrl = `${SITE_URL}/account/orders`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(label)} — ${escapeHtml(orderID)}</title>
</head>
<body style="margin:0;padding:0;background-color:#fdf9ef;-webkit-text-size-adjust:100%;">
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
            <td style="padding:36px 32px 16px;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
              <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;line-height:1.25;color:#3a4b4a;">${escapeHtml(label)}</h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:rgba(58,75,74,0.8);">${escapeHtml(body)}</p>
              <p style="margin:0 0 8px;font-size:13px;color:rgba(58,75,74,0.65);">Order ID</p>
              <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;color:#3a4b4a;">${escapeHtml(orderID)}</p>
              <p style="margin:0;font-size:14px;line-height:1.6;color:rgba(58,75,74,0.75);">
                Hi ${escapeHtml(order.name || "there")}. You can review this order any time in your account.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#3a4b4a;">
                    <a href="${orderUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#fdf9ef;text-decoration:none;">View order status</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
                <tr>
                  <td style="background-color:transparent;border:1.5px solid #3a4b4a;">
                    <a href="${allOrdersUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#3a4b4a;text-decoration:none;">View all orders</a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:rgba(58,75,74,0.65);">
                Problem with this order? <a href="${SITE_URL}/contact" target="_blank" rel="noopener" style="color:#4a8550;text-decoration:underline;">Contact us</a> now.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f7f3e8;border-top:1px solid rgba(58,75,74,0.12);padding:20px 32px;">
              <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:rgba(58,75,74,0.65);">UBC Chemical &amp; Biological Engineering Student Council</p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;">
                <a href="${SITE_URL}" target="_blank" rel="noopener" style="color:#4a8550;text-decoration:underline;">ubcchbecouncil.com</a>
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

async function sendOrderStatusEmail(order, status) {
  const to = String(order.email || "").trim();
  if (!to) return;
  const label = orderStatusLabel(status);
  const subject = `${label} — ${order.orderID}`;
  await enqueueEmails([
    emailJob({
      to,
      subject,
      html: buildOrderStatusEmailHtml(order, status),
      source: ORDERS_SES_FROM,
    }),
  ]);
}

async function scanOrdersTable(tableName) {
  const items = [];
  let startKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: startKey,
    }));
    items.push(...(result.Items || []).map(publicOrder));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return items;
}

async function migrateTerminalOrdersFromActive() {
  const active = await scanOrdersTable(ORDERS_TABLE);
  const terminal = active.filter((order) => !isActiveOrderStatus(order.status));
  for (const order of terminal) {
    const orderID = String(order.orderID || "");
    if (!orderID) continue;
    const next = {
      ...order,
      status: normalizeOrderStatus(order.status),
      updatedAt: order.updatedAt || new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: ORDERS_COMPLETE_TABLE, Item: next }));
    await ddb.send(new DeleteCommand({ TableName: ORDERS_TABLE, Key: { orderID } }));
  }
  return terminal.length;
}

async function handleListOrders(event, user) {
  requireGroup(user, "merch");
  const scope = String(event.queryStringParameters?.scope || "active").toLowerCase();
  if (scope === "complete" || scope === "completed") {
    await migrateTerminalOrdersFromActive();
    const orders = await scanOrdersTable(ORDERS_COMPLETE_TABLE);
    return json(200, { orders, scope: "complete" });
  }
  await migrateTerminalOrdersFromActive();
  const active = (await scanOrdersTable(ORDERS_TABLE)).filter((order) => isActiveOrderStatus(order.status));
  return json(200, { orders: active, scope: "active" });
}

async function handleUpdateOrderStatus(body, user) {
  requireGroup(user, "merch");
  const orderID = String(body.orderID || body.orderId || "").trim();
  const status = normalizeOrderStatus(body.status);
  if (!orderID) throw bad("Order ID is required.");
  if (!ADMIN_ORDER_STATUSES.includes(status)) throw bad("Invalid order status.");

  const active = await ddb.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { orderID } }));
  const complete = active.Item
    ? null
    : await ddb.send(new GetCommand({ TableName: ORDERS_COMPLETE_TABLE, Key: { orderID } }));
  const existing = active.Item || complete?.Item;
  if (!existing) throw Object.assign(new Error("Order not found."), { status: 404 });

  const previousStatus = normalizeOrderStatus(existing.status);
  const now = new Date().toISOString();
  const next = { ...existing, status, updatedAt: now, updatedBy: user.email };

  if (status === ORDER_STATUS.ORDER_COMPLETED) {
    await ddb.send(new PutCommand({ TableName: ORDERS_COMPLETE_TABLE, Item: next }));
    if (active.Item) {
      await ddb.send(new DeleteCommand({ TableName: ORDERS_TABLE, Key: { orderID } }));
    }
  } else if (active.Item) {
    await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: next }));
  } else {
    // Reactivate from complete table
    await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: next }));
    await ddb.send(new DeleteCommand({ TableName: ORDERS_COMPLETE_TABLE, Key: { orderID } }));
  }

  let emailed = false;
  if (previousStatus !== status) {
    try {
      await sendOrderStatusEmail(next, status);
      emailed = true;
    } catch (error) {
      console.error("Order status email failed", { orderID, status, error });
    }
  }

  await recordAudit("order.status.update", user, { orderID, status, emailed });
  return json(200, { ok: true, emailed, order: publicOrder(next) });
}

async function handleEmailQueue(event) {
  const batchStartedAt = Date.now();
  const results = await Promise.all((event.Records || []).map(async (record) => {
    try {
      const job = emailJob(JSON.parse(record.body || "{}"));
      await ses.send(new SendEmailCommand({
        Source: job.source,
        Destination: { ToAddresses: [job.to] },
        Message: {
          Subject: { Data: job.subject, Charset: "UTF-8" },
          Body: { Html: { Data: job.html, Charset: "UTF-8" } },
        },
      }));
      return null;
    } catch (error) {
      console.error("Queued email failed", { messageId: record.messageId, error });
      return { itemIdentifier: record.messageId };
    }
  }));
  await delay(Math.max(0, 1000 - (Date.now() - batchStartedAt)));
  return { batchItemFailures: results.filter(Boolean) };
}

export async function handler(event) {
  try {
    if (event?.drainPublishQueue === true) {
      await drainPublishQueue();
      return json(200, { ok: true });
    }
    if (Array.isArray(event?.Records) && event.Records.every((record) => record.eventSource === "aws:sqs")) {
      return await handleEmailQueue(event);
    }
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") return json(204, {});
    const user = await requireUser(event);
    const queryAction = String(event.queryStringParameters?.action || "");
    if (method === "GET" && queryAction === "content") return await handleContent(event, user);
    if (method === "GET" && queryAction === "inventory") return await handleInventory(event, user);
    if (method === "GET" && queryAction === "assets") return await handleListAssets(event, user);
    if (method === "GET" && queryAction === "users") return await handleListUsers(event, user);
    if (method === "GET" && queryAction === "publishStatus") return await handlePublishStatus(event, user);
    if (method === "GET" && queryAction === "orders") return await handleListOrders(event, user);
    if (method !== "POST") return json(405, { error: "Method not allowed." });
    const body = parseBody(event);
    if (body.action === "publishWorkspace") return await handlePublishWorkspace(body, user);
    if (body.action === "writeContent") return await handleWriteContent(body, user);
    if (body.action === "saveInventory") return await handleSaveInventory(body, user);
    if (body.action === "deleteInventory") return await handleDeleteInventory(body, user);
    if (body.action === "uploadAsset") return await handleUploadAsset(body, user);
    if (body.action === "sendNotification") return await handleSendNotification(body, user);
    if (body.action === "groupUpdate") return await handleGroupUpdate(body, user);
    if (body.action === "updateOrderStatus") return await handleUpdateOrderStatus(body, user);
    return json(400, { error: "Unknown action." });
  } catch (error) {
    const status = error?.status || 500;
    console.error(error);
    return json(status, { error: error?.message || "Server error." });
  }
}
