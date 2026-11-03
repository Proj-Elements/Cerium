import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Input,
  Modal,
  ScrollShadow,
  Skeleton,
  TextField,
} from "@heroui/react";
import { api, message } from "./api";
import { Empty, Glyph, Header, IconButton, n, Select, when } from "./ui";
import {
  GroupBadge,
  lowestRate,
  PlatformIcon,
  Provider,
  rateLabel,
  SiteIcon,
  SiteLink,
  Status,
} from "./relay";
import { FamilyFilters, RateFilter } from "./GroupFilters";
import {
  groupFamilies,
  matchesGroup,
  minimumRate,
  type FamilyFilter,
  type RateRange,
} from "./groups";
import { ChangeDetail, ChangesDialog } from "./Changes";
import closeIcon from "./assets/figma-close.svg";
import {
  ModelIcon,
  ModelPriceBadges,
  ModelPriceCells,
  useModelReference,
} from "./ModelPrice";
import { modelDisplayName } from "./model-display";
import type { ChangeNotice, Directory, Group, Site } from "./types";

function Models({ group, type }: { group: Group; type: string }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const reference = useModelReference();
  const prices = useMemo(
    () => new Map((group.prices ?? []).map((price) => [price.model, price])),
    [group.prices],
  );
  const matches = group.models.filter((model) =>
    `${model} ${modelDisplayName(model)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="model-panel" aria-label={`${group.name} 的模型`}>
      <div className="model-heading">
        <div>
          <h3>
            <span className="model-platforms">
              {groupFamilies(group).map((family) => (
                <PlatformIcon family={family} key={family} />
              ))}
            </span>
            {group.name}
            <span className="model-count">
              {group.models_known
                ? `${group.models.length} 个模型`
                : "模型快照"}
            </span>
          </h3>
          <p className="muted">
            {group.description || "此分组当前公开的可用模型。"}
          </p>
        </div>
        <span className="model-rate">{rateLabel(group)}</span>
      </div>
      <TextField
        aria-label={`搜索 ${group.name} 的模型`}
        className="search model-search"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setLimit(30);
        }}
        variant="secondary"
      >
        <Glyph name="magnifier" size={16} />
        <Input placeholder="搜索这个分组的模型…" />
      </TextField>
      <div className="model-caption">
        <span>USD / 百万 tokens</span>
        <span>
          {reference.failed
            ? "默认价暂不可用"
            : reference.match
              ? "站点价优先"
              : "默认价载入中…"}
        </span>
        {!group.models_known && <span>列表可能不完整</span>}
      </div>
      {matches.length ? (
        <ScrollShadow className="price-table-wrap" size={24}>
          <table className="price-table">
            <thead>
              <tr>
                <th>模型名称</th>
                <th>输入</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(0, limit).map((model) => {
                const price = prices.get(model);
                const match = reference.match?.(model);
                return (
                  <tr key={model} data-model-id={model}>
                    <td>
                      <div className="model-identity">
                        <ModelIcon model={model} match={match} />
                        <span className="model-name" title={model}>
                          {modelDisplayName(model)}
                        </span>
                        <ModelPriceBadges
                          model={model}
                          site={price}
                          match={match}
                        />
                      </div>
                      {price &&
                        (price.cache_read != null ||
                          price.cache_write != null) && (
                          <small>
                            缓存读 {n(price.cache_read)} / 写{" "}
                            {n(price.cache_write)}
                          </small>
                        )}
                    </td>
                    <ModelPriceCells site={price} match={match} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollShadow>
      ) : (
        <Empty
          title={query ? "没有匹配的模型" : "模型列表暂未公开"}
          description={
            query
              ? "试试更短的模型名称。"
              : group.models_known
                ? "该分组当前没有公开模型。"
                : "未知不代表不可用，请以站点公布的信息为准。"
          }
        />
      )}
      {matches.length > limit && (
        <Button
          size="sm"
          variant="secondary"
          className="load-more"
          onPress={() => setLimit(limit + 50)}
        >
          再显示 50 个 · 共 {matches.length} 个
        </Button>
      )}
      <p className="model-price-help">
        <a
          href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
          target="_blank"
          rel="noopener noreferrer"
          title={
            reference.catalog
              ? `快照 ${reference.catalog.fetchedAt.slice(0, 10)} · SHA256 ${reference.catalog.sha256}`
              : undefined
          }
        >
          LiteLLM 默认价
        </a>
        未乘分组倍率；站点价已含倍率。
        {type === "newapi" && "动态结算以站点为准。"}
      </p>
      {group.models_fetched_at && (
        <p className="field-help model-time">
          {group.models_source === "gateway_once"
            ? "一次性网关快照 · "
            : "模型发现于 "}
          {new Date(group.models_fetched_at).toLocaleString("zh-CN")}
        </p>
      )}
    </section>
  );
}

export function SiteDetails({
  site,
  close,
  initialGroup,
}: {
  site: Site;
  close: () => void;
  initialGroup?: string;
}) {
  const [selected, setSelected] = useState<string | null>(initialGroup ?? null);
  const [family, setFamily] = useState<FamilyFilter>("all");
  const [range, setRange] = useState<RateRange>(null);
  const [query, setQuery] = useState("");
  const backButton = useRef<HTMLButtonElement>(null);
  const detailSheet = useRef<HTMLElement>(null);
  const groups = site.catalog?.groups ?? [];
  const filtered = groups.filter((item) =>
    matchesGroup(item, family, range, query),
  );
  const group = filtered.find((item) => item.id === selected);
  const minimum = lowestRate(site);
  const returnToGroups = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      const badge = [
        ...(detailSheet.current?.querySelectorAll<HTMLButtonElement>(
          ".group-badge",
        ) ?? []),
      ].find((button) => button.dataset.groupId === id);
      badge?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (group && window.matchMedia("(orientation: portrait)").matches)
      backButton.current?.focus();
  }, [group?.id]);
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal.Backdrop className="detail-backdrop">
        <Modal.Container
          scroll="inside"
          className={`detail-container ${group ? "has-models" : ""}`}
        >
          <Modal.Dialog
            className={`detail-workspace ${group ? "has-models" : ""}`}
            aria-label={`${site.name}详情`}
          >
            <section
              className="detail-sheet"
              aria-label="站点与分组"
              ref={detailSheet}
            >
              <Modal.CloseTrigger aria-label="关闭站点详情">
                <img src={closeIcon} alt="" width="16" height="16" />
              </Modal.CloseTrigger>
              <Modal.Header>
                <div className="detail-identity">
                  <SiteIcon site={site} />
                  <div>
                    <Provider type={site.type} />
                    <Modal.Heading>{site.name}</Modal.Heading>
                  </div>
                </div>
                <p className="detail-description muted">
                  {site.description || "查看本站公开分组与倍率。"}
                </p>
                <div className="detail-link-row">
                  <span className="site-domain">
                    {site.url.replace(/^https?:\/\//, "")}
                  </span>
                  <SiteLink site={site} />
                </div>
              </Modal.Header>
              <Modal.Body>
                <div className="detail-overview">
                  <div className="detail-facts">
                    <div>
                      <span>最低分组倍率</span>
                      <strong className="accent">
                        {minimum == null ? (
                          "待确认"
                        ) : (
                          <>
                            {n(minimum)}
                            <small>×</small>
                          </>
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>充值兑换</span>
                      <strong>
                        {site.recharge_cny == null ? (
                          "未提供"
                        ) : (
                          <>
                            {n(site.recharge_cny)}
                            <small> CNY</small> = {n(site.recharge_usd)}
                            <small> USD</small>
                          </>
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>充值倍率</span>
                      <strong>
                        {site.recharge_multiplier == null
                          ? "未提供"
                          : `${n(site.recharge_multiplier)}×`}
                      </strong>
                    </div>
                  </div>
                  {(site.payment_methods.length > 0 || site.payment_note) && (
                    <div className="detail-payments">
                      <Glyph name="credit-card" size={16} />
                      <span>
                        {site.payment_methods.join(" / ") || "充值方式未提供"}
                      </span>
                      {site.payment_note && (
                        <span className="muted">{site.payment_note}</span>
                      )}
                    </div>
                  )}
                  {site.status !== "ok" && site.status !== "manual" && (
                    <div className="notice subtle">
                      <Glyph name="info" size={16} />
                      <span>
                        {site.catalog
                          ? "暂时保留最近一次成功快照，当前数据可能已经变化。"
                          : "正在等待首次成功同步，暂时没有可展示的分组。"}
                      </span>
                    </div>
                  )}
                </div>
                <section className="group-section">
                  <div className="section-heading">
                    <div>
                      <h2>
                        全部分组 <span>{groups.length}</span>
                      </h2>
                      <p>点击倍率，在独立卡片查看模型。</p>
                    </div>
                    <Glyph name="layers" size={18} />
                  </div>
                  <RateFilter
                    groups={groups}
                    value={range}
                    onChange={(value) => {
                      setRange(value);
                      setSelected(null);
                    }}
                  />
                  <FamilyFilters
                    groups={groups}
                    value={family}
                    onChange={(value) => {
                      setFamily(value);
                      setSelected(null);
                    }}
                  />
                  <TextField
                    aria-label="搜索分组"
                    className="search group-search"
                    value={query}
                    onChange={(value) => {
                      setQuery(value);
                      setSelected(null);
                    }}
                    variant="secondary"
                  >
                    <Glyph name="magnifier" size={15} />
                    <Input placeholder="搜索分组名称…" />
                  </TextField>
                  <div className="group-result-caption">
                    <span>
                      {filtered.length} / {groups.length} 个分组
                    </span>
                    {(family !== "all" || range || query) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => {
                          setFamily("all");
                          setRange(null);
                          setQuery("");
                        }}
                      >
                        清除分组筛选
                      </Button>
                    )}
                  </div>
                  <div className="group-badges">
                    {filtered.map((item) => (
                      <GroupBadge
                        key={item.id}
                        group={item}
                        selected={selected === item.id}
                        onPress={() => setSelected(item.id)}
                      />
                    ))}
                  </div>
                  {!filtered.length && (
                    <Empty
                      title={
                        groups.length
                          ? "没有符合条件的分组"
                          : "暂无可确认的分组"
                      }
                      description={
                        groups.length
                          ? "调整平台、名称或倍率区间后再试。动态与未知倍率不参与区间筛选。"
                          : "成功同步后，公开分组会显示在这里。"
                      }
                    />
                  )}
                </section>
              </Modal.Body>
              <Modal.Footer>
                <span className="detail-update">
                  <Status site={site} />
                  <span>
                    {site.type === "others"
                      ? "管理员维护"
                      : when(site.fetched_at)}
                  </span>
                </span>
                <Button variant="secondary" onPress={close}>
                  返回目录
                </Button>
              </Modal.Footer>
            </section>
            {group && (
              <section className="models-sheet" aria-label="分组模型卡片">
                <header className="models-sheet-header">
                  <Button
                    ref={backButton}
                    size="sm"
                    variant="ghost"
                    onPress={returnToGroups}
                  >
                    <Glyph name="arrow-left" size={15} />
                    返回分组
                  </Button>
                  <span>
                    {site.name} <span>/ 可用模型</span>
                  </span>
                  <Modal.CloseTrigger aria-label="关闭模型详情">
                    <img src={closeIcon} alt="" width="16" height="16" />
                  </Modal.CloseTrigger>
                </header>
                <Models group={group} type={site.type} key={group.id} />
              </section>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function SiteCard({
  site,
  index,
  open,
  matchingGroups,
}: {
  site: Site;
  index: number;
  open: () => void;
  matchingGroups?: Group[];
}) {
  const minimum = matchingGroups
    ? minimumRate(matchingGroups)
    : lowestRate(site);
  return (
    <Card
      className="relay-card"
      style={{ animationDelay: `${Math.min(index, 6) * 55}ms` }}
    >
      <Card.Header className="relay-header">
        <SiteIcon site={site} />
        <div className="site-identity">
          <div className="site-name">
            <h2>{site.name}</h2>
            <Provider type={site.type} />
          </div>
          <span className="site-domain">
            {site.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </span>
        </div>
      </Card.Header>
      <Card.Content className="relay-content">
        <p className="site-description">
          {site.description || "一个值得发现的 AI 入口，点击了解更多。"}
        </p>
      </Card.Content>
      <div className="rate-summary">
        <div>
          <span className="rate-label">
            {matchingGroups ? "筛选内最低" : "最低倍率"}
          </span>
          <strong>
            {minimum == null ? (
              <span className="rate-unknown">待确认</span>
            ) : (
              <>
                {n(minimum)}
                <small>×</small>
              </>
            )}
          </strong>
        </div>
        <span className="card-group-count">
          {matchingGroups
            ? `${matchingGroups.length} 个匹配分组`
            : `${site.catalog?.groups.length ?? 0} 个分组`}
        </span>
      </div>
      <Card.Footer className="relay-footer">
        <span>
          <Status site={site} />
          <span className="update-time">
            {site.type === "others" ? "人工维护" : when(site.fetched_at)}
          </span>
        </span>
      </Card.Footer>
      <Button
        variant="ghost"
        className="card-hitarea"
        aria-label={`查看${site.name}详情`}
        aria-haspopup="dialog"
        onPress={open}
      >
        <span>
          <Glyph name="arrow-up-right" size={16} />
        </span>
      </Button>
    </Card>
  );
}

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
