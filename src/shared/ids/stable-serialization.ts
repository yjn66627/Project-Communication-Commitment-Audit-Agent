/**
 * Stable canonical serialization for hash inputs.
 *
 * Supported values: string, finite number, boolean, null, arrays, plain objects.
 * Object keys are sorted by Unicode code-point order. Array order is preserved.
 * undefined, Date, BigInt, symbol, function and non-plain objects are rejected.
 */
export type StableScalar = string | number | boolean | null;
export type StableValue =
  | StableScalar
  | readonly StableValue[]
  | { readonly [key: string]: StableValue };

export function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const aCodePoint = a[index]?.codePointAt(0);
    const bCodePoint = b[index]?.codePointAt(0);
    if (aCodePoint === undefined || bCodePoint === undefined) {
      break;
    }
    if (aCodePoint !== bCodePoint) {
      return aCodePoint - bCodePoint;
    }
  }

  return a.length - b.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function stableCanonicalSerialize(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Stable serialization rejects non-finite numbers.");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "undefined":
      throw new TypeError("Stable serialization rejects undefined.");
    case "bigint":
      throw new TypeError("Stable serialization rejects BigInt.");
    case "function":
      throw new TypeError("Stable serialization rejects functions.");
    case "symbol":
      throw new TypeError("Stable serialization rejects symbols.");
    case "object":
      break;
    default:
      throw new TypeError("Unsupported stable serialization value.");
  }

  if (value instanceof Date) {
    throw new TypeError("Stable serialization rejects Date; provide an explicit ISO string.");
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableCanonicalSerialize(entry)).join(",")}]`;
  }

  if (!isPlainObject(value)) {
    throw new TypeError("Stable serialization accepts plain objects only.");
  }

  const keys = Object.keys(value).sort(compareUnicodeCodePoints);
  const entries = keys.map((key) => {
    const entry = value[key];
    if (entry === undefined) {
      throw new TypeError(`Stable serialization rejects undefined at key: ${key}`);
    }
    return `${JSON.stringify(key)}:${stableCanonicalSerialize(entry)}`;
  });
  return `{${entries.join(",")}}`;
}
