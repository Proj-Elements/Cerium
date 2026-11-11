import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogRouteURL,
  readCatalogRoute,
  updateCatalogRoute,
  type CatalogRoute,
} from "./catalog-route";

export function useCatalogRoute() {
  const [state, setState] = useState(() => readCatalogRoute(location.search));
  const current = useRef(state);
  const transientUntil = useRef(0);
  useEffect(() => {
    const restore = () => {
      const next = readCatalogRoute(location.search);
      current.current = next;
      transientUntil.current = 0;
      setState(next);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const update = useCallback(
    (patch: Partial<CatalogRoute>, transient = false) => {
      const next = updateCatalogRoute(current.current, patch);
      const url = catalogRouteURL(location.href, next);
      if (url !== `${location.pathname}${location.search}${location.hash}`) {
        const now = Date.now();
        const replace = transient && now < transientUntil.current;
        history[replace ? "replaceState" : "pushState"](null, "", url);
        transientUntil.current = transient ? now + 750 : 0;
      }
      current.current = next;
      setState(next);
    },
    [],
  );
  return [state, update] as const;
}
