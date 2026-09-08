import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Resource {
  title: string;
  description: string;
  href: string;
  icon: string;
  alt: string;
}

function parseLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += character;
  }
  values.push(value.trim());
  return values;
}

export function getResources(): Resource[] {
  const content = readFileSync(join(process.cwd(), "public/resources/resources.csv"), "utf8");
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseLine(lines[0] || "");
  return lines.slice(1).map((line) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] || ""]));
    return {
      title: row.Title,
      description: row.Description,
      href: row.Href,
      icon: `/resources/${row.Icon}`,
      alt: row.Alt || row.Title,
    };
  }).filter((resource) => resource.title && resource.href);
}
