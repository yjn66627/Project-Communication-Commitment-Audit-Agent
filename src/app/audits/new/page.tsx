import Link from "next/link";
import { AppShell } from "../../../components/dev07/app-shell";
import { NewAuditForm } from "../../../components/dev07/new-audit-form";

export default function NewAuditPage() {
  return <AppShell><div className="narrow-page"><Link className="back-link" href="/">← 返回项目列表</Link><div className="page-heading"><p className="eyebrow">开始一次项目审计</p><h1>新建审计项目</h1><p>先创建项目，再导入需要审查的沟通记录。</p></div><NewAuditForm /></div></AppShell>;
}
