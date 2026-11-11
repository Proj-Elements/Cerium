export function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(
    "en-US",
    value !== 0 && Math.abs(value) < 0.000001
      ? {
          maximumSignificantDigits: 6,
          notation: Math.abs(value) < 0.000000001 ? "scientific" : "standard",
        }
      : { maximumFractionDigits: 6 },
  ).format(value);
}
