import { useState } from "react";
import { Button, Card, Input, TextField } from "@heroui/react";
import { GroupPreview } from "./GroupPreview";
import { lowestRate, Provider, SiteIcon, Status } from "./relay";
import { Empty, Glyph, n, Select, when } from "./ui";
import type { Site } from "./types";

type Props = {
  sites: Site[];
  busy: boolean;
  edit: (site: Site | "new") => void;
  remove: (site: Site) => void;
  preview: (site: Site, groupId?: string) => void;
  sync: (site: Site) => void;
  refreshModels: (site: Site) => void;
};

export function AdminSites({
  sites,
  busy,
  edit,
  remove,
  preview,
  sync,
  refreshModels,
}: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = sites.filter(
    (site) =>
      (filter === "all" ||
        (filter === "published" && site.enabled) ||
        (filter === "hidden" && !site.enabled) ||
        (filter === "error" &&
          ["error", "retrying", "stale"].includes(site.status))) &&
      [site.name, site.url, site.type, site.description]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <div className="admin-toolbar">
        <TextField
          aria-label="搜索管理站点"
          className="search"
          value={query}
          onChange={setQuery}
          variant="secondary"
        >
          <Glyph name="magnifier" size={18} />
          <Input placeholder="搜索站点名称、地址或类型…" />
        </TextField>
        <Select
          label="管理筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部状态" },
            { value: "published", label: "公开展示" },
            { value: "error", label: "需要关注" },
            { value: "hidden", label: "已隐藏" },
          ]}
        />
      </div>
      {filtered.length ? (
        <div className="admin-list">
          {filtered.map((site, index) => (
            <Card
              key={site.id}
              className="admin-site"
              style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}
            >
              <Card.Header className="admin-site-main">
                <SiteIcon site={site} />
                <div className="admin-site-info">
                  <div className="site-name">
                    <h2>{site.name}</h2>
                    <Provider type={site.type} />
                    {!site.enabled && (
                      <span className="hidden-label">已隐藏</span>
                    )}
                  </div>
                  <a href={site.url} target="_blank" rel="noopener noreferrer">
                    {site.url.replace(/^https?:\/\//, "")}
                    <Glyph name="arrow-up-right" size={12} />
                  </a>
                </div>
                <div className="admin-site-status">
                  <Status site={site} />
                  <small>{when(site.fetched_at)}</small>
                </div>
                <div className="admin-site-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={
                      busy ||
                      !site.enabled ||
                      site.type === "others" ||
                      site.status === "pending"
                    }
                    onPress={() => sync(site)}
                  >
                    {site.status === "error" || site.status === "retrying"
                      ? "重新同步"
                      : "同步"}
                  </Button>
                  {site.type === "newapi" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={
                        busy || !site.enabled || site.status === "pending"
                      }
                      onPress={() => refreshModels(site)}
                    >
                      刷新模型列表
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => edit(site)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() => remove(site)}
                  >
                    删除
                  </Button>
                </div>
              </Card.Header>
              <Card.Content className="admin-site-content">
                <GroupPreview
                  groups={site.catalog?.groups ?? []}
                  onGroup={(group) => preview(site, group.id)}
                  onMore={() => preview(site)}
                />
                <div className="admin-site-detail">
                  <span>
                    最低{" "}
                    {lowestRate(site) == null
                      ? "待确认"
                      : `${n(lowestRate(site))}×`}
                  </span>
                  <span>
                    {site.payment_methods.join(" / ") || "未配置支付方式"}
                  </span>
                  <span>
                    <Glyph
                      name={
                        site.monitor_changes !== false
                          ? "activity"
                          : "eye-slash"
                      }
                      size={13}
                    />
                    {site.monitor_changes !== false
                      ? "动态监测中"
                      : "已暂停监测"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => preview(site)}
                  >
                    查看分组
                    <Glyph name="arrow-right" size={13} />
                  </Button>
                </div>
                {site.error || site.warnings?.length ? (
                  <details className="diagnostic">
                    <summary>
                      <Glyph name="info" size={14} />
                      {site.error
                        ? "查看同步错误"
                        : `${site.warnings?.length} 条同步提醒`}
                    </summary>
                    {site.error && <p>{site.error}</p>}
                    {site.warnings?.map((warning, warningIndex) => (
                      <p key={warningIndex}>{warning}</p>
                    ))}
                  </details>
                ) : null}
              </Card.Content>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title={sites.length ? "没有匹配的站点" : "添加你的第一个站点"}
          description={
            sites.length
              ? "试试其他关键词或状态筛选。"
              : "填写站点信息，Cerium 会自动收集公开分组与价格。"
          }
          action={
            <Button
              variant="secondary"
              onPress={() => {
                if (sites.length) {
                  setQuery("");
                  setFilter("all");
                } else edit("new");
              }}
            >
              {sites.length ? "清除筛选" : "添加站点"}
            </Button>
          }
        />
      )}
    </>
  );
}
