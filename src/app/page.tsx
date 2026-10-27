import Link from "next/link";
import { AppShell } from "../components/dev07/app-shell";
import { AuditList } from "../components/dev07/audit-list";

export default function HomePage() {
  return <AppShell><section className="home-heading"><div><p className="eyebrow">让项目沟通有据可循</p><h1>项目沟通与承诺审计智能体</h1><p>从项目沟通中整理证据、承诺、变更与冲突，<br className="desktop-break" />并生成可追溯的审计报告。</p></div><Link className="button button-primary" href="/audits/new"><span aria-hidden="true">＋</span>新建审计项目</Link></section>
    <div className="process-note"><span className="process-note-icon" aria-hidden="true">✓</span><p><strong>先检查隐私，再开始分析</strong><span>沟通内容先在本机审查。确认脱敏结果后，才进入 AI 分析。</span></p></div><AuditList /></AppShell>;
}
