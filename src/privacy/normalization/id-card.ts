import { normalizeNfkc } from "./common.js";

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const CHECK_CODES = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

function isValidDate(yyyymmdd: string): boolean {
  if (!/^\d{8}$/u.test(yyyymmdd)) return false;
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (year < 1800 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeAndValidatePrcResidentId(value: string): string | null {
  const normalized = normalizeNfkc(value).replace(/x$/u, "X");
  if (!/^\d{17}[\dX]$/u.test(normalized)) return null;
  if (!isValidDate(normalized.slice(6, 14))) return null;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(normalized[index]) * WEIGHTS[index]!;
  }
  return CHECK_CODES[sum % 11] === normalized[17] ? normalized : null;
}
