import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { groupPreviewCount, MAX_PREVIEW_GROUPS } from "./group-preview";
import { GroupBadge } from "./relay";
import type { Group } from "./types";

export function GroupPreview({
  groups,
  onGroup,
  onMore,
}: {
  groups: Group[];
  onGroup: (group: Group) => void;
  onMore: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(1);
  const candidates = groups.slice(0, MAX_PREVIEW_GROUPS);
  const visible = Math.min(count, candidates.length);
  const remaining = groups.length - visible;

  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !groups.length) return;
    const measure = element.querySelector<HTMLElement>(
      ".group-preview-measure",
    )!;
    let active = true;
    const update = () => {
      if (!active) return;
      const widths = [
        ...measure.querySelectorAll<HTMLElement>(".group-badge"),
      ].map((badge) => badge.getBoundingClientRect().width);
      const more = [
        ...measure.querySelectorAll<HTMLElement>(".group-preview-more"),
      ].map((button) => button.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
      setCount(groupPreviewCount(element.clientWidth, widths, more, gap));
    };
    // Measure full labels, not truncated visible chips, including the disclosure action.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(measure);
    update();
    void document.fonts.ready.then(update);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [groups]);

  return (
    <div className="admin-group-preview" ref={container}>
      {groups.length ? (
        <>
          <div
            className="group-preview-list"
            role="group"
            aria-label="分组预览"
          >
            {candidates.slice(0, visible).map((group) => (
              <GroupBadge
                key={group.id}
                group={group}
                onPress={() => onGroup(group)}
              />
            ))}
            {remaining > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="group-preview-more"
                onPress={onMore}
              >
                +{remaining} 个分组
              </Button>
            )}
          </div>
          <div className="group-preview-measure" aria-hidden="true" inert>
            {candidates.map((group) => (
              <GroupBadge key={group.id} group={group} />
            ))}
            {candidates.map((group, index) => (
              <span
                className="button button--ghost button--sm group-preview-more"
                key={`more-${group.id}`}
              >
                {groups.length > index + 1 &&
                  `+${groups.length - index - 1} 个分组`}
              </span>
            ))}
          </div>
        </>
      ) : (
        <span className="muted">等待公开分组快照</span>
      )}
    </div>
  );
}
