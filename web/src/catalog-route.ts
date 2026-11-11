import type { FamilyFilter, RateRange } from "./groups";

export type CatalogRoute = {
  query: string;
  type: string;
  payment: string;
  sort: string;
  family: FamilyFilter;
  range: RateRange;
  site: string | null;
  group: string | null;
  groupQuery: string;
  groupFamily: FamilyFilter;
  groupRange: RateRange;
  modelQuery: string;
};

const families = new Set(["all", "openai", "anthropic", "gemini", "other"]);
const parameters = [
  "q",
  "type",
  "payment",
  "sort",
  "family",
  "rate_min",
  "rate_max",
  "site",
  "group",
  "group_q",
  "group_family",
  "group_rate_min",
  "group_rate_max",
  "model_q",
];

function family(value: string | null): FamilyFilter {
  return value && families.has(value) ? (value as FamilyFilter) : "all";
}

function range(params: URLSearchParams, prefix = ""): RateRange {
  const minimum = params.get(`${prefix}rate_min`);
  const maximum = params.get(`${prefix}rate_max`);
  if (
    minimum === null ||
    maximum === null ||
    !minimum.trim() ||
    !maximum.trim()
  )
    return null;
  const lower = Number(minimum);
  const upper = Number(maximum);
  return Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    lower >= 0 &&
    upper >= lower &&
    upper <= 1e12
    ? [lower, upper]
    : null;
}

export function readCatalogRoute(search: string): CatalogRoute {
  const params = new URLSearchParams(search);
  const type = params.get("type");
  const sort = params.get("sort");
  const site = params.get("site")?.slice(0, 512) || null;
  return {
    query: params.get("q")?.slice(0, 512) ?? "",
    type: type && ["newapi", "sub2api", "others"].includes(type) ? type : "all",
    payment: params.get("payment")?.slice(0, 200) || "all",
    sort: sort && ["rate", "recent"].includes(sort) ? sort : "default",
    family: family(params.get("family")),
    range: range(params),
    site,
    group: site ? params.get("group")?.slice(0, 512) || null : null,
    groupQuery: site ? (params.get("group_q")?.slice(0, 512) ?? "") : "",
    groupFamily: site ? family(params.get("group_family")) : "all",
    groupRange: site ? range(params, "group_") : null,
    modelQuery: site ? (params.get("model_q")?.slice(0, 512) ?? "") : "",
  };
}

export function updateCatalogRoute(
  current: CatalogRoute,
  patch: Partial<CatalogRoute>,
): CatalogRoute {
  const next = { ...current, ...patch };
  if (Object.hasOwn(patch, "site") && patch.site !== current.site) {
    next.group = patch.group ?? null;
    next.groupQuery = patch.groupQuery ?? "";
    next.groupFamily = patch.groupFamily ?? "all";
    next.groupRange = patch.groupRange ?? null;
    next.modelQuery = patch.modelQuery ?? "";
  }
  if (Object.hasOwn(patch, "group") && patch.group !== current.group)
    next.modelQuery = patch.modelQuery ?? "";
  return next;
}

export function catalogRouteURL(href: string, state: CatalogRoute): string {
  const url = new URL(href);
  for (const name of parameters) url.searchParams.delete(name);
  const values: Record<string, string | null> = {
    q: state.query || null,
    type: state.type === "all" ? null : state.type,
    payment: state.payment === "all" ? null : state.payment,
    sort: state.sort === "default" ? null : state.sort,
    family: state.family === "all" ? null : state.family,
    rate_min: state.range ? String(state.range[0]) : null,
    rate_max: state.range ? String(state.range[1]) : null,
    site: state.site,
    group: state.site ? state.group : null,
    group_q: state.site && state.groupQuery ? state.groupQuery : null,
    group_family:
      state.site && state.groupFamily !== "all" ? state.groupFamily : null,
    group_rate_min:
      state.site && state.groupRange ? String(state.groupRange[0]) : null,
    group_rate_max:
      state.site && state.groupRange ? String(state.groupRange[1]) : null,
    model_q:
      state.site && state.group && state.modelQuery ? state.modelQuery : null,
  };
  for (const [name, value] of Object.entries(values))
    if (value !== null) url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
