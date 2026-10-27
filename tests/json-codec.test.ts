import assert from "node:assert/strict";
import test from "node:test";

import { jsonFieldCodecs } from "../src/db/persistence/json-codec.js";
import { PersistenceBoundaryError } from "../src/db/persistence/persistence-types.js";

const expectCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    return error instanceof PersistenceBoundaryError && error.code === code;
  });
};

test("codec basic: valid encode/decode", () => {
  const encoded = jsonFieldCodecs.commitmentEvidenceIds.encode(["ev_1"]);
  assert.deepEqual(jsonFieldCodecs.commitmentEvidenceIds.decode(encoded), ["ev_1"]);
});

test("codec basic: malformed JSON is JSON_CODEC_ERROR", () => {
  expectCode(
    () => jsonFieldCodecs.commitmentEvidenceIds.decode("{not-json"),
    "JSON_CODEC_ERROR",
  );
});

test("codec basic: valid JSON wrong shape is PERSISTENCE_INTEGRITY_ERROR", () => {
  expectCode(
    () => jsonFieldCodecs.commitmentEvidenceIds.decode(JSON.stringify({ evidence: "ev_1" })),
    "PERSISTENCE_INTEGRITY_ERROR",
  );
});

test("codec basic: unknown forbidden field is rejected", () => {
  expectCode(
    () => jsonFieldCodecs.canonicalMetadata.encode({ forbidden: "x" }),
    "DOMAIN_VALIDATION_ERROR",
  );
});

test("codec basic: JSON text null is not SQL NULL and is rejected", () => {
  expectCode(
    () => jsonFieldCodecs.canonicalMetadata.decode("null"),
    "PERSISTENCE_INTEGRITY_ERROR",
  );
});

test("codec basic: undefined / BigInt fail explicitly", () => {
  expectCode(() => jsonFieldCodecs.canonicalMetadata.encode(undefined), "DOMAIN_VALIDATION_ERROR");
  expectCode(
    () => jsonFieldCodecs.providerOutputCounts.encode({ evidence: 1n }),
    "DOMAIN_VALIDATION_ERROR",
  );
});

test("codec basic: array order is preserved", () => {
  const value = ["ev_2", "ev_1"];
  assert.deepEqual(
    jsonFieldCodecs.commitmentEvidenceIds.decode(
      jsonFieldCodecs.commitmentEvidenceIds.encode(value),
    ),
    value,
  );
});

test("codec basic: object key byte order is not semantic", () => {
  const a = { evidence: 1, commitments: 2 };
  const b = { commitments: 2, evidence: 1 };
  const da = jsonFieldCodecs.providerOutputCounts.decode(
    jsonFieldCodecs.providerOutputCounts.encode(a),
  );
  const db = jsonFieldCodecs.providerOutputCounts.decode(
    jsonFieldCodecs.providerOutputCounts.encode(b),
  );
  assert.deepEqual(da, db);
});

const fieldCases = [
  {
    name: "canonical_records.metadata_json",
    codec: jsonFieldCodecs.canonicalMetadata,
    valid: {},
    invalid: { unknown: "x" },
  },
  {
    name: "privacy_mappings.aliases_json",
    codec: jsonFieldCodecs.privacyMappingAliases,
    valid: ["Synthetic Alias"],
    invalid: [1],
  },
  {
    name: "commitments.evidence_ids_json",
    codec: jsonFieldCodecs.commitmentEvidenceIds,
    valid: ["ev_1"],
    invalid: [],
  },
  {
    name: "commitments.status_evidence_ids_json",
    codec: jsonFieldCodecs.commitmentStatusEvidenceIds,
    valid: [],
    invalid: ["not-an-evidence-id"],
  },
  {
    name: "changes.evidence_ids_json",
    codec: jsonFieldCodecs.changeEvidenceIds,
    valid: ["ev_1"],
    invalid: [],
  },
  {
    name: "conflicts.claim_a_evidence_ids_json",
    codec: jsonFieldCodecs.conflictClaimAEvidenceIds,
    valid: ["ev_1"],
    invalid: [],
  },
  {
    name: "conflicts.claim_b_evidence_ids_json",
    codec: jsonFieldCodecs.conflictClaimBEvidenceIds,
    valid: ["ev_2"],
    invalid: [],
  },
  {
    name: "conflicts.counter_evidence_ids_json",
    codec: jsonFieldCodecs.conflictCounterEvidenceIds,
    valid: [],
    invalid: ["not-an-evidence-id"],
  },
  {
    name: "conflicts.alternative_explanations_json",
    codec: jsonFieldCodecs.conflictAlternativeExplanations,
    valid: [{ text: "Synthetic alternative", epistemic_status: "INFERENCE" }],
    invalid: [{ text: "Synthetic alternative", epistemic_status: "FACT" }],
  },
  {
    name: "conflicts.missing_evidence_json",
    codec: jsonFieldCodecs.conflictMissingEvidence,
    valid: ["Synthetic missing item"],
    invalid: [""],
  },
  {
    name: "provider_calls.output_counts_json",
    codec: jsonFieldCodecs.providerOutputCounts,
    valid: { evidence: 1, commitments: 2, unknown: 0 },
    invalid: { evidence: -1 },
  },
] as const;

test("all 11 JSON TEXT fields have valid round-trip and invalid-shape rejection", () => {
  assert.equal(fieldCases.length, 11);
  for (const item of fieldCases) {
    const encoded = item.codec.encode(item.valid);
    assert.doesNotThrow(() => item.codec.decode(encoded), item.name);
    expectCode(() => item.codec.encode(item.invalid), "DOMAIN_VALIDATION_ERROR");
  }
});
