import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return <><a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="app-header"><div className="header-inner">
      <Link className="brand" href="/" aria-label="项目沟通与承诺审计智能体 · 项目首页">
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 3h8l4 4v14H5V3h2ZM14 3v5h5M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        <span>项目审计<span className="brand-subtitle">沟通与承诺</span></span>
      </Link><nav aria-label="主导航"><Link className="header-link" href="/">项目列表</Link></nav>
      <span className="local-label"><span aria-hidden="true" />本机工作区</span>
    </div></header><main id="main-content" className="app-content">{children}</main>
    <footer className="app-footer">项目沟通与承诺审计智能体 · 本地隐私检查，确认后开始分析</footer>
  </>;
}
