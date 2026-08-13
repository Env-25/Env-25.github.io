import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChbeEvent {
  ID: string;
  Name: string;
  StartDate: string;
  StartTime: string;
  EndDate: string;
  EndTime: string;
  Location: string;
  Image: string;
  Email: string;
  CalendarLink: string;
  Desc: string;
  slug: string;
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

export function getEvents(): ChbeEvent[] {
  const csvPath = join(process.cwd(), "public/events/events.csv");
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || "").replace(/^"|"$/g, "");
    });
    if (!obj.Email) obj.Email = "contact@chbe.ubc.ca";
    if (!obj.EndDate) obj.EndDate = obj.StartDate || "";
    return { ...obj, slug: nameToSlug(obj.Name) } as ChbeEvent;
  });
}
