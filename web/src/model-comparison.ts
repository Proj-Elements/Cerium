import { validPrice } from "./model-pricing.ts";
import type { Site } from "./types";

export type CostScenario = {
  model: string;
  mode: "tokens" | "request";
  currency: "CNY" | "USD";
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type CostComparison = {
  siteId: string;
  siteName: string;
  groupId: string;
  groupName: string;
  cost?: number;
  reason?: string;
  input?: number;
  output?: number;
  request?: number;
  exchange?: number;
  snapshotAt: string | null;
  stale: boolean;
};

export function comparisonModels(sites: Site[]) {
  return [
    ...new Set(
      sites
        .filter((site) => site.enabled)
        .flatMap((site) =>
          (site.catalog?.groups ?? []).flatMap((group) => group.models),
        ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function compareModelCosts(sites: Site[], scenario: CostScenario) {
  const validScenario =
    validPrice(scenario.inputTokens) &&
    validPrice(scenario.outputTokens) &&
    validPrice(scenario.requests) &&
    (scenario.mode === "tokens"
      ? scenario.inputTokens + scenario.outputTokens > 0
      : scenario.requests > 0);
  const rows: CostComparison[] = [];
  for (const site of sites) {
    if (!site.enabled) continue;
    for (const group of site.catalog?.groups ?? []) {
      if (!group.models.includes(scenario.model)) continue;
      const row: CostComparison = {
        siteId: site.id,
        siteName: site.name,
        groupId: group.id,
        groupName: group.name,
        snapshotAt: site.fetched_at,
        stale: site.status !== "ok" && site.status !== "manual",
      };
      rows.push(row);
      const price = group.prices?.find(
        (candidate) => candidate.model === scenario.model,
      );
      if (!validScenario) {
        row.reason = "请填写有效且非零的用量";
        continue;
      }
      if (price?.mode === "dynamic" || group.multiplier_source === "auto") {
        row.reason = "动态计费，无法直接比较";
        continue;
      }
      if (!price || price.mode === "unknown") {
        row.reason = "未公开站点单价";
        continue;
      }
      if (price.mode !== scenario.mode) {
        row.reason = price.mode === "request" ? "按次计费" : "按 token 计费";
        continue;
      }
      let amount: number;
      if (scenario.mode === "request") {
        if (!validPrice(price.request)) {
          row.reason = "未公开按次单价";
          continue;
        }
        row.request = price.request;
        amount = price.request * scenario.requests;
      } else {
        if (
          (scenario.inputTokens > 0 && !validPrice(price.input)) ||
          (scenario.outputTokens > 0 && !validPrice(price.output))
        ) {
          row.reason = "所需方向的单价未公开";
          continue;
        }
        row.input = validPrice(price.input) ? price.input : undefined;
        row.output = validPrice(price.output) ? price.output : undefined;
        amount =
          ((row.input ?? 0) * scenario.inputTokens +
            (row.output ?? 0) * scenario.outputTokens) /
          1000000;
      }
      if (scenario.currency === "CNY") {
        if (
          !validPrice(site.recharge_cny) ||
          !validPrice(site.recharge_usd) ||
          site.recharge_usd === 0
        ) {
          row.reason = "未提供有效充值兑换价";
          continue;
        }
        row.exchange = site.recharge_cny / site.recharge_usd;
        amount *= row.exchange;
      }
      if (!Number.isFinite(amount)) {
        row.reason = "用量或费用超出可计算范围";
        continue;
      }
      row.cost = amount;
    }
  }
  return rows.sort(
    (left, right) =>
      (left.cost ?? Infinity) - (right.cost ?? Infinity) ||
      left.siteName.localeCompare(right.siteName) ||
      left.groupName.localeCompare(right.groupName),
  );
}
