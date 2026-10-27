export function normalizeNfkc(value: string): string {
  return value.normalize("NFKC");
}

export function collapseUnicodeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ");
}

export function normalizeNamedEntity(value: string): string {
  return collapseUnicodeWhitespace(normalizeNfkc(value).trim());
}
