import { useEffect, useState } from "react";
import { Button, Input, Skeleton, TextField } from "@heroui/react";
import { api, message } from "./api";
import { Empty, Glyph, Header, IconButton, Select } from "./ui";
import { lowestRate } from "./relay";
import { FamilyFilters, RateFilter } from "./GroupFilters";
import {
  matchesGroup,
  minimumRate,
  type FamilyFilter,
  type RateRange,
} from "./groups";
import { ChangeDetail, ChangesDialog } from "./Changes";
import { modelDisplayName } from "./model-display";
import { SiteCard } from "./SiteCard";
import { SiteDetails } from "./SiteDetails";
import type { ChangeNotice, Directory, Site } from "./types";

export { SiteDetails } from "./SiteDetails";

export default function CatalogPage() {
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [payment, setPayment] = useState("all");
  const [sort, setSort] = useState("default");
  const [family, setFamily] = useState<FamilyFilter>("all");
  const [range, setRange] = useState<RateRange>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  async function load() {
    setLoading(true);
    try {
      setData(await api<Directory>("/api/sites"));
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  const sites = data?.sites ?? [];
  const changes: ChangeNotice[] = data?.changes ?? [];
  const allGroups = sites.flatMap((site) => site.catalog?.groups ?? []);
  const groupFiltering = family !== "all" || range !== null;
  const matchingGroups = (site: Site) =>
    (site.catalog?.groups ?? []).filter((group) =>
      matchesGroup(group, family, range),
    );
  const siteMinimum = (site: Site) =>
    groupFiltering ? minimumRate(matchingGroups(site)) : lowestRate(site);
  const methods = [...new Set(sites.flatMap((site) => site.payment_methods))];
  const filtered = sites
    .filter(
      (site) =>
        (type === "all" || site.type === type) &&
        (payment === "all" || site.payment_methods.includes(payment)) &&
        (!groupFiltering || matchingGroups(site).length > 0) &&
        [
          site.name,
          site.url,
          site.description,
          ...(site.catalog?.groups ?? []).flatMap((group) => [
            group.name,
            ...group.models.flatMap((model) => [
              model,
              modelDisplayName(model),
            ]),
          ]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "rate"
        ? (siteMinimum(a) ?? Infinity) - (siteMinimum(b) ?? Infinity)
        : sort === "recent"
          ? (Date.parse(b.fetched_at ?? "") || 0) -
            (Date.parse(a.fetched_at ?? "") || 0)
          : 0,
    );
  const selectedSite = sites.find((site) => site.id === selected);
  const activeFilters = Boolean(
    query || type !== "all" || payment !== "all" || groupFiltering,
  );
  const clear = () => {
    setQuery("");
    setType("all");
    setPayment("all");
    setFamily("all");
    setRange(null);
  };
  return (
    <div className="shell catalog-shell">
      <Header onChanges={() => setShowChanges(true)} />
      {changes.length > 0 && (
        <section className="announcement" aria-label="倍率动态">
          <span className="announcement-icon">
            <Glyph name="activity" size={17} />
          </span>
          <span className="announcement-label">倍率动态</span>
          <div className="announcement-text">
            <strong>{changes[0].site_name}</strong>
            <ChangeDetail change={changes[0].details[0]} />
            {changes[0].details.length > 1 && (
              <span className="muted">
                等 {changes[0].details.length} 项变动
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => setShowChanges(true)}
          >
            查看动态
            <Glyph name="arrow-right" size={14} />
          </Button>
        </section>
      )}
      <main>
        <section className="intro">
          <div className="intro-copy">
            <div className="section-eyebrow">
              <span className="live-dot" />
              公开分组 · 持续同步
            </div>
            <h1>
              中转站目录<span>。</span>
            </h1>
            <p>按分组、模型和倍率，找到合适的入口。</p>
          </div>
          <div className="directory-count">
            <strong>
              {sites.length}
              <span>个</span>
            </strong>
            <p>已收录站点</p>
          </div>
        </section>
        <section
          id="directory"
          aria-label="中转站目录"
          className="directory-section"
        >
          <div className="catalog-toolbar">
            <TextField
              aria-label="搜索站点或模型"
              className="search"
              value={query}
              onChange={setQuery}
              variant="secondary"
            >
              <Glyph name="magnifier" />
              <Input placeholder="搜索站点、分组或模型…" />
            </TextField>
            <div className="filters">
              <Select
                label="站点类型"
                value={type}
                onChange={setType}
                options={[
                  { value: "all", label: "所有类型" },
                  { value: "newapi", label: "NewAPI" },
                  { value: "sub2api", label: "Sub2API" },
                  { value: "others", label: "独立站点" },
                ]}
              />
              <Select
                label="充值方式"
                value={payment}
                onChange={setPayment}
                options={[
                  { value: "all", label: "所有充值方式" },
                  ...methods.map((method) => ({
                    value: method,
                    label: method,
                  })),
                ]}
              />
            </div>
            <RateFilter groups={allGroups} value={range} onChange={setRange} />
          </div>
          <div className="list-caption">
            <div className="catalog-family-row">
              <FamilyFilters
                groups={allGroups}
                value={family}
                onChange={setFamily}
              />
              <div className="filter-summary">
                <span>
                  {filtered.length} 个站点{activeFilters && " · 已筛选"}
                </span>
                {activeFilters && (
                  <Button size="sm" variant="ghost" onPress={clear}>
                    清除筛选
                  </Button>
                )}
              </div>
            </div>
            <div className="list-options">
              <Select
                label="排序方式"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "default", label: "默认排序" },
                  { value: "rate", label: "最低倍率优先" },
                  { value: "recent", label: "最近更新优先" },
                ]}
              />
              <span className={loading ? "refreshing" : ""}>
                <IconButton label="刷新目录" icon="refresh" onPress={load} />
              </span>
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <Glyph name="info" size={16} />
              <span>
                {data
                  ? "刷新失败，暂时显示已加载的数据。"
                  : "暂时无法加载目录。"}{" "}
                {error}
              </span>
              <Button size="sm" variant="ghost" onPress={load}>
                重试
              </Button>
            </div>
          )}
          {!data && !error ? (
            <div
              className="site-grid"
              aria-label="正在读取站点目录"
              role="status"
            >
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="skeleton-card">
                  <Skeleton className="skeleton-avatar" />
                  <Skeleton className="skeleton-line" />
                  <Skeleton className="skeleton-line skeleton-line-short" />
                  <Skeleton className="skeleton-meta" />
                </div>
              ))}
            </div>
          ) : !filtered.length ? (
            <Empty
              title={sites.length ? "没有找到匹配站点" : "目录尚待点亮"}
              description={
                sites.length
                  ? "试试其他名称、模型或筛选条件。"
                  : "管理员添加站点后，公开信息与同步分组会显示在这里。"
              }
              action={
                sites.length ? (
                  <Button variant="secondary" onPress={clear}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="site-grid">
              {filtered.map((site, index) => (
                <SiteCard
                  key={site.id}
                  site={site}
                  index={index}
                  matchingGroups={
                    groupFiltering ? matchingGroups(site) : undefined
                  }
                  open={() => setSelected(site.id)}
                />
              ))}
            </div>
          )}
          <div className="catalog-note">
            <Glyph name="info" size={14} />
            <p>
              倍率来自公开分组快照，不代表最终调用单价。点击站点，了解完整分组与模型。
            </p>
          </div>
        </section>
      </main>
      {selectedSite && (
        <SiteDetails
          site={selectedSite}
          key={selectedSite.id}
          close={() => setSelected(null)}
        />
      )}
      {showChanges && (
        <ChangesDialog
          changes={changes}
          sites={sites}
          close={() => setShowChanges(false)}
          onSite={(id) => {
            setShowChanges(false);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}
