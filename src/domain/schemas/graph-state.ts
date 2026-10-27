import { z } from "zod";

import { AuditIdSchema, PrivacyRevisionIdSchema, ReportVersionIdSchema } from "./base.js";
import { SanitizedCanonicalRecordRevisionSchema } from "./canonical.js";
import { ChangeSchema } from "./change.js";
import { CommitmentSchema } from "./commitment.js";
import { PotentialConflictSchema } from "./conflict.js";
import { EvidenceSchema } from "./evidence.js";
import { MissingEvidenceSchema } from "./report.js";

export const AuditGraphStateSchema = z.object({
  audit_id: AuditIdSchema,
  report_version_id: ReportVersionIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  sanitized_records: z.array(SanitizedCanonicalRecordRevisionSchema).min(1),
  evidence: z.array(EvidenceSchema),
  commitments: z.array(CommitmentSchema),
  changes: z.array(ChangeSchema),
  conflicts: z.array(PotentialConflictSchema),
  missing_evidence: z.array(MissingEvidenceSchema),
  stage_errors: z.array(z.object({
    stage: z.string().min(1),
    code: z.string().min(1),
  }).strict()),
}).strict();

export type AuditGraphState = z.infer<typeof AuditGraphStateSchema>;
