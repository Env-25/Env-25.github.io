/**
 * CHBE orders API (Function URL).
 *
 * POST  { action:"place", studentNumber, items[] }  → create order + decrement stock + email
 * GET   ?orderId=...                                 → fetch one order (owner only)
 * GET   ?inventory=1[&skus=a,b]                      → live stock map
 *
 * CORS is configured on the Function URL — do not set CORS headers here.
 */
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const REGION = process.env.AWS_REGION || "us-east-2";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const INVENTORY_TABLE = process.env.INVENTORY_TABLE || "inventory";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
const SES_FROM =
  process.env.SES_FROM || "CHBE Orders <orders@ubcchbecouncil.com>";
const STAFF_EMAILS = (process.env.STAFF_ORDER_EMAILS ||
  "akshaj243@gmail.com,sachdevaakshaj1@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SITE_URL = (process.env.SITE_URL || "https://ubcchbecouncil.com").replace(/\/$/, "");
const CARD_SURCHARGE = 1.03;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const ses = new SESClient({ region: REGION });

const verifier =
  USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID,
      })
    : null;

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
    throw Object.assign(new Error("Auth is not configured on the server."), { status: 500 });
  }
  const token = getBearer(event);
  if (!token) {
    throw Object.assign(new Error("Sign in required."), { status: 401 });
  }
  try {
    const payload = await verifier.verify(token);
    return {
      sub: String(payload.sub || ""),
      email: String(payload.email || ""),
      name: String(payload.name || ""),
      emailVerified:
        payload.email_verified === true ||
        payload.email_verified === "true",
      studentNumber: String(payload["custom:student_number"] || ""),
      profileComplete:
        payload["custom:profile_complete"] === true ||
        payload["custom:profile_complete"] === "true",
    };
  } catch {
    throw Object.assign(new Error("Invalid or expired session. Sign in again."), {
      status: 401,
    });
  }
}

function merchSku(id, size) {
  return `merch#${id}#${size}`;
}

function lockerSku(id, level) {
  return `locker#${id}#${level}`;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "locker" ? "locker" : raw.kind === "merch" ? "merch" : null;
  if (!kind) return null;

  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  const image = String(raw.image || "").trim();
  const unitPrice = Number(raw.unitPrice);
  if (!id || !name || !Number.isFinite(unitPrice) || unitPrice < 0) return null;

  if (kind === "merch") {
    const size = String(raw.size || "").trim();
    const color = String(raw.color || "").trim();
    let qty = Math.floor(Number(raw.qty) || 0);
    if (!size || qty < 1) return null;
    qty = Math.min(qty, 99);
    return {
      kind,
      id,
      name,
      image,
      color,
      size,
      qty,
      unitPrice,
      sku: merchSku(id, size),
    };
  }

  const level = String(raw.level || "").trim();
  if (!["Top", "Mid", "Bottom"].includes(level)) return null;
  return {
    kind,
    id,
    name,
    image,
    level,
    location: String(raw.location || "").trim(),
    qty: 1,
    unitPrice,
    sku: lockerSku(id, level),
  };
}

