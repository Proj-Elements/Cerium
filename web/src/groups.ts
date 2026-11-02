import type { Group } from "./types";

export type GroupFamily = "openai" | "anthropic" | "gemini" | "other";
export type FamilyFilter = "all" | GroupFamily;
export type RateRange = [number, number] | null;

export const familyNames: Record<GroupFamily, string> = {
  openai: "GPT / Codex",
  anthropic: "Claude",
  gemini: "Gemini",
  other: "其他",
};

function identify(value: string): GroupFamily | null {
  if (
    /(?:^|[\s/_.-])(gpt|chatgpt|codex|openai|o[1345])(?:\b|[-_.\d])/i.test(
      value,
    )
  )
    return "openai";
  if (/claude|anthropic/i.test(value)) return "anthropic";
  if (/gemini/i.test(value)) return "gemini";
  return null;
}

export function groupFamilies(group: Group): GroupFamily[] {
  // An explicit upstream platform is authoritative, even for a mixed model list.
  if (group.platform) return [identify(group.platform) ?? "other"];
  const models = [
    ...new Set(group.models.map(identify).filter((value) => value !== null)),
  ];
  return models.length
    ? models
    : [identify(`${group.id} ${group.name}`) ?? "other"];
}

export function fixedRate(group: Group): number | null {
  return group.multiplier_source !== "auto" &&
    group.multiplier != null &&
    Number.isFinite(group.multiplier)
    ? group.multiplier
    : null;
}

export function matchesGroup(
  group: Group,
  family: FamilyFilter,
  range: RateRange,
  query = "",
) {
  const rate = fixedRate(group);
  return (
    (family === "all" || groupFamilies(group).includes(family)) &&
    (range === null ||
      (rate !== null &&
        rate >= range[0] - Number.EPSILON * Math.max(1, rate) * 8 &&
        rate <= range[1] + Number.EPSILON * Math.max(1, rate) * 8)) &&
    `${group.name} ${group.id} ${group.description ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
}

export function rateMaximum(groups: Group[], range: RateRange = null) {
  return groups.reduce(
    (maximum, group) => Math.max(maximum, Math.ceil(fixedRate(group) ?? 0)),
    Math.max(2, range?.[1] ?? 0),
  );
}

export function minimumRate(groups: Group[]) {
  return groups.reduce<number | null>((minimum, group) => {
    const rate = fixedRate(group);
    return rate === null ? minimum : Math.min(minimum ?? rate, rate);
  }, null);
}
