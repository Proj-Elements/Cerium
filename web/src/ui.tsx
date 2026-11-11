import type { ReactNode } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  TextField,
  Tooltip,
} from "@heroui/react";
import { InlineSelect } from "@heroui-pro/react/inline-select";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { Icon } from "@iconify/react/offline";
import sun from "@iconify-icons/gravity-ui/sun";
import moon from "@iconify-icons/gravity-ui/moon";
import display from "@iconify-icons/gravity-ui/display";
import layers from "@iconify-icons/gravity-ui/layers";
import arrowUpRight from "@iconify-icons/gravity-ui/arrow-up-right";
import arrowRight from "@iconify-icons/gravity-ui/arrow-right";
import creditCard from "@iconify-icons/gravity-ui/credit-card";
import clock from "@iconify-icons/gravity-ui/clock";
import chevronUp from "@iconify-icons/gravity-ui/chevron-up";
import chevronDown from "@iconify-icons/gravity-ui/chevron-down";
import magnifier from "@iconify-icons/gravity-ui/magnifier";
import plus from "@iconify-icons/gravity-ui/plus";
import shieldCheck from "@iconify-icons/gravity-ui/shield-check";
import arrowsRotateRight from "@iconify-icons/gravity-ui/arrows-rotate-right";
import bell from "@iconify-icons/gravity-ui/bell";
import arrowLeft from "@iconify-icons/gravity-ui/arrow-left";
import arrowUp from "@iconify-icons/gravity-ui/arrow-up";
import arrowDown from "@iconify-icons/gravity-ui/arrow-down";
import xmark from "@iconify-icons/gravity-ui/xmark";
import sliders from "@iconify-icons/gravity-ui/sliders";
import circleInfo from "@iconify-icons/gravity-ui/circle-info";
import check from "@iconify-icons/gravity-ui/check";
import circleCheck from "@iconify-icons/gravity-ui/circle-check";
import eye from "@iconify-icons/gravity-ui/eye";
import eyeSlash from "@iconify-icons/gravity-ui/eye-slash";
import chartLine from "@iconify-icons/gravity-ui/chart-line";
import pencil from "@iconify-icons/gravity-ui/pencil";
import trashBin from "@iconify-icons/gravity-ui/trash-bin";
import { isThemePreference, useThemePreference } from "./theme";
import { formatNumber } from "./number-format";

const icons = {
  sun,
  moon,
  display,
  layers,
  "arrow-up-right": arrowUpRight,
  "arrow-right": arrowRight,
  "credit-card": creditCard,
  clock,
  "chevron-up": chevronUp,
  "chevron-down": chevronDown,
  magnifier,
  plus,
  "shield-check": shieldCheck,
  refresh: arrowsRotateRight,
  bell,
  "arrow-left": arrowLeft,
  "arrow-up": arrowUp,
  "arrow-down": arrowDown,
  xmark,
  sliders,
  info: circleInfo,
  check,
  "circle-check": circleCheck,
  eye,
  "eye-slash": eyeSlash,
  activity: chartLine,
  pencil,
  trash: trashBin,
};

export function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const icon = icons[name as keyof typeof icons];
  return icon ? (
    <Icon icon={icon} width={size} height={size} aria-hidden />
  ) : null;
}
export function IconButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: string;
  onPress: () => void;
}) {
  return (
    <Tooltip delay={250}>
      <Button
        aria-label={label}
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={onPress}
      >
        <Glyph name={icon} />
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
export function Header({
  children,
  admin = false,
  onChanges,
}: {
  children?: ReactNode;
  admin?: boolean;
  onChanges?: () => void;
}) {
  return (
    <header className="site-header">
      <a href="/" className="brand" aria-label="Cerium 首页">
        <span>
          Cerium
          <span className="brand-caption">
            {admin ? "管理工作台" : "AI 中转站目录"}
          </span>
        </span>
      </a>
      {!admin && (
        <nav className="header-nav" aria-label="主导航">
          <Button variant="ghost" size="sm" onPress={onChanges}>
            倍率动态
            <Glyph name="activity" size={14} />
          </Button>
        </nav>
      )}
      <div className="header-actions">
        {children}
        <ThemeSelect />
      </div>
    </header>
  );
}
function ThemeSelect() {
  const [preference, changePreference] = useThemePreference();
  const themes = [
    { value: "system", label: "跟随系统", icon: "display" },
    { value: "light", label: "浅色模式", icon: "sun" },
    { value: "dark", label: "深色模式", icon: "moon" },
  ];
  const current = themes.find((theme) => theme.value === preference)!;

  return (
    <InlineSelect
      aria-label="主题设置"
      className="theme-select"
      value={preference}
      onChange={(value) => {
        if (isThemePreference(value)) changePreference(value);
      }}
    >
      <Tooltip delay={250}>
        <InlineSelect.Trigger aria-label={`主题设置：${current.label}`}>
          <Glyph name={current.icon} />
          <InlineSelect.Value className="sr-only" />
        </InlineSelect.Trigger>
        <Tooltip.Content>主题：{current.label}</Tooltip.Content>
      </Tooltip>
      <InlineSelect.Popover
        className="relay-select-popover theme-select-popover"
        placement="bottom end"
      >
        <ListBox aria-label="主题模式">
          {themes.map((theme) => (
            <ListBox.Item
              key={theme.value}
              id={theme.value}
              textValue={theme.label}
            >
              <Glyph name={theme.icon} size={16} />
              <Label>{theme.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </InlineSelect.Popover>
    </InlineSelect>
  );
}
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <InlineSelect
      aria-label={label}
      className="relay-select"
      value={value}
      onChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      variant="secondary"
    >
      <InlineSelect.Trigger>
        <InlineSelect.Value />
        <InlineSelect.Indicator />
      </InlineSelect.Trigger>
      <InlineSelect.Popover
        className="relay-select-popover"
        placement="bottom end"
      >
        <ListBox aria-label={label}>
          {options.map((option) => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              <Label>{option.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </InlineSelect.Popover>
    </InlineSelect>
  );
}
export function Field({
  label,
  value,
  onChange,
  required = false,
  type = "text",
  placeholder,
  autoComplete,
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  min?: string;
  step?: string;
}) {
  return (
    <TextField
      value={value}
      onChange={onChange}
      isRequired={required}
      type={type}
      variant="secondary"
    >
      <Label>{label}</Label>
      <Input
        placeholder={placeholder}
        autoComplete={autoComplete}
        min={min}
        step={step}
      />
    </TextField>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <EmptyState className="empty-state" size="sm">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Glyph name="layers" size={24} />
        </EmptyState.Media>
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Description>{description}</EmptyState.Description>
      </EmptyState.Header>
      {action && <EmptyState.Content>{action}</EmptyState.Content>}
    </EmptyState>
  );
}
export const n = formatNumber;
export function when(value: string | null) {
  if (!value) return "尚未同步";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "刚刚更新"
    : minutes < 60
      ? `${minutes} 分钟前更新`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前更新`
        : `${Math.floor(minutes / 1440)} 天前更新`;
}