function buildOrderEmailHtml({ orderID, name, items, cashSubtotal, cardSubtotal, status }) {
  const rows = items
    .map((it) => {
      const detail =
        it.kind === "merch"
          ? `${escapeHtml(it.color || "")} · ${escapeHtml(it.size || "")} × ${it.qty}`
          : `${escapeHtml(it.level || "")} level · ${escapeHtml(it.location || "")}`;
      const line = (it.unitPrice * it.qty).toFixed(2);
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid rgba(58,75,74,0.12);font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3a4b4a;">
          <strong>${escapeHtml(it.name)}</strong><br/>
          <span style="color:rgba(58,75,74,0.65);font-size:13px;">${detail}</span>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(58,75,74,0.12);font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3a4b4a;white-space:nowrap;">
          $${line}
        </td>
      </tr>`;
    })
    .join("");

  const statusLine =
    status === 0
      ? "This order was cancelled."
      : status === 2
        ? "Your order is marked completed."
        : "Thank you for your order. A member of our team will contact you shortly for more information.";

  const heading =
    status === 0 ? "Order cancelled" : status === 2 ? "Order completed" : "Order received";

  const orderUrl = `${SITE_URL}/account/orders/view/?id=${encodeURIComponent(orderID)}`;
  const allOrdersUrl = `${SITE_URL}/account/orders`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>Order ${escapeHtml(orderID)}</title>
</head>
<body style="margin:0;padding:0;background-color:#fdf9ef;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your CHBE Council order confirmation.</div>
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
              <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;line-height:1.25;color:#3a4b4a;">${heading}</h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:rgba(58,75,74,0.8);">${escapeHtml(statusLine)}</p>
              <p style="margin:0 0 8px;font-size:13px;color:rgba(58,75,74,0.65);">Order ID</p>
              <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;color:#3a4b4a;">${escapeHtml(orderID)}</p>
              <p style="margin:0;font-size:14px;line-height:1.6;color:rgba(58,75,74,0.75);">
                Hi ${escapeHtml(name || "there")}. Status updates will be sent to your registered email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 8px;">
              <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(58,75,74,0.55);">In your order</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
              <p style="margin:0 0 6px;font-size:14px;">Cash subtotal: <strong>$${cashSubtotal.toFixed(2)} CAD</strong></p>
              <p style="margin:0 0 18px;font-size:14px;">Card subtotal: <strong>$${cardSubtotal.toFixed(2)} CAD</strong> <span style="color:rgba(58,75,74,0.55);">(incl. 3% surcharge)</span></p>
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

function buildStaffEmailHtml(order) {
  const lines = order.items
    .map((it) => {
      const detail =
        it.kind === "merch"
          ? `${it.color || ""} / ${it.size || ""} × ${it.qty}`
          : `${it.level} @ ${it.location || ""}`;
      return `• ${it.name} (${detail}) — $${(it.unitPrice * it.qty).toFixed(2)}`;
    })
    .join("<br/>");

  return `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:24px;background:#fdf9ef;font-family:Arial,Helvetica,sans-serif;color:#3a4b4a;">
  <h1 style="font-family:Georgia,serif;">New CHBE order</h1>
  <p><strong>Order ID:</strong> ${escapeHtml(order.orderID)}</p>
  <p><strong>Name:</strong> ${escapeHtml(order.name)}<br/>
     <strong>Email:</strong> ${escapeHtml(order.email)}<br/>
     <strong>Student #:</strong> ${escapeHtml(order.studentNumber)}</p>
  <p>${lines}</p>
  <p>Cash: $${order.cashSubtotal.toFixed(2)} · Card: $${order.cardSubtotal.toFixed(2)}</p>
  <p><a href="${SITE_URL}/account/orders/view/?id=${encodeURIComponent(order.orderID)}">Open order</a></p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmail({ to, subject, html }) {
  await ses.send(
    new SendEmailCommand({
      Source: SES_FROM,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: html, Charset: "UTF-8" } },
      },
    })
  );
}

async function handleInventory(event) {
  const qs = event.queryStringParameters || {};
  const skuParam = String(qs.skus || "").trim();
  const wanted = skuParam
    ? skuParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  if (wanted && wanted.length <= 25) {
    const out = {};
    await Promise.all(
      wanted.map(async (sku) => {
        const res = await ddb.send(
          new GetCommand({ TableName: INVENTORY_TABLE, Key: { sku } })
        );
        out[sku] = Number(res.Item?.quantity ?? 0);
      })
    );
    return json(200, { stock: out });
  }

  const stock = {};
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: INVENTORY_TABLE,
        ExclusiveStartKey,
        ProjectionExpression: "sku, quantity",
      })
    );
    for (const item of page.Items || []) {
      stock[item.sku] = Number(item.quantity ?? 0);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (wanted) {
    const filtered = {};
    for (const sku of wanted) filtered[sku] = stock[sku] ?? 0;
    return json(200, { stock: filtered });
  }
  return json(200, { stock });
}

async function handleListOrders(user) {
  const orders = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: ORDERS_TABLE,
        ExclusiveStartKey,
        FilterExpression: "userSub = :u",
        ExpressionAttributeValues: { ":u": user.sub },
      })
    );
    for (const item of page.Items || []) orders.push(item);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return json(200, { orders });
}

async function stockSnapshot(lineItems) {
  const outOfStock = [];
  await Promise.all(
    lineItems.map(async (it) => {
      const res = await ddb.send(
        new GetCommand({ TableName: INVENTORY_TABLE, Key: { sku: it.sku } })
      );
      const available = Number(res.Item?.quantity ?? 0);
      if (!res.Item || available < it.qty) {
        outOfStock.push({
          sku: it.sku,
          kind: it.kind,
          name: it.name,
          color: it.color || "",
          size: it.size || "",
          level: it.level || "",
          requested: it.qty,
          available,
        });
      }
    })
  );
  return outOfStock;
}

function formatOutOfStockMessage(outOfStock) {
  if (!outOfStock.length) {
    return "One or more items are out of stock. Refresh and try again.";
  }
  const parts = outOfStock.map((it) => {
    const detail =
      it.kind === "merch"
        ? [it.color, it.size].filter(Boolean).join(" · ")
        : [it.level, "level"].filter(Boolean).join(" ");
    const label = detail ? `${it.name} (${detail})` : it.name;
    return `${label}: ${it.available} left (you asked for ${it.requested})`;
  });
  return `Out of stock: ${parts.join("; ")}`;
}

