import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SizeStock {
  size: string;
  stock: number;
}

export interface ColorVariant {
  color: string;
  slug: string;
  cover_image: string;
  additional_images: string[];   // all extra images for this colour
  inStock: boolean;
}

export interface MerchItem {
  ID: string;
  Name: string;
  Type: string;
  Type_id: string;
  Color: string;
  Desc: string;
  Price: number;
  Sizes_Stock: SizeStock[];
  Cover_image: string;
  Additional_images: string[];
  slug: string;
  inStock: boolean;
  allSizes: string[];
  colorVariants: ColorVariant[];
}

// ── Colour → CSS hex ──────────────────────────────────────────────────────────
const COLOR_CSS_MAP: Record<string, string> = {
  black: "#111111", "off black": "#1c1c1e", charcoal: "#3b3f42",
  "dark charcoal": "#2b2e31", graphite: "#4b4f54", slate: "#54667a",
  ash: "#b2b5b8", silver: "#a8a9ad", grey: "#888888", gray: "#888888",
  "light grey": "#c8cacc", "light gray": "#c8cacc",
  "heather grey": "#9ba0a6", "heather gray": "#9ba0a6",
  white: "#e8e8e8", "off white": "#f0ede6", cream: "#e8e0cc",
  natural: "#d9cdb8", sand: "#c2aa88", stone: "#b5a899",
  tan: "#c8a46e", khaki: "#c3a97e", beige: "#c9b99a",
  navy: "#1b2a4a", "dark navy": "#111d33", "royal blue": "#2851b8",
  blue: "#1a5fb4", "light blue": "#5b9bd5", "sky blue": "#5aa7d6",
  "steel blue": "#4577a2", cobalt: "#0047ab", carolina: "#4b9cd3",
  columbia: "#c4d8e2", "baby blue": "#89c4e1", denim: "#1560bd",
  indigo: "#3f51b5",
  green: "#2d8a2d", "forest green": "#228b22", forestgreen: "#228b22",
  forest: "#228b22", "dark green": "#145214", "hunter green": "#355e3b",
  hunter: "#355e3b", olive: "#6b7c37", "olive green": "#6b7c37",
  sage: "#87a878", mint: "#73c2a0", kelly: "#4cbb17",
  "kelly green": "#4cbb17", lime: "#8db600", teal: "#007070",
  "dark teal": "#004d4d", "sea green": "#2e8b57", aqua: "#00b4c8",
  turquoise: "#1baeb6", emerald: "#046307",
  red: "#c0392b", "dark red": "#8b0000", crimson: "#b30000",
  cardinal: "#9b1b30", maroon: "#6b0f1a", wine: "#722f37",
  burgundy: "#800020", raspberry: "#c0306a", pink: "#d96ba0",
  "hot pink": "#e91e8c", "light pink": "#f4a7c0", blush: "#e8a0a8",
  coral: "#e8634a", salmon: "#f08070", rose: "#c96480",
  yellow: "#f0c400", gold: "#c8920a", "old gold": "#c8920a",
  "athletic gold": "#d4a017", orange: "#e07800", "burnt orange": "#c84b00",
  purple: "#6a0dad", "dark purple": "#4a0080", violet: "#7c3aed",
  lavender: "#a07ab8", plum: "#5e2750",
  brown: "#7a4520", mocha: "#7c5843", chocolate: "#6b3a2a",
};

export function colorToCSS(name: string): string {
  const lower = name.trim().toLowerCase();
  if (COLOR_CSS_MAP[lower]) return COLOR_CSS_MAP[lower];
  if (lower.startsWith("heather ")) {
    const base = lower.slice(8);
    if (COLOR_CSS_MAP[base]) return COLOR_CSS_MAP[base];
  }
  for (const prefix of ["dark ", "light ", "bright ", "deep ", "pale "]) {
    if (lower.startsWith(prefix)) {
      const base = lower.slice(prefix.length);
      if (COLOR_CSS_MAP[base]) return COLOR_CSS_MAP[base];
    }
  }
  return "#9ca3af";
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === "," && !inQuotes) { values.push(current.trim()); current = ""; }
    else { current += char; }
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
  const lines   = content.trim().split("\n");

  // Normalise all header keys to lowercase → fixes "type_id" vs "Type_id" mismatch
  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());

  const rawItems: MerchItem[] = lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || "").replace(/^"|"$/g, ""); });

    const sizesStock: SizeStock[] = obj["sizes_stock"]
      ? obj["sizes_stock"].split("|").map((e) => {
          const [size, s] = e.split(":");
          return { size: size.trim(), stock: parseInt(s ?? "0", 10) };
        })
      : [];

    const additionalImages = obj["additional_images"]
      ? obj["additional_images"].split("|").map((s) => s.trim()).filter(Boolean)
      : [];

    const inStock  = sizesStock.some((s) => s.stock > 0);
    const allSizes = sizesStock.map((s) => s.size);
    const typeId   = obj["type_id"]?.trim() || obj["id"];

    return {
      ID: obj["id"], Name: obj["name"], Type: obj["type"],
      Type_id: typeId, Color: (obj["color"] || "").trim(),
      Desc: obj["desc"], Price: parseFloat(obj["price"]) || 0,
      Sizes_Stock: sizesStock, Cover_image: obj["cover_image"],
      Additional_images: additionalImages,
      slug: nameToSlug(obj["name"]),
      inStock, allSizes, colorVariants: [],
    } as MerchItem;
  });

  // Build colorVariants (now including additional_images per variant)
  const variantsByTypeId = new Map<string, ColorVariant[]>();
  rawItems.forEach((item) => {
    if (!variantsByTypeId.has(item.Type_id)) variantsByTypeId.set(item.Type_id, []);
    variantsByTypeId.get(item.Type_id)!.push({
      color:             item.Color,
      slug:              item.slug,
      cover_image:       item.Cover_image,
      additional_images: item.Additional_images,
      inStock:           item.inStock,
    });
  });

  return rawItems.map((item) => ({
    ...item,
    colorVariants: variantsByTypeId.get(item.Type_id) ?? [],
  }));
}

/** One card per Type_id (first row). allSizes merged from all variants. */
export function getGroupedMerch(): MerchItem[] {
  const items = getMerch();
  const seen  = new Set<string>();
  return items
    .filter((item) => { if (seen.has(item.Type_id)) return false; seen.add(item.Type_id); return true; })
    .map((rep) => ({
      ...rep,
      allSizes: [...new Set(
        items.filter((i) => i.Type_id === rep.Type_id).flatMap((i) => i.allSizes)
      )],
    }));
}

export function getMerchBySlug(slug: string): MerchItem | undefined {
  return getMerch().find((item) => item.slug === slug);
}

export function getMerchTypes(): string[] {
  return [...new Set(getMerch().map((i) => i.Type))].sort();
}

export function getMerchSizes(): string[] {
  const sizeOrder = ["XS", "S", "M", "L", "XL", "XXL", "One Size"];
  const all = new Set(getMerch().flatMap((i) => i.allSizes));
  const known   = sizeOrder.filter((s) => all.has(s));
  const unknown = [...all].filter((s) => !sizeOrder.includes(s)).sort();
  return [...known, ...unknown];
}

export function getMerchColors(): string[] {
  return [...new Set(getMerch().map((i) => i.Color).filter(Boolean))].sort();
}
