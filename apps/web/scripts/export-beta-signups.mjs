import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const remote = process.argv.includes("--remote");
const outputArg = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath = resolve(outputArg?.slice("--output=".length) || "beta-signups.csv");
const query = `SELECT created_at, email, first_name, last_name, affiliation, source_path, consent_text_version
  FROM beta_signups ORDER BY created_at DESC`;
const args = [
  "wrangler", "d1", "execute", "SIGNUPS_DB", remote ? "--remote" : "--local",
  "--config", "wrangler.jsonc", "--command", query, "--json"
];
const raw = execFileSync("npx", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
const result = JSON.parse(raw);
const rows = result.flatMap((entry) => entry.results ?? []);

function csvCell(value) {
  const normalized = value == null ? "" : String(value);
  const formulaSafe = /^[=+\-@\t\r]/.test(normalized) ? `'${normalized}` : normalized;
  return /[",\r\n]/.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

const fields = [
  ["Created At", "created_at"],
  ["Email", "email"],
  ["First Name", "first_name"],
  ["Last Name", "last_name"],
  ["Affiliation", "affiliation"],
  ["Source Path", "source_path"],
  ["Consent Text Version", "consent_text_version"]
];
const lines = [
  fields.map(([label]) => csvCell(label)).join(","),
  ...rows.map((row) => fields.map(([, key]) => csvCell(row[key])).join(","))
];
await writeFile(outputPath, `${lines.join("\r\n")}\r\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Exported ${rows.length} signup records to ${outputPath} (${remote ? "remote" : "local"} D1).`);
