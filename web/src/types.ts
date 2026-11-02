export type Price = {
  model: string;
  mode: "tokens" | "request" | "dynamic" | "unknown";
  input?: number | null;
  output?: number | null;
  request?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  expression?: string;
};
export type Group = {
  id: string;
  name: string;
  description?: string;
  platform?: string;
  multiplier: number | null;
  multiplier_source?: string;
  models: string[];
  models_known: boolean;
  models_source?: string;
  models_fetched_at?: string;
  prices?: Price[];
};
export type Catalog = { scope: string; groups: Group[] };
export type Site = {
  id: string;
  name: string;
  url: string;
  type: "newapi" | "sub2api" | "others";
  icon: string;
  description: string;
  enabled: boolean;
  monitor_changes: boolean;
  recharge_multiplier: number | null;
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
  kind: "added" | "removed" | "multiplier";
  group_id: string;
  name: string;
  before: number | null;
  after: number | null;
  before_dynamic: boolean;
  after_dynamic: boolean;
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
};
