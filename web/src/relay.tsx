import { useEffect, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { api } from "./api";
import { Glyph, n, when } from "./ui";
import newapiIcon from "./assets/newapi.png";
import sub2apiIcon from "./assets/sub2api.svg";
import { groupFamilies, minimumRate, type GroupFamily } from "./groups";
import { platformPaths } from "./platform-paths";
import { cachedIconSources, type IconSite } from "./site-icon";
import type { Group, Site } from "./types";

export const typeNames = {
  newapi: "NewAPI",
  sub2api: "Sub2API",
  others: "独立站点",
};
const statuses = {
  ok: "已同步",
  pending: "同步中",
  waiting: "等待同步",
  error: "同步异常",
  retrying: "等待重试",
  stale: "数据较旧",
  manual: "手动维护",
};
export function Status({ site }: { site: Site }) {
  return (
    <span
      className={`status status-${site.status}`}
      title={when(site.fetched_at)}
    >
      <i />
      {statuses[site.status]}
    </span>
  );
}
export function SiteIcon({ site }: { site: IconSite & Pick<Site, "type"> }) {
  const [sources, setSources] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const fallback = site.type === "sub2api" ? sub2apiIcon : newapiIcon;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSources([]);
    setIndex(0);
    if (site.enabled)
      void api<{ icons: string[] }>(
        `/api/sites/${site.id}/icon`,
        "GET",
        undefined,
        30000,
        { signal: controller.signal },
      )
        .then((data) => {
          if (active) {
            setSources(cachedIconSources(site, data.icons));
            setIndex(0);
          }
        })
        .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    site.id,
    site.url,
    site.type,
    site.enabled,
    site.icon,
    site.icon_revision,
  ]);
  return (
    <span className={`site-icon icon-${site.type}`}>
      <img
        key={`${sources[index] ?? fallback}`}
        src={sources[index] ?? fallback}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          if (index < sources.length) setIndex(index + 1);
        }}
      />
    </span>
  );
}
export function lowestRate(site: Site) {
  return minimumRate(site.catalog?.groups ?? []);
}
export const rateLabel = (group: Group) =>
  group.multiplier_source === "auto"
    ? "动态"
    : group.multiplier == null
      ? "待确认"
      : `${n(group.multiplier)}×`;
export function Provider({ type }: { type: Site["type"] }) {
  return (
    <Chip size="sm" variant="soft" className="provider">
      <Chip.Label>{typeNames[type]}</Chip.Label>
    </Chip>
  );
}
export function PlatformIcon({ family }: { family: GroupFamily }) {
  if (family === "other") return <Glyph name="layers" size={14} />;
  return (
    <svg
      className="platform-icon"
      data-platform={family}
      viewBox={family === "anthropic" ? "0 0 16 16" : "0 0 24 24"}
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={platformPaths[family]} />
    </svg>
  );
}
function groupTone(group: Group) {
  const families = groupFamilies(group);
  if (families.length === 1) {
    if (families[0] === "anthropic") return "amber";
    if (families[0] === "openai") return "green";
    if (families[0] === "gemini") return "blue";
  }
  const hash = [...group.id].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  return ["blue", "green", "amber", "rose", "cyan"][hash % 5];
}
export function GroupBadge({
  group,
  selected,
  onPress,
}: {
  group: Group;
  selected?: boolean;
  onPress?: () => void;
}) {
  const content = (
    <>
      <span className="group-platform-icons">
        {groupFamilies(group).map((family) => (
          <PlatformIcon family={family} key={family} />
        ))}
      </span>
      <span className="badge-name" title={group.name}>
        {group.name}
      </span>
      <span className="group-rate">{rateLabel(group)}</span>
    </>
  );
  return onPress ? (
    <Button
      size="sm"
      variant="secondary"
      className={`group-badge tone-${groupTone(group)}`}
      data-group-id={group.id}
      aria-pressed={selected}
      onPress={onPress}
    >
      {content}
    </Button>
  ) : (
    <span className={`group-badge tone-${groupTone(group)}`}>{content}</span>
  );
}
export function SiteLink({ site }: { site: Site }) {
  return (
    <a
      className="external-link"
      href={site.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      访问站点
      <Glyph name="arrow-up-right" size={15} />
    </a>
  );
}
