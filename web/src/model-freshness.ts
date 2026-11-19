import type { Group } from "./types";

export function modelFreshness(
  group: Group,
  catalogTime: string | null,
  interval = 900,
  now = Date.now(),
) {
  const oneTime = group.models_source === "gateway_once";
  const snapshotAt = group.models_fetched_at || (oneTime ? null : catalogTime);
  const timestamp = snapshotAt ? Date.parse(snapshotAt) : NaN;
  return {
    snapshotAt,
    oneTime,
    stale:
      !group.models_known ||
      !Number.isFinite(timestamp) ||
      timestamp > now + 300000 ||
      now - timestamp > interval * 3000,
  };
}
