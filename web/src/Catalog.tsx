import { useMemo, useState } from "react";
import { Button, Input, Skeleton, TextField } from "@heroui/react";
import { Empty, Glyph, Header, IconButton, Select } from "./ui";
import { lowestRate } from "./relay";
import { FamilyFilters, RateFilter } from "./GroupFilters";
import { minimumRate } from "./groups";
import { ChangeDetail, ChangesDialog } from "./Changes";
import { matchCatalogSite } from "./catalog-filter";
import { ModelComparison } from "./ModelComparison";
import { SiteCard } from "./SiteCard";
import { SiteDetails } from "./SiteDetails";
import { useCatalogRoute } from "./use-catalog-route";
import { useDirectory } from "./use-directory";
import type { ChangeNotice, Site } from "./types";

export { SiteDetails } from "./SiteDetails";

const noSites: Site[] = [];

export default function CatalogPage() {
  const { data, error, loading, load } = useDirectory();
  const [route, navigate] = useCatalogRoute();
  const { query, type, payment, sort, family, range, site: selected } = route;
  const [showChanges, setShowChanges] = useState(false);
  const sites = data?.sites ?? noSites;
  const changes: ChangeNotice[] = data?.changes ?? [];
  const allGroups = useMemo(
    () => sites.flatMap((site) => site.catalog?.groups ?? []),
    [sites],
  );
  const groupFiltering = family !== "all" || range !== null;
  const matches = useMemo(
    () =>
      new Map(
        sites.map((site) => [
          site.id,
          matchCatalogSite(site, { family, range, query }),
        ]),
      ),
    [sites, family, range, query],
  );
  const methods = [...new Set(sites.flatMap((site) => site.payment_methods))];
  const filtered = useMemo(() => {
    const siteMinimum = (site: Site) =>
      matches.get(site.id)?.groupFiltering
        ? minimumRate(matches.get(site.id)!.groups)
        : lowestRate(site);
    return sites
      .filter(
        (site) =>
          (type === "all" || site.type === type) &&
          (payment === "all" || site.payment_methods.includes(payment)) &&
          matches.get(site.id)!.matches,
      )
      .sort((a, b) =>
        sort === "rate"
          ? (siteMinimum(a) ?? Infinity) - (siteMinimum(b) ?? Infinity)
          : sort === "recent"
            ? (Date.parse(b.fetched_at ?? "") || 0) -
              (Date.parse(a.fetched_at ?? "") || 0)
            : 0,
      );
  }, [sites, matches, type, payment, sort]);
  const comparisonSites = useMemo(
    () =>
      filtered.map((site) =>
        matches.get(site.id)!.groupFiltering && site.catalog
          ? {
              ...site,
              catalog: {
                ...site.catalog,
                groups: matches.get(site.id)!.groups,
              },
            }
          : site,
      ),
    [filtered, matches],
  );
  const selectedSite = sites.find((site) => site.id === selected);
  const activeFilters = Boolean(
    query || type !== "all" || payment !== "all" || groupFiltering,
  );
  const clear = () => {
    navigate({
      query: "",
      type: "all",
      payment: "all",
      family: "all",
      range: null,
    });
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
            <ChangeDetail compact change={changes[0].details[0]} />
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
              onChange={(query) => navigate({ query }, true)}
              variant="secondary"
            >
              <Glyph name="magnifier" />
              <Input placeholder="搜索站点、分组或模型…" />
            </TextField>
            <div className="filters">
              <Select
                label="站点类型"
                value={type}
                onChange={(type) => navigate({ type })}
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
                onChange={(payment) => navigate({ payment })}
                options={[
                  { value: "all", label: "所有充值方式" },
                  ...methods.map((method) => ({
                    value: method,
                    label: method,
                  })),
                ]}
              />
            </div>
            <RateFilter
              groups={allGroups}
              value={range}
              onChange={(range) => navigate({ range }, true)}
            />
          </div>
          <div className="list-caption">
            <div className="catalog-family-row">
              <FamilyFilters
                groups={allGroups}
                value={family}
                onChange={(family) => navigate({ family })}
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
                onChange={(sort) => navigate({ sort })}
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
          <ModelComparison sites={comparisonSites} />
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
                    matches.get(site.id)!.groupFiltering
                      ? matches.get(site.id)!.groups
                      : undefined
                  }
                  open={() => navigate({ site: site.id })}
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
          close={() => navigate({ site: null })}
          navigation={{
            selected: route.group,
            query: route.groupQuery,
            family: route.groupFamily,
            range: route.groupRange,
            modelQuery: route.modelQuery,
            onChange: (patch, replace) =>
              navigate(
                {
                  ...(Object.hasOwn(patch, "selected")
                    ? { group: patch.selected }
                    : {}),
                  ...(Object.hasOwn(patch, "query")
                    ? { groupQuery: patch.query }
                    : {}),
                  ...(Object.hasOwn(patch, "family")
                    ? { groupFamily: patch.family }
                    : {}),
                  ...(Object.hasOwn(patch, "range")
                    ? { groupRange: patch.range }
                    : {}),
                  ...(Object.hasOwn(patch, "modelQuery")
                    ? { modelQuery: patch.modelQuery }
                    : {}),
                },
                replace,
              ),
          }}
        />
      )}
      {showChanges && (
        <ChangesDialog
          changes={changes}
          sites={sites}
          close={() => setShowChanges(false)}
          onSite={(id) => {
            setShowChanges(false);
            navigate({ site: id });
          }}
        />
      )}
    </div>
  );
}
