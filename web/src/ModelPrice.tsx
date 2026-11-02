import { useEffect, useState, type ReactNode } from "react";
import { Button, Tooltip } from "@heroui/react";
import { Glyph, n } from "./ui";
import {
  createPriceMatcher,
  modelBrand,
  resolveModelPrice,
} from "./model-pricing";
import type { ReferenceCatalog, ReferenceMatch } from "./model-pricing";
import type { Price } from "./types";

let reference:
  | {
      catalog: ReferenceCatalog;
      match: ReturnType<typeof createPriceMatcher>;
    }
  | undefined;
let loading: Promise<NonNullable<typeof reference>> | undefined;

export function useModelReference() {
  const [value, setValue] = useState(reference);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    loading ??= import("./data/model-prices.json")
      .then(({ default: catalog }) => {
        reference = { catalog, match: createPriceMatcher(catalog) };
        return reference;
      })
      .catch((error) => {
        loading = undefined;
        throw error;
      });
    void loading
      .then((result) => {
        if (active) setValue(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  return { ...value, failed };
}

const assets = import.meta.glob<string>("./assets/models/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
const icons: Record<string, [string, string, boolean?]> = {
  openai: ["openai", "OpenAI", true],
  anthropic: ["claude-color", "Anthropic / Claude"],
  google: ["gemini-color", "Google / Gemini"],
  zai: ["zai", "Z.ai", true],
  qwen: ["qwen-color", "Qwen"],
  deepseek: ["deepseek-color", "DeepSeek"],
  moonshot: ["moonshot", "Moonshot / Kimi", true],
  minimax: ["minimax-color", "MiniMax"],
  mistral: ["mistral-color", "Mistral"],
  xai: ["grok", "xAI / Grok", true],
  meta: ["meta-color", "Meta"],
  cohere: ["cohere-color", "Cohere"],
  perplexity: ["perplexity-color", "Perplexity"],
  bytedance: ["bytedance-color", "ByteDance"],
  stepfun: ["stepfun-color", "StepFun"],
  tencent: ["hunyuan-color", "Tencent / Hunyuan"],
  xiaomi: ["xiaomimimo", "Xiaomi / MiMo", true],
  ai21: ["ai21", "AI21", true],
};

export function ModelIcon({
  model,
  match,
}: {
  model: string;
  match?: ReferenceMatch;
}) {
  const brand = modelBrand(model, match);
  const icon = icons[brand];
  const src = icon && assets[`./assets/models/${icon[0]}.svg`];
  return (
    <span
      className={`model-icon ${icon?.[2] ? "model-icon-mono" : ""}`}
      data-brand={brand}
      role="img"
      aria-label={icon?.[1] ?? "未知供应商"}
    >
      {src ? (
        <img src={src} alt="" width="18" height="18" />
      ) : (
        <Glyph name="layers" size={17} />
      )}
    </span>
  );
}

function PriceHint({
  label,
  name,
  children,
}: {
  label: string;
  name: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip delay={180} closeDelay={120} isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        className={`price-badge ${label === "动态" ? "price-badge-dynamic" : ""}`}
        aria-label={name}
        onPress={() => setOpen(true)}
      >
        {label}
      </Button>
      <Tooltip.Content className="price-tooltip" placement="top" offset={6}>
        {children}
      </Tooltip.Content>
    </Tooltip>
  );
}

function DefaultHint({
  model,
  match,
}: {
  model: string;
  match: ReferenceMatch;
}) {
  return (
    <PriceHint label="默认" name={`${model} 的默认价格来源`}>
      <strong>LiteLLM 默认参考价</strong>
      <span className="reference-model">{match.model}</span>
      <span>
        {match.kind === "exact" ? "完整型号匹配" : "保守归一化匹配"} ·{" "}
        {match.price.provider}
      </span>
      <span>基础 USD 单价，未乘分组或充值倍率，不代表本站实际收费。</span>
      {match.price.tiered && (
        <span>长上下文等阶梯价格可能不同，此处仅展示基础档位。</span>
      )}
    </PriceHint>
  );
}

export function ModelPriceBadges({
  model,
  site,
  match,
}: {
  model: string;
  site?: Price;
  match?: ReferenceMatch;
}) {
  const price = resolveModelPrice(site, match);
  if (price.mode === "request") return null;
  const defaults = price.inputDefault || price.outputDefault;
  if (!defaults && !price.dynamic) return null;
  return (
    <span className="price-flags">
      {defaults && match && <DefaultHint model={model} match={match} />}
      {price.dynamic && (
        <PriceHint label="动态" name={`${model} 的动态计费说明`}>
          <strong>站点使用动态计费</strong>
          <span>表中默认价仅供参考，实际结算以站点计费规则为准。</span>
          {price.expression ? (
            <code>{price.expression}</code>
          ) : (
            <span>站点未公开计费表达式。</span>
          )}
        </PriceHint>
      )}
    </span>
  );
}

export function ModelPriceCells({
  site,
  match,
}: {
  site?: Price;
  match?: ReferenceMatch;
}) {
  const price = resolveModelPrice(site, match);
  if (price.mode === "request")
    return (
      <td colSpan={2} className="price-note">
        {price.request == null ? "未公开按次价格" : `$${n(price.request)} / 次`}
      </td>
    );
  return (
    <>
      <td
        data-price-source={
          price.inputDefault
            ? "default"
            : price.input != null
              ? "site"
              : "unknown"
        }
      >
        <span className="price-number">{n(price.input)}</span>
      </td>
      <td
        data-price-source={
          price.outputDefault
            ? "default"
            : price.output != null
              ? "site"
              : "unknown"
        }
      >
        <span className="price-number">{n(price.output)}</span>
      </td>
    </>
  );
}
