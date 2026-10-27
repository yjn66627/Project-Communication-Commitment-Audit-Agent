import { AppShell } from "../../../components/dev07/app-shell";
import { AuditWorkspace } from "../../../components/dev07/audit-workspace";

export default async function AuditPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;
  return <AppShell><AuditWorkspace key={auditId} auditId={auditId} /></AppShell>;
}
