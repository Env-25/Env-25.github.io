import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Member {
  ID: string;
  Name: string;
  Title: string;
  Image: string;
  Bio: string;
  Contact: string;
  LinkedIn: string;
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

export function getMembers(year: string = "2026"): Member[] {
  const csvPath = join(process.cwd(), `public/council/${year}/members.csv`);
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || "").replace(/^"|"$/g, "");
    });
    return { ...obj, slug: nameToSlug(obj.Name) } as Member;
  });
}
