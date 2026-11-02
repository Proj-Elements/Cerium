const dynamic = (group) => group.multiplier_source === "auto";
const rate = (group) => (dynamic(group) ? null : (group.multiplier ?? null));
const sameRate = (a, b) =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a - b) <=
      Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8);

export function compareCatalogs(previous, current) {
  if (!previous) return [];
  const before = new Map(previous.groups.map((group) => [group.id, group]));
  const after = new Map(current.groups.map((group) => [group.id, group]));
  const changes = [];
  for (const group of current.groups) {
    const old = before.get(group.id);
    const detail = {
      group_id: group.id,
      name: group.name,
      before: old ? rate(old) : null,
      after: rate(group),
      before_dynamic: old ? dynamic(old) : false,
      after_dynamic: dynamic(group),
    };
    if (!old) changes.push({ ...detail, kind: "added" });
    else if (
      !sameRate(rate(old), rate(group)) ||
      dynamic(old) !== dynamic(group)
    )
      changes.push({ ...detail, kind: "multiplier" });
  }
  for (const group of previous.groups) {
    if (!after.has(group.id))
      changes.push({
        kind: "removed",
        group_id: group.id,
        name: group.name,
        before: rate(group),
        after: null,
        before_dynamic: dynamic(group),
        after_dynamic: false,
      });
  }
  return changes;
}
