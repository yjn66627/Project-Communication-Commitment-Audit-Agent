import assert from "node:assert/strict";
import { test } from "node:test";

import { stableCanonicalSerialize } from "../../src/shared/ids/stable-serialization.js";

test("stable serializer sorts object keys recursively", () => {
  const left = { z: 1, a: { y: true, b: "x" } };
  const right = { a: { b: "x", y: true }, z: 1 };
  assert.equal(stableCanonicalSerialize(left), stableCanonicalSerialize(right));
});

test("stable serializer preserves array order", () => {
  assert.notEqual(
    stableCanonicalSerialize(["a", "b"]),
    stableCanonicalSerialize(["b", "a"]),
  );
});

test("stable serializer rejects undefined, Date and BigInt", () => {
  assert.throws(() => stableCanonicalSerialize({ a: undefined }), /undefined/);
  assert.throws(() => stableCanonicalSerialize(new Date()), /Date/);
  assert.throws(() => stableCanonicalSerialize(1n), /BigInt/);
});
