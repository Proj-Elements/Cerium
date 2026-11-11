import { matchesGroup, type FamilyFilter, type RateRange } from "./groups.ts";
import { modelDisplayName } from "./model-display.ts";
import type { Site } from "./types";

export type CatalogFilter = {
  family: FamilyFilter;
  range: RateRange;
  query: string;
};

export function matchCatalogSite(site: Site, filter: CatalogFilter) {
  const query = filter.query.trim().toLowerCase();
  const siteMatches = `${site.name} ${site.url} ${site.description ?? ""}`
    .toLowerCase()
    .includes(query);
  const groups = (site.catalog?.groups ?? []).filter((group) => {
    if (!matchesGroup(group, filter.family, filter.range)) return false;
    return (
      siteMatches ||
      `${group.name} ${group.id} ${group.description ?? ""} ${group.models
        .flatMap((model) => [model, modelDisplayName(model)])
        .join(" ")}`
        .toLowerCase()
        .includes(query)
    );
  });
  const groupFiltering = filter.family !== "all" || filter.range !== null;
  return {
    matches: groups.length > 0 || (!groupFiltering && siteMatches),
    groups,
    groupFiltering: groupFiltering || (query !== "" && !siteMatches),
  };
}
