import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SizeStock {
  size: string;
  stock: number;
}

export interface MerchItem {
  ID: string;
  Name: string;
  Type: string;
  Desc: string;
  Price: number;
  Sizes_Stock: SizeStock[];
  Cover_image: string;
  Additional_images: string[];
  slug: string;
  inStock: boolean;
  allSizes: string[];
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

export function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function getMerch(): MerchItem[] {
  const csvPath = join(process.cwd(), "public/merch/merch.csv");
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || "").replace(/^"|"$/g, "");
    });

    // Parse "XS:10|S:15|M:8" into SizeStock[]
    const sizesStock: SizeStock[] = obj.Sizes_Stock
      ? obj.Sizes_Stock.split("|").map((entry) => {
          const [size, stockStr] = entry.split(":");
          return { size: size.trim(), stock: parseInt(stockStr ?? "0", 10) };
        })
      : [];

    const additionalImages = obj.Additional_images
      ? obj.Additional_images.split("|").map((s) => s.trim()).filter(Boolean)
      : [];

    const inStock = sizesStock.some((s) => s.stock > 0);
    const allSizes = sizesStock.map((s) => s.size);

    return {
      ID: obj.ID,
      Name: obj.Name,
      Type: obj.Type,
      Desc: obj.Desc,
      Price: parseFloat(obj.Price) || 0,
      Sizes_Stock: sizesStock,
      Cover_image: obj.Cover_image,
      Additional_images: additionalImages,
      slug: nameToSlug(obj.Name),
      inStock,
      allSizes,
    } as MerchItem;
  });
}

export function getMerchBySlug(slug: string): MerchItem | undefined {
  return getMerch().find((item) => item.slug === slug);
}

// All unique types across all items
export function getMerchTypes(): string[] {
  const items = getMerch();
  return [...new Set(items.map((i) => i.Type))].sort();
}

// All unique sizes across all items
export function getMerchSizes(): string[] {
  const items = getMerch();
  const sizeOrder = ["XS", "S", "M", "L", "XL", "XXL", "One Size"];
  const all = new Set(items.flatMap((i) => i.allSizes));
  return sizeOrder.filter((s) => all.has(s));
}
