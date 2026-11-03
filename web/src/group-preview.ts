export const MAX_PREVIEW_GROUPS = 5;

export function groupPreviewCount(
  available: number,
  groupWidths: number[],
  moreWidths: number[],
  gap: number,
) {
  const maximum = Math.min(MAX_PREVIEW_GROUPS, groupWidths.length);
  let used = 0;
  let count = 1;
  for (let index = 0; index < maximum; index++) {
    used += groupWidths[index] + (index ? gap : 0);
    const more = moreWidths[index] ?? 0;
    if (used + more + (more ? gap : 0) <= available) count = index + 1;
  }
  return maximum ? count : 0;
}
