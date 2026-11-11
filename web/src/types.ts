import type { Catalog, Price } from "./contracts.generated";
export type { Price, Group, Catalog } from "./contracts.generated";
export type Site = {
  id: string;
  revision: number;
  icon_revision?: number;
  name: string;
  url: string;
  type: "newapi" | "sub2api" | "others";
  icon: string;
  description: string;
  enabled: boolean;
  monitor_changes: boolean;
  recharge_cny: number | null;
  recharge_usd: number | null;
  payment_methods: string[];
  payment_note: string;
  catalog: Catalog | null;
  fetched_at: string | null;
  last_checked: string | null;
  status:
    "ok" | "pending" | "waiting" | "error" | "retrying" | "stale" | "manual";
  account?: string;
  has_password?: boolean;
  auth_mode?: "password" | "token";
  user_id?: number;
  has_access_token?: boolean;
  error?: string;
  warnings?: string[];
  manual_catalog?: Catalog | null;
};
export type GroupChange = {
  kind: "added" | "removed" | "multiplier" | "models" | "prices";
  group_id: string;
  name: string;
  before: number | null;
  after: number | null;
  before_dynamic: boolean;
  after_dynamic: boolean;
  models_added?: string[];
  models_removed?: string[];
  price_changes?: {
    model: string;
    before: Price | null;
    after: Price | null;
  }[];
};
export type ChangePage = {
  changes: ChangeNotice[];
  total: number;
  offset: number;
  limit: number;
};
export type ChangeNotice = {
  id: string;
  site_id: string;
  site_name: string;
  checked_at: string;
  previous_checked_at: string | null;
  details: GroupChange[];
  dismissed?: boolean;
  enabled?: boolean;
  monitor_changes?: boolean;
};
export type Directory = {
  sites: Site[];
  changes: ChangeNotice[];
  interval: number;
  payment_presets?: string[];
};
