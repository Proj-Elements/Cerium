import { Button, Chip, Modal } from "@heroui/react";
import { Timeline } from "@heroui-pro/react/timeline";
import { Empty, Glyph, n, when } from "./ui";
import { SiteIcon } from "./relay";
import type { ChangeNotice, GroupChange, Site } from "./types";
import closeIcon from "./assets/figma-close.svg";
import { changeSummary, priceDescription } from "./change-display";

function value(rate: number | null, dynamic: boolean) {
  return dynamic ? "动态" : rate == null ? "未知" : `${n(rate)}×`;
}
export function ChangeDetail({
  change,
  compact = false,
}: {
  change: GroupChange;
  compact?: boolean;
}) {
  if (change.kind === "models" || change.kind === "prices") {
    const summary = changeSummary(change);
    const label = change.kind === "models" ? "模型" : "价格";
    return (
      <div className={`change-detail ${change.kind}`}>
        <Chip size="sm" variant="soft">
          <Chip.Label>{label}</Chip.Label>
        </Chip>
        <span className="change-group-name">{change.name}</span>
        {compact ? (
          <span>{summary}</span>
        ) : (
          <details className="change-catalog-details">
            <summary>{summary}</summary>
            <ul>
              {change.kind === "models" ? (
                <>
                  {(change.models_added ?? []).map((model) => (
                    <li key={`added-${model}`}>新增 {model}</li>
                  ))}
                  {(change.models_removed ?? []).map((model) => (
                    <li key={`removed-${model}`}>移除 {model}</li>
                  ))}
                </>
              ) : (
                (change.price_changes ?? []).map((item) => (
                  <li key={item.model}>
                    <strong>{item.model}</strong>
                    <span className="old-value">
                      {priceDescription(item.before)}
                    </span>
                    <Glyph name="arrow-right" size={13} />
                    <span>{priceDescription(item.after)}</span>
                  </li>
                ))
              )}
            </ul>
          </details>
        )}
      </div>
    );
  }
  const direction =
    change.kind === "multiplier" &&
    !change.before_dynamic &&
    !change.after_dynamic &&
    change.before != null &&
    change.after != null &&
    change.after !== change.before
      ? change.after < change.before
        ? "decrease"
        : "increase"
      : "";
  return (
    <div className={`change-detail ${change.kind} ${direction}`}>
      <Chip
        size="sm"
        variant="soft"
        color={
          change.kind === "added"
            ? "success"
            : change.kind === "removed"
              ? "danger"
              : "default"
        }
      >
        <Chip.Label>
          {change.kind === "added"
            ? "新增"
            : change.kind === "removed"
              ? "移除"
              : "倍率"}
        </Chip.Label>
      </Chip>
      <span className="change-group-name">{change.name}</span>
      <span className="change-values">
        {change.kind !== "added" && (
          <span className={change.kind === "multiplier" ? "old-value" : ""}>
            {value(change.before, change.before_dynamic)}
          </span>
        )}
        {change.kind === "multiplier" && <Glyph name="arrow-right" size={13} />}
        {change.kind !== "removed" && (
          <strong>{value(change.after, change.after_dynamic)}</strong>
        )}
      </span>
    </div>
  );
}
export function ChangeList({
  changes,
  sites,
  onSite,
  onVisibility,
  busy = false,
}: {
  changes: ChangeNotice[];
  sites: Site[];
  onSite?: (id: string) => void;
  onVisibility?: (notice: ChangeNotice) => void;
  busy?: boolean;
}) {
  if (!changes.length)
    return (
      <Empty
        title="一切如常，暂时没有波动"
        description="有新的分组、模型增删或倍率、价格调整时，变动会自动记录在这里。首次同步仅建立基准，不触发通报。"
      />
    );
  const sitesById = new Map(sites.map((site) => [site.id, site]));
  return (
    <Timeline className="change-list" size="md" density="comfortable">
      {changes.map((notice, index) => (
        <Timeline.Item
          className={`change-item ${notice.dismissed ? "is-dismissed" : ""}`}
          key={notice.id}
          status={notice.dismissed ? "muted" : "current"}
          style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}
        >
          <Timeline.Rail>
            <Timeline.Marker
              className="timeline-dot"
              status={notice.dismissed ? "muted" : "current"}
            >
              {sitesById.has(notice.site_id) ? (
                <SiteIcon site={sitesById.get(notice.site_id)!} />
              ) : (
                <span aria-hidden="true">{notice.site_name.slice(0, 1)}</span>
              )}
            </Timeline.Marker>
            <Timeline.Connector />
          </Timeline.Rail>
          <Timeline.Content className="change-item-content">
            <div className="change-item-heading">
              {onSite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="change-site-button"
                  onPress={() => onSite(notice.site_id)}
                >
                  <span className="change-site-name">{notice.site_name}</span>
                  <Glyph name="arrow-up-right" size={13} />
                </Button>
              ) : (
                <h3>{notice.site_name}</h3>
              )}
              <time
                dateTime={notice.checked_at}
                title={new Date(notice.checked_at).toLocaleString("zh-CN")}
              >
                {when(notice.checked_at).replace("更新", "")}
              </time>
            </div>
            <div className="change-details">
              {notice.details.map((detail) => (
                <ChangeDetail
                  key={`${detail.kind}-${detail.group_id}`}
                  change={detail}
                />
              ))}
            </div>
            {onVisibility && (
              <div className="change-moderation">
                <span>
                  {notice.dismissed
                    ? "已从前台撤下"
                    : notice.enabled === false ||
                        notice.monitor_changes === false
                      ? "站点隐藏或监测已暂停，前台不可见"
                      : "7 天内自动展示于前台"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  onPress={() => onVisibility(notice)}
                >
                  {notice.dismissed ? "恢复通报" : "撤下通报"}
                </Button>
              </div>
            )}
          </Timeline.Content>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
export function ChangesDialog({
  changes,
  sites,
  close,
  onSite,
}: {
  changes: ChangeNotice[];
  sites: Site[];
  close: () => void;
  onSite: (id: string) => void;
}) {
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog className="changes-dialog">
            <Modal.CloseTrigger aria-label="关闭倍率动态">
              <img src={closeIcon} alt="" width="16" height="16" />
            </Modal.CloseTrigger>
            <Modal.Header>
              <div className="section-eyebrow">
                <Glyph name="activity" size={16} />
                倍率动态
              </div>
              <Modal.Heading>每一次变化，都有迹可循。</Modal.Heading>
              <p className="muted">
                最近 7
                天的分组、模型、倍率与价格变动，来自前后两次成功快照的比较。
              </p>
            </Modal.Header>
            <Modal.Body>
              <ChangeList changes={changes} sites={sites} onSite={onSite} />
            </Modal.Body>
            <Modal.Footer>
              <span className="field-help">分组倍率不等同于模型最终单价。</span>
              <Button variant="secondary" onPress={close}>
                知道了
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
