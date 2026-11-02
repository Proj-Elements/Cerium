import { Button, Label, Slider } from "@heroui/react";
import { Glyph, n } from "./ui";
import { PlatformIcon } from "./relay";
import {
  familyNames,
  groupFamilies,
  rateMaximum,
  type FamilyFilter,
  type GroupFamily,
  type RateRange,
} from "./groups";
import type { Group } from "./types";

export function FamilyFilters({
  groups,
  value,
  onChange,
}: {
  groups: Group[];
  value: FamilyFilter;
  onChange: (family: FamilyFilter) => void;
}) {
  const families = (Object.keys(familyNames) as GroupFamily[]).filter(
    (family) => groups.some((group) => groupFamilies(group).includes(family)),
  );
  return (
    <div className="family-filters" role="group" aria-label="分组平台筛选">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={value === "all"}
        onPress={() => onChange("all")}
      >
        <Glyph name="layers" size={14} />
        全部分组
      </Button>
      {families.map((family) => (
        <Button
          key={family}
          size="sm"
          variant="ghost"
          aria-pressed={value === family}
          onPress={() => onChange(family)}
        >
          <PlatformIcon family={family} />
          {familyNames[family]}
        </Button>
      ))}
    </div>
  );
}

export function RateFilter({
  groups,
  value,
  onChange,
}: {
  groups: Group[];
  value: RateRange;
  onChange: (range: RateRange) => void;
}) {
  const max = rateMaximum(groups, value);
  const range = value ?? [0, max];
  return (
    <div className={`rate-filter ${value ? "is-active" : ""}`}>
      <Slider
        value={range}
        onChange={(next) => {
          if (!Array.isArray(next)) return;
          onChange(
            next[0] === 0 && next[1] === max ? null : [next[0], next[1]],
          );
        }}
        minValue={0}
        maxValue={max}
        step={0.01}
        formatOptions={{ maximumFractionDigits: 2 }}
      >
        <Label>分组倍率</Label>
        <Slider.Output>
          {() => (value ? `${n(range[0])}× – ${n(range[1])}×` : "不限倍率")}
        </Slider.Output>
        <Slider.Track>
          <Slider.Fill />
          <Slider.Thumb index={0} aria-label="倍率下限（不低于）" />
          <Slider.Thumb index={1} aria-label="倍率上限（不高于）" />
        </Slider.Track>
      </Slider>
      <div className="rate-filter-bounds">
        <span>
          不低于 <strong>{n(range[0])}×</strong>
        </span>
        <span>
          不高于 <strong>{n(range[1])}×</strong>
        </span>
        {value && (
          <Button size="sm" variant="ghost" onPress={() => onChange(null)}>
            重置倍率
          </Button>
        )}
      </div>
    </div>
  );
}
