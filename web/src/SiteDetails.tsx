import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, TextField } from "@heroui/react";
import { Empty, Glyph, n, when } from "./ui";
import {
  GroupBadge,
  lowestRate,
  Provider,
  SiteIcon,
  SiteLink,
  Status,
} from "./relay";
import { FamilyFilters, RateFilter } from "./GroupFilters";
import { matchesGroup, type FamilyFilter, type RateRange } from "./groups";
import { Models } from "./Models";
import closeIcon from "./assets/figma-close.svg";
import type { Site } from "./types";

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
                {site.description && (
                  <p className="detail-description muted">{site.description}</p>
                )}
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
                            {n(site.recharge_cny / (site.recharge_usd || 1))}
                            <small> CNY</small> = 1<small> USD</small>
                          </>
                        )}
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
