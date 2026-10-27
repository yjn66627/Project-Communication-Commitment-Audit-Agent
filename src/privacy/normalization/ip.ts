import { isIP } from "node:net";

function parseIpv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  return parts.length === 4 ? parts : null;
}

function expandIpv6(value: string): number[] | null {
  if (value.includes("%") || isIP(value) !== 6) return null;
  let source = value.toLowerCase();
  let ipv4Tail: number[] | null = null;
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    ipv4Tail = parseIpv4(tail);
    if (!ipv4Tail) return null;
    source = `${source.slice(0, lastColon)}:${((ipv4Tail[0]! << 8) | ipv4Tail[1]!).toString(16)}:${((ipv4Tail[2]! << 8) | ipv4Tail[3]!).toString(16)}`;
  }

  const double = source.indexOf("::");
  if (double !== -1 && double !== source.lastIndexOf("::")) return null;
  const left = (double === -1 ? source : source.slice(0, double)).split(":").filter(Boolean);
  const right = (double === -1 ? "" : source.slice(double + 2)).split(":").filter(Boolean);
  const explicit = left.length + right.length;
  const zeroCount = double === -1 ? 0 : 8 - explicit;
  if ((double === -1 && explicit !== 8) || (double !== -1 && zeroCount < 1)) return null;
  const groups = [...left, ...Array<string>(zeroCount).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function compressIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
  if (!left && !right) return "::";
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

export function normalizeIpCandidate(value: string): string | null {
  if (value.includes("%")) return null;
  if (isIP(value) === 4) {
    return value.split(".").map((part) => String(Number(part))).join(".");
  }
  const groups = expandIpv6(value);
  return groups ? compressIpv6(groups) : null;
}
