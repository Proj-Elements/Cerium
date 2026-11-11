import { useMemo, useState } from "react";
import { Button, Input, ScrollShadow, TextField } from "@heroui/react";
import { Empty, Glyph } from "./ui";
import { PlatformIcon, rateLabel } from "./relay";
import { groupFamilies } from "./groups";
import {
  ModelIcon,
  ModelPriceBadges,
  ModelPriceCells,
  PriceAmount,
  useModelReference,
} from "./ModelPrice";
import { modelDisplayName } from "./model-display";
import type { Group } from "./types";

export function Models({
  group,
  type,
  filter,
}: {
  group: Group;
  type: string;
  filter?: { query: string; onChange: (query: string) => void };
}) {
  const [localQuery, setLocalQuery] = useState("");
  const query = filter?.query ?? localQuery;
  const setQuery = filter?.onChange ?? setLocalQuery;
  const [limit, setLimit] = useState(30);
  const reference = useModelReference();
  const prices = useMemo(
    () => new Map((group.prices ?? []).map((price) => [price.model, price])),
    [group.prices],
  );
  const matches = group.models.filter((model) =>
    `${model} ${modelDisplayName(model)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="model-panel" aria-label={`${group.name} 的模型`}>
      <div className="model-heading">
        <div>
          <h3>
            <span className="model-platforms">
              {groupFamilies(group).map((family) => (
                <PlatformIcon family={family} key={family} />
              ))}
            </span>
            {group.name}
            <span className="model-count">
              {group.models_known
                ? `${group.models.length} 个模型`
                : "模型快照"}
            </span>
          </h3>
          <p className="muted">
            {group.description || "此分组当前公开的可用模型。"}
          </p>
        </div>
        <span className="model-rate">{rateLabel(group)}</span>
      </div>
      <TextField
        aria-label={`搜索 ${group.name} 的模型`}
        className="search model-search"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setLimit(30);
        }}
        variant="secondary"
      >
        <Glyph name="magnifier" size={16} />
        <Input placeholder="搜索这个分组的模型…" />
      </TextField>
      <div className="model-caption">
        <span>USD / 百万 tokens</span>
        <span>
          {reference.failed
            ? "默认价暂不可用"
            : reference.match
              ? "站点价优先"
              : "默认价载入中…"}
        </span>
        {!group.models_known && <span>列表可能不完整</span>}
      </div>
      {matches.length ? (
        <ScrollShadow className="price-table-wrap" size={24}>
          <table className="price-table">
            <thead>
              <tr>
                <th>模型名称</th>
                <th>输入</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(0, limit).map((model) => {
                const price = prices.get(model);
                const match = reference.match?.(model);
                return (
                  <tr key={model} data-model-id={model}>
                    <td>
                      <div className="model-identity">
                        <ModelIcon model={model} match={match} />
                        <span className="model-name" title={model}>
                          {modelDisplayName(model)}
                        </span>
                        <ModelPriceBadges
                          model={model}
                          site={price}
                          match={match}
                        />
                      </div>
                      {price &&
                        (price.cache_read != null ||
                          price.cache_write != null) && (
                          <small>
                            缓存读 <PriceAmount value={price.cache_read} /> / 写{" "}
                            <PriceAmount value={price.cache_write} />
                          </small>
                        )}
                    </td>
                    <ModelPriceCells site={price} match={match} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollShadow>
      ) : (
        <Empty
          title={query ? "没有匹配的模型" : "模型列表暂未公开"}
          description={
            query
              ? "试试更短的模型名称。"
              : group.models_known
                ? "该分组当前没有公开模型。"
                : "未知不代表不可用，请以站点公布的信息为准。"
          }
        />
      )}
      {matches.length > limit && (
        <Button
          size="sm"
          variant="secondary"
          className="load-more"
          onPress={() => setLimit(limit + 50)}
        >
          再显示 50 个 · 共 {matches.length} 个
        </Button>
      )}
      <p className="model-price-help">
        <a
          href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
          target="_blank"
          rel="noopener noreferrer"
          title={
            reference.catalog
              ? `快照 ${reference.catalog.fetchedAt.slice(0, 10)} · SHA256 ${reference.catalog.sha256}`
              : undefined
          }
        >
          LiteLLM 默认价
        </a>
        未乘分组倍率；站点价已含倍率。
        {type === "newapi" && "动态结算以站点为准。"}
      </p>
      {group.models_fetched_at && (
        <p className="field-help model-time">
          {group.models_source === "gateway_once"
            ? "一次性网关快照 · "
            : "模型发现于 "}
          {new Date(group.models_fetched_at).toLocaleString("zh-CN")}
        </p>
      )}
    </section>
  );
}
