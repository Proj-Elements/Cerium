import { Button, Card } from "@heroui/react";
import { Glyph, n, when } from "./ui";
import { lowestRate, Provider, SiteIcon, Status } from "./relay";
import { minimumRate } from "./groups";
import type { Group, Site } from "./types";

export function SiteCard({
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
