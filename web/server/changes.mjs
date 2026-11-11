const dynamic = (group) => group.multiplier_source === "auto";
const rate = (group) => (dynamic(group) ? null : (group.multiplier ?? null));
const sameRate = (a, b) =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a - b) <=
      Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8);
const priceFields = ["input", "output", "request", "cache_read", "cache_write"];
const samePriceAmount = (before, after) =>
  before === after ||
  (before !== null &&
    after !== null &&
    Math.abs(before - after) <=
      1e-9 * Math.max(Math.abs(before), Math.abs(after)));
const normalizedPrice = (price) => ({
  model: price.model,
  mode: price.mode ?? "unknown",
  ...Object.fromEntries(
    priceFields.map((field) => [field, price[field] ?? null]),
  ),
  expression: (price.expression ?? "").trim(),
});

function priceChanges(previous, current) {
  const before = new Map(
    (previous.prices ?? []).map((price) => [
      price.model,
      normalizedPrice(price),
    ]),
  );
  const after = new Map(
    (current.prices ?? []).map((price) => [
      price.model,
      normalizedPrice(price),
    ]),
  );
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((model) => {
      const old = before.get(model) ?? null,
        price = after.get(model) ?? null;
      if (
        old &&
        price &&
        old.mode === price.mode &&
        old.expression === price.expression &&
        priceFields.every((field) => samePriceAmount(old[field], price[field]))
      )
        return [];
      return [{ model, before: old, after: price }];
    });
}

/** Compare public catalog facts, ignoring order and incomplete model discovery. */
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
    else {
      if (!sameRate(rate(old), rate(group)) || dynamic(old) !== dynamic(group))
        changes.push({ ...detail, kind: "multiplier" });
      if (old.models_known === true && group.models_known === true) {
        const oldModels = new Set(old.models ?? []),
          models = new Set(group.models ?? []),
          modelsAdded = [...models]
            .filter((model) => !oldModels.has(model))
            .sort(),
          modelsRemoved = [...oldModels]
            .filter((model) => !models.has(model))
            .sort();
        if (modelsAdded.length || modelsRemoved.length)
          changes.push({
            ...detail,
            kind: "models",
            models_added: modelsAdded,
            models_removed: modelsRemoved,
          });
      }
      const prices = priceChanges(old, group);
      if (prices.length)
        changes.push({ ...detail, kind: "prices", price_changes: prices });
    }
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
