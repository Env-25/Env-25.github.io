import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Locker {
  ID: string;
  Name: string;
  Desc: string;
  Location: string;
  Size: string;
  Price: number;
  Availability_Top: number;
  Availability_Mid: number;
  Availability_Bottom: number;
  Rental_Term: string;
  Lock_Included: boolean;
  Cover_photo: string;
  Add_photos: string[];
  slug: string;
  totalAvailable: number;
  width: number;
  height: number;
  depth: number;
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

export function getLockers(): Locker[] {
  const csvPath = join(process.cwd(), "public/lockers/lockers.csv");
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || "").replace(/^"|"$/g, "");
    });

    const addPhotos = obj.Add_photos
      ? obj.Add_photos.split("|").map((s) => s.trim()).filter(Boolean)
      : [];

    const dims = obj.Size.split("x").map((n) => parseInt(n, 10));

    const top    = parseInt(obj.Availability_Top    ?? "0", 10);
    const mid    = parseInt(obj.Availability_Mid    ?? "0", 10);
    const bottom = parseInt(obj.Availability_Bottom ?? "0", 10);

    return {
      ID:                  obj.ID,
      Name:                obj.Name,
      Desc:                obj.Desc,
      Location:            obj.Location,
      Size:                obj.Size,
      Price:               parseFloat(obj.Price) || 0,
      Availability_Top:    top,
      Availability_Mid:    mid,
      Availability_Bottom: bottom,
      Rental_Term:         obj.Rental_Term,
      Lock_Included:       obj.Lock_Included === "Yes",
      Cover_photo:         obj.Cover_photo,
      Add_photos:          addPhotos,
      slug:                nameToSlug(obj.Name),
      totalAvailable:      top + mid + bottom,
      width:               dims[0] ?? 0,
      height:              dims[1] ?? 0,
      depth:               dims[2] ?? 0,
    } as Locker;
  });
}

export function getLockerBySlug(slug: string): Locker | undefined {
  return getLockers().find((l) => l.slug === slug);
}

export function getLockerLocations(): string[] {
  return [...new Set(getLockers().map((l) => l.Location))].sort();
}

export function getLockerSizes(): string[] {
  const order = ["8x12x24", "10x12x18", "12x18x18", "12x18x24", "14x20x30"];
  const all = new Set(getLockers().map((l) => l.Size));
  const sorted = order.filter((s) => all.has(s));
  all.forEach((s) => { if (!sorted.includes(s)) sorted.push(s); });
  return sorted;
}

export function getLockerTerms(): string[] {
  return [...new Set(getLockers().map((l) => l.Rental_Term))].sort();
}