async function handleGetOrder(event, user) {
  const qs = event.queryStringParameters || {};
  const orderID = String(qs.orderId || qs.orderID || "").trim();
  if (!orderID) return json(400, { error: "orderId is required." });

  const res = await ddb.send(
    new GetCommand({ TableName: ORDERS_TABLE, Key: { orderID } })
  );
  if (!res.Item) return json(404, { error: "Order not found." });
  if (res.Item.userSub !== user.sub) {
    return json(403, { error: "You do not have access to this order." });
  }
  return json(200, { order: res.Item });
}

async function handlePlace(event, user) {
  if (!user.emailVerified) {
    return json(403, { error: "Verify your email before placing an order." });
  }
  if (!user.profileComplete) {
    return json(403, {
      error: "Complete your profile before placing an order.",
      code: "PROFILE_INCOMPLETE",
    });
  }

  const body = parseBody(event);
  const studentNumber = String(body.studentNumber || user.studentNumber || "").trim();
  if (!studentNumber) {
    return json(400, { error: "Student number is required." });
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems.map(normalizeItem).filter(Boolean);
  if (!items.length) return json(400, { error: "Cart is empty or invalid." });

  // Merge duplicate SKUs
  const merged = new Map();
  for (const it of items) {
    const prev = merged.get(it.sku);
    if (prev) {
      if (it.kind === "locker") {
        return json(400, { error: "Only one locker per level SKU is allowed." });
      }
      prev.qty += it.qty;
    } else {
      merged.set(it.sku, { ...it });
    }
  }
  const lineItems = [...merged.values()];

  const precheck = await stockSnapshot(lineItems);
  if (precheck.length) {
    return json(409, {
      error: formatOutOfStockMessage(precheck),
      code: "INSUFFICIENT_STOCK",
      outOfStock: precheck,
    });
  }

  const cashSubtotal = lineItems.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const cardSubtotal = Math.round(cashSubtotal * CARD_SURCHARGE * 100) / 100;
  const orderID = randomUUID();
  const now = new Date().toISOString();

  const order = {
    orderID,
    userSub: user.sub,
    email: user.email,
    name: user.name,
    studentNumber,
    status: 1,
    items: lineItems.map(({ sku, ...rest }) => rest),
    cashSubtotal,
    cardSubtotal,
    createdAt: now,
    updatedAt: now,
  };

  const transactItems = [
    {
      Put: {
        TableName: ORDERS_TABLE,
        Item: order,
        ConditionExpression: "attribute_not_exists(orderID)",
      },
    },
    ...lineItems.map((it) => ({
      Update: {
        TableName: INVENTORY_TABLE,
        Key: { sku: it.sku },
        UpdateExpression: "SET quantity = quantity - :q, updatedAt = :u",
        ConditionExpression: "attribute_exists(sku) AND quantity >= :q",
        ExpressionAttributeValues: {
          ":q": it.qty,
          ":u": now,
        },
      },
    })),
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    console.error("TransactWrite failed", err);
    const msg = String(err?.name || err?.message || "");
    if (msg.includes("ConditionalCheckFailed") || msg.includes("TransactionCanceled")) {
      const outOfStock = await stockSnapshot(lineItems);
      return json(409, {
        error: formatOutOfStockMessage(outOfStock),
        code: "INSUFFICIENT_STOCK",
        outOfStock,
      });
    }
    return json(500, { error: "Could not place order. Try again." });
  }

  const buyerHtml = buildOrderEmailHtml({
    orderID,
    name: user.name,
    items: lineItems,
    cashSubtotal,
    cardSubtotal,
    status: 1,
  });
  const staffHtml = buildStaffEmailHtml(order);

  try {
    await sendEmail({
      to: user.email,
      subject: `CHBE order received — ${orderID}`,
      html: buyerHtml,
    });
  } catch (err) {
    console.error("Buyer email failed", err);
  }

  if (STAFF_EMAILS.length) {
    try {
      await sendEmail({
        to: STAFF_EMAILS,
        subject: `New CHBE order — ${orderID}`,
        html: staffHtml,
      });
    } catch (err) {
      console.error("Staff email failed", err);
    }
  }

  return json(201, { orderID, status: 1 });
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

    if (method === "GET" && (qs.inventory === "1" || qs.inventory === "true")) {
      return await handleInventory(event);
    }

    if (method === "GET" && (qs.list === "1" || qs.list === "true")) {
      const user = await requireUser(event);
      return await handleListOrders(user);
    }

    if (method === "GET" && (qs.orderId || qs.orderID)) {
      const user = await requireUser(event);
      return await handleGetOrder(event, user);
    }

    if (method === "POST") {
      const user = await requireUser(event);
      const body = parseBody(event);
      const action = String(body.action || "place").toLowerCase();
      if (action === "place") return await handlePlace(event, user);
      return json(400, { error: "Unknown action." });
    }

    return json(405, { error: "Method not allowed." });
  } catch (err) {
    const status = err?.status || 500;
    console.error(err);
    return json(status, { error: err?.message || "Server error." });
  }
}
