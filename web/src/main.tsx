import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import Catalog from "./Catalog";
import { applyTheme, readThemePreference } from "./theme";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";

const Admin = lazy(() => import("./Admin"));

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Cerium application failed to render", error, info);
  }

  render() {
    if (this.state.hasError)
      return (
        <main className="app-error" role="alert">
          <h1>页面加载失败。</h1>
          <p>管理面板或目录资源没有正确加载，请刷新页面后重试。</p>
          <button type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </main>
      );
    return this.props.children;
  }
}

applyTheme(readThemePreference());
const admin = document.documentElement.dataset.mode === "admin";
document.title = admin ? "Cerium · 管理工作台" : "Cerium · 中转站目录";
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {admin ? (
      <Suspense fallback={<p className="loading">正在加载管理面板…</p>}>
        <Admin />
      </Suspense>
    ) : (
      <Catalog />
    )}
  </AppErrorBoundary>,
);
