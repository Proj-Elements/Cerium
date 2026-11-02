import { Button, Chip, Modal } from "@heroui/react";
import { Empty, Glyph, n, when } from "./ui";
import type { ChangeNotice, GroupChange } from "./types";
import closeIcon from "./assets/figma-close.svg";

function value(rate: number | null, dynamic: boolean) {
  return dynamic ? "动态" : rate == null ? "未知" : `${n(rate)}×`;
}
export function ChangeDetail({ change }: { change: GroupChange }) {
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
  onSite,
  onVisibility,
  busy = false,
}: {
  changes: ChangeNotice[];
  onSite?: (id: string) => void;
  onVisibility?: (notice: ChangeNotice) => void;
  busy?: boolean;
}) {
  if (!changes.length)
    return (
      <Empty
        title="一切如常，暂时没有波动"
        description="有新的分组增删或倍率调整时，变动会自动记录在这里。首次同步仅建立基准，不触发通报。"
      />
    );
  return (
    <div className="change-list">
      {changes.map((notice) => (
        <article
          className={`change-item ${notice.dismissed ? "is-dismissed" : ""}`}
          key={notice.id}
        >
          <span className="timeline-dot">
            <Glyph name="activity" size={16} />
          </span>
          <div className="change-item-content">
            <div className="change-item-heading">
              {onSite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="change-site-button"
                  onPress={() => onSite(notice.site_id)}
                >
                  {notice.site_name}
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
          </div>
        </article>
      ))}
    </div>
  );
}
export function ChangesDialog({
  changes,
  close,
  onSite,
}: {
  changes: ChangeNotice[];
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
                最近 7 天的分组与倍率变动，来自前后两次成功快照的比较。
              </p>
            </Modal.Header>
            <Modal.Body>
              <ChangeList changes={changes} onSite={onSite} />
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
