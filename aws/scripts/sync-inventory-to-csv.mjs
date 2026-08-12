/**
 * Pull live stock from DynamoDB `inventory` into merch.csv + lockers.csv.
 * Opposite of seed-inventory.mjs (CSV → Dynamo).
 *
 * Usage: node aws/scripts/sync-inventory-to-csv.mjs
 * Env:   AWS_REGION (default us-east-2), INVENTORY_TABLE (default inventory)
 *
 * Exits 0 always on success. Prints CHANGED=1 if CSVs were updated, CHANGED=0 otherwise.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.INVENTORY_TABLE || "inventory";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MERCH_CSV = "public/merch/merch.csv";
const LOCKERS_CSV = "public/lockers/lockers.csv";

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

function escapeCsvField(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function readCsv(relPath) {
  const content = readFileSync(join(ROOT, relPath), "utf8");
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (values[i] || "").replace(/^"|"$/g, "");
    });
    return obj;
  });
  return { headers, rows };
}

function writeCsv(relPath, headers, rows) {
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escapeCsvField(row[h] ?? "")).join(",")),
  ];
  writeFileSync(join(ROOT, relPath), lines.join("\n") + "\n", "utf8");
}

function scanInventory() {
  const aws = awsPath();
  const stock = {};
  let startKey = null;

  do {
    const args = [
      "dynamodb",
      "scan",
      "--region",
      REGION,
      "--table-name",
      TABLE,
      "--projection-expression",
      "sku,quantity",
      "--output",
      "json",
    ];
    if (startKey) {
      args.push("--exclusive-start-key", JSON.stringify(startKey));
    }

    const r = spawnSync(aws, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(r.stderr || r.stdout || "dynamodb scan failed");
    }

    const data = JSON.parse(r.stdout || "{}");
    for (const item of data.Items || []) {
      const sku = item.sku?.S;
      if (!sku) continue;
      stock[sku] = Math.max(0, parseInt(item.quantity?.N ?? "0", 10) || 0);
    }
    startKey = data.LastEvaluatedKey || null;
  } while (startKey);

  return stock;
}

function syncMerch(stock) {
  const { headers, rows } = readCsv(MERCH_CSV);
  if (!headers.includes("Sizes_Stock") || !headers.includes("ID")) {
    throw new Error(`${MERCH_CSV} missing ID or Sizes_Stock column`);
  }

  let changed = false;
  const updates = [];

  for (const row of rows) {
    if (!row.ID) continue;
    const raw = String(row.Sizes_Stock || "").trim();
    if (!raw) continue;

    const parts = raw
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    const nextParts = parts.map((part) => {
      const colon = part.indexOf(":");
      const size = (colon >= 0 ? part.slice(0, colon) : part).trim();
      const prevQty = colon >= 0 ? part.slice(colon + 1).trim() : "0";
      if (!size) return part;
      const sku = `merch#${row.ID}#${size}`;
      if (!Object.prototype.hasOwnProperty.call(stock, sku)) return part;
      const qty = String(stock[sku]);
      if (qty !== prevQty) {
        changed = true;
        updates.push(`${sku}: ${prevQty} → ${qty}`);
      }
      return `${size}:${qty}`;
    });

    row.Sizes_Stock = nextParts.join("|");
  }

  if (changed) writeCsv(MERCH_CSV, headers, rows);
  return updates;
}

function syncLockers(stock) {
  const { headers, rows } = readCsv(LOCKERS_CSV);
  const levelCols = [
    ["Top", "Availability_Top"],
    ["Mid", "Availability_Mid"],
    ["Bottom", "Availability_Bottom"],
  ];
  for (const [, col] of levelCols) {
    if (!headers.includes(col)) {
      throw new Error(`${LOCKERS_CSV} missing ${col} column`);
    }
  }
  if (!headers.includes("ID")) {
    throw new Error(`${LOCKERS_CSV} missing ID column`);
  }

  let changed = false;
  const updates = [];

  for (const row of rows) {
    if (!row.ID) continue;
    for (const [level, col] of levelCols) {
      const sku = `locker#${row.ID}#${level}`;
      if (!Object.prototype.hasOwnProperty.call(stock, sku)) continue;
      const prev = String(row[col] ?? "");
      const qty = String(stock[sku]);
      if (qty !== prev) {
        changed = true;
        updates.push(`${sku}: ${prev} → ${qty}`);
        row[col] = qty;
      }
    }
  }

  if (changed) writeCsv(LOCKERS_CSV, headers, rows);
  return updates;
}

const stock = scanInventory();
const skuCount = Object.keys(stock).length;
console.log(`Scanned ${skuCount} SKUs from ${TABLE} (${REGION})`);

const merchUpdates = syncMerch(stock);
const lockerUpdates = syncLockers(stock);
const all = [...merchUpdates, ...lockerUpdates];

if (!all.length) {
  console.log("No CSV changes.");
  console.log("CHANGED=0");
  process.exit(0);
}

console.log(`Updated ${all.length} quantity field(s):`);
for (const line of all) console.log(`  ${line}`);
console.log("CHANGED=1");
