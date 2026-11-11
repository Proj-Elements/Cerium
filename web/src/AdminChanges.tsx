import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { api, APIError, message } from "./api";
import { createLatestRequest } from "./latest-request";
import { ChangeList } from "./Changes";
import { Glyph } from "./ui";
import type { ChangeNotice, ChangePage, Site } from "./types";

const pageSize = 50;
export function AdminChanges({
  base,
  sites,
  busy,
  revision,
  onVisibility,
  unauthorized,
}: {
  base: string;
  sites: Site[];
  busy: boolean;
  revision: string;
  onVisibility: (change: ChangeNotice) => void;
  unauthorized: () => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState<ChangePage>({
    changes: [],
    total: 0,
    offset: 0,
    limit: pageSize,
  });
  const [requests] = useState(() => createLatestRequest<ChangePage>());
  const onUnauthorized = useRef(unauthorized);
  const serial = useRef(0);
  onUnauthorized.current = unauthorized;
  const load = useCallback(async () => {
    const current = ++serial.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
        q: query.trim(),
      });
      const result = await requests.run((signal) =>
        api<ChangePage>(`${base}/changes?${params}`, "GET", undefined, 15000, {
          signal,
        }),
      );
      if (!result.current) return;
      const lastPage = Math.max(
        0,
        Math.ceil(result.value.total / pageSize) - 1,
      );
      if (offset > lastPage * pageSize) setOffset(lastPage * pageSize);
      else setPage(result.value);
    } catch (error) {
      if (error instanceof APIError && error.status === 401)
        onUnauthorized.current();
      else setError(message(error));
    } finally {
      if (current === serial.current) setLoading(false);
    }
  }, [base, offset, query, requests]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
      serial.current++;
      requests.cancel();
    };
  }, [load, requests, revision]);
  return (
    <section className="admin-changes" aria-busy={loading}>
      <div className="section-heading">
        <div>
          <h2>分组、模型与价格的变化</h2>
          <p>
            可检索保留的全部历史；前台展示 7 天内最新 20
            条通报，可随时撤下或恢复。
          </p>
        </div>
      </div>
      <div className="admin-toolbar">
        <TextField
          aria-label="搜索动态记录"
          className="search"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setOffset(0);
          }}
          variant="secondary"
        >
          <Glyph name="magnifier" size={18} />
          <Input placeholder="搜索站名、分组或模型…" />
        </TextField>
        <Button
          variant="ghost"
          isDisabled={loading}
          onPress={() => void load()}
        >
          刷新记录
        </Button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <ChangeList
        changes={page.changes}
        sites={sites}
        busy={busy || loading}
        onVisibility={onVisibility}
      />
      <div className="admin-history-pagination">
        <span role="status">
          {loading
            ? "正在加载动态记录…"
            : `第 ${Math.floor(page.offset / page.limit) + 1} / ${Math.max(1, Math.ceil(page.total / page.limit))} 页 · 共 ${page.total} 条`}
        </span>
        <Button
          variant="ghost"
          isDisabled={loading || offset === 0}
          onPress={() => setOffset(Math.max(0, offset - pageSize))}
        >
          上一页
        </Button>
        <Button
          variant="ghost"
          isDisabled={loading || offset + pageSize >= page.total}
          onPress={() => setOffset(offset + pageSize)}
        >
          下一页
        </Button>
      </div>
    </section>
  );
}
