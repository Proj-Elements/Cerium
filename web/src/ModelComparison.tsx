import { useId, useMemo, useState } from "react";
import { Input, Label, ScrollShadow, TextField } from "@heroui/react";
import { Field } from "./ui";
import { compareModelCosts, comparisonModels } from "./model-comparison";
import { modelDisplayName } from "./model-display";
import { formatNumber } from "./number-format";
import type { Site } from "./types";
import "./model-comparison.css";

export function ModelComparison({ sites }: { sites: Site[] }) {
  const [open, setOpen] = useState(false);
  const models = useMemo(
    () => (open ? comparisonModels(sites) : []),
    [sites, open],
  );
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("tokens");
  const [currency, setCurrency] = useState("CNY");
  const [input, setInput] = useState("1000000");
  const [output, setOutput] = useState("1000000");
  const [requests, setRequests] = useState("1");
  const listId = useId();
  const selected = model || models[0] || "";
  const count = (value: string) => (value.trim() ? Number(value) : NaN);
  const rows = useMemo(
    () =>
      open
        ? compareModelCosts(sites, {
            model: selected,
            mode: mode === "request" ? "request" : "tokens",
            currency: currency === "USD" ? "USD" : "CNY",
            inputTokens: count(input),
            outputTokens: count(output),
            requests: count(requests),
          })
        : [],
    [open, sites, selected, mode, currency, input, output, requests],
  );
  const known = rows.filter((row) => row.cost != null).length;
  if (
    !sites.some((site) =>
      site.catalog?.groups.some((group) => group.models.length),
    )
  )
    return null;
  return (
    <details
      className="model-comparison"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>按模型比较费用</summary>
      {open && (
        <div className="comparison-body">
          <p className="muted">
            同一完整模型
            ID，使用公开站点单价估算。单价已含分组倍率；人民币按各站充值兑换价折算。
          </p>
          <div className="comparison-controls">
            <TextField value={selected} onChange={setModel} variant="secondary">
              <Label>比较模型</Label>
              <Input list={listId} autoComplete="off" />
            </TextField>
            <datalist id={listId}>
              {models.map((name) => (
                <option key={name} value={name}>
                  {modelDisplayName(name)}
                </option>
              ))}
            </datalist>
            <label className="comparison-select">
              <span>比较计费方式</span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="tokens">按 tokens</option>
                <option value="request">按次</option>
              </select>
            </label>
            <label className="comparison-select">
              <span>比较费用单位</span>
              <select
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                <option value="CNY">人民币充值成本</option>
                <option value="USD">USD 站内额度</option>
              </select>
            </label>
            {mode === "tokens" ? (
              <>
                <Field
                  label="输入 tokens"
                  value={input}
                  onChange={setInput}
                  type="number"
                  min="0"
                  step="1"
                />
                <Field
                  label="输出 tokens"
                  value={output}
                  onChange={setOutput}
                  type="number"
                  min="0"
                  step="1"
                />
              </>
            ) : (
              <Field
                label="请求次数"
                value={requests}
                onChange={setRequests}
                type="number"
                min="1"
                step="1"
              />
            )}
          </div>
          <p className="field-help" role="status">
            {known} 个分组可计算，{rows.length - known} 个分组暂不可比较。USD
            站内额度仅比较账面消耗，不代表美元现金成本。
          </p>
          {rows.length ? (
            <ScrollShadow className="comparison-table-wrap" size={20}>
              <table className="price-table comparison-table">
                <thead>
                  <tr>
                    <th>站点 / 分组</th>
                    <th>预估费用</th>
                    <th>兑换与快照</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.siteId}-${row.groupId}`}>
                      <td>
                        <strong>{row.siteName}</strong>
                        <small>{row.groupName}</small>
                      </td>
                      <td>
                        {row.cost == null ? (
                          <span className="muted">{row.reason}</span>
                        ) : (
                          <strong className="comparison-cost">
                            {currency === "CNY" ? "¥" : "$"}
                            {formatNumber(row.cost)}
                            {currency === "USD" && <small> 站内额度</small>}
                          </strong>
                        )}
                      </td>
                      <td className="muted">
                        {row.exchange != null && (
                          <small>
                            {formatNumber(row.exchange)} CNY / USD 额度
                          </small>
                        )}
                        {row.snapshotAt ? (
                          <time dateTime={row.snapshotAt}>
                            {new Date(row.snapshotAt).toLocaleString("zh-CN")}
                          </time>
                        ) : (
                          "无采集时间"
                        )}
                        {row.stale && <small>最近成功快照，当前同步异常</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollShadow>
          ) : (
            <p className="muted">当前筛选范围没有这个完整模型 ID。</p>
          )}
          <p className="field-help">
            动态价、未知单价和未提供兑换价的站点保留说明，不参与费用排序。默认参考价不用于此比较；估算不含缓存、长上下文或其他附加收费。
          </p>
        </div>
      )}
    </details>
  );
}
