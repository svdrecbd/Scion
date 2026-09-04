export function csvCell(value: unknown): string {
  const normalized = value == null ? "" : String(value);
  const formulaSafe = /^[=+\-@\t\r]/.test(normalized) ? `'${normalized}` : normalized;
  return /[",\r\n]/.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

export function csvDocument(rows: unknown[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
