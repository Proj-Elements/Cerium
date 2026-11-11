import { useCallback, useEffect, useRef, useState } from "react";
import { api, message } from "./api";
import type { Directory } from "./types";

export function useDirectory() {
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let active: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden)
        timer = setTimeout(
          () => void load(),
          Math.min(120000, 15000 * 2 ** failures),
        );
    };
    const load = () => {
      if (stopped) return Promise.resolve();
      if (active) return active;
      clearTimeout(timer);
      controller = new AbortController();
      setLoading(true);
      active = api<Directory>("/api/sites", "GET", undefined, 15000, {
        signal: controller.signal,
        conditional: true,
      })
        .then((result) => {
          if (stopped) return;
          failures = 0;
          setData(result);
          setError("");
        })
        .catch((failure: unknown) => {
          if (stopped || controller?.signal.aborted) return;
          failures = Math.min(failures + 1, 3);
          setError(message(failure));
        })
        .finally(() => {
          active = undefined;
          if (!stopped) {
            setLoading(false);
            schedule();
          }
        });
      return active;
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void load();
    };
    refresh.current = load;
    if (!document.hidden) void load();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const load = useCallback(() => refresh.current(), []);
  return { data, error, loading, load };
}
