import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Catalog from "./Catalog";
import { applyTheme, readThemePreference } from "./theme";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";

const Admin = lazy(() => import("./Admin"));
applyTheme(readThemePreference());
const admin = document.documentElement.dataset.mode === "admin";
document.title = admin ? "Cerium · 管理工作台" : "Cerium · 中转站目录";
createRoot(document.getElementById("root")!).render(
  admin ? (
    <Suspense fallback={<p className="loading">正在加载管理面板…</p>}>
      <Admin />
    </Suspense>
  ) : (
    <Catalog />
  ),
);
