/**
 * Seed DynamoDB `inventory` from merch.csv + lockers.csv via AWS CLI.
 * Usage: node aws/scripts/seed-inventory.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.INVENTORY_TABLE || "inventory";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function awsPath() {
  if (process.env.AWS_CLI) return process.env.AWS_CLI;
  if (process.platform === "win32") {
    const local = join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "Amazon",
      "AWSCLIV2",
      "aws.exe"
    );
    return local;
  }
  return "aws";
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else current += char;
  }
  values.push(current.trim());
  return values;
}

function readCsv(relPath) {
  const content = readFileSync(join(ROOT, relPath), "utf8");
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (values[i] || "").replace(/^"|"$/g, "");
    });
    return obj;
  });
}

function putItem(item) {
  const aws = awsPath();
  const payload = {
    sku: { S: item.sku },
    quantity: { N: String(item.quantity) },
    kind: { S: item.kind },
    productId: { S: item.productId },
    label: { S: item.label },
    name: { S: item.name || "" },
    updatedAt: { S: item.updatedAt },
  };
  if (item.color) payload.color = { S: item.color };

  const r = spawnSync(
    aws,
    [
      "dynamodb",
      "put-item",
      "--region",
      REGION,
      "--table-name",
      TABLE,
      "--item",
      JSON.stringify(payload),
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `put-item failed for ${item.sku}`);
  }
}

const now = new Date().toISOString();
const items = [];

for (const row of readCsv("public/merch/merch.csv")) {
  if (!row.ID) continue;
  const sizes = String(row.Sizes_Stock || "")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of sizes) {
    const [size, qtyStr] = part.split(":");
    if (!size) continue;
    items.push({
      sku: `merch#${row.ID}#${size.trim()}`,
      quantity: Math.max(0, parseInt(qtyStr || "0", 10) || 0),
      kind: "merch",
      productId: row.ID,
      label: size.trim(),
      name: row.Name || "",
      color: row.Color || "",
      updatedAt: now,
    });
  }
}

for (const row of readCsv("public/lockers/lockers.csv")) {
  if (!row.ID) continue;
  for (const [label, key] of [
    ["Top", "Availability_Top"],
    ["Mid", "Availability_Mid"],
    ["Bottom", "Availability_Bottom"],
  ]) {
    items.push({
      sku: `locker#${row.ID}#${label}`,
      quantity: Math.max(0, parseInt(row[key] || "0", 10) || 0),
      kind: "locker",
      productId: row.ID,
      label,
      name: row.Name || "",
      updatedAt: now,
    });
  }
}

console.log(`Seeding ${items.length} SKUs into ${TABLE} (${REGION})…`);
for (const item of items) {
  putItem(item);
  console.log(`  ${item.sku} = ${item.quantity}`);
}
console.log("Done.");
