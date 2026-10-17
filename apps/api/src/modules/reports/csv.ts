export type ReportRow = Record<string, string | null>;

// Quoting alone does not stop spreadsheet formulas, including whitespace prefixes.
export function csvCell(value: string | null): string {
  let text = value ?? '';
  if (/^[\s\p{Cc}]*[=+\-@]/u.test(text) || /^\p{Cc}/u.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeCsv(columns: string[], rows: ReportRow[]): string {
  return (
    '\ufeff' +
    [
      columns,
      ...rows.map((row) => columns.map((column) => row[column] ?? null)),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}
