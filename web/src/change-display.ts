import type { GroupChange, Price } from "./types";
import { formatNumber } from "./number-format.ts";

const amount = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "未公开"
    : `$${formatNumber(value)}`;

export function priceDescription(price: Price | null): string {
  if (!price || price.mode === "unknown") return "价格未公开";
  if (price.mode === "request") return `${amount(price.request)} / 次`;
  if (price.mode === "dynamic")
    return price.expression
      ? `动态：${price.expression}`
      : "动态计费，规则未公开";
  return [
    `输入 ${amount(price.input)}`,
    `输出 ${amount(price.output)}`,
    ...(price.cache_read == null ? [] : [`缓存读 ${amount(price.cache_read)}`]),
    ...(price.cache_write == null
      ? []
      : [`缓存写 ${amount(price.cache_write)}`]),
    "USD / 百万 tokens",
  ].join(" · ");
}

export function changeSummary(change: GroupChange): string {
  if (change.kind === "models")
    return [
      change.models_added?.length
        ? `新增 ${change.models_added.length} 个模型`
        : "",
      change.models_removed?.length
        ? `移除 ${change.models_removed.length} 个模型`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  if (change.kind === "prices")
    return `${change.price_changes?.length ?? 0} 个模型价格调整`;
  return "";
}
