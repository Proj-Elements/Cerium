export type Price = {
  model: string;
  mode: "tokens" | "request" | "dynamic" | "unknown";
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  request?: number | null;
  expression?: string;
};

export type Group = {
  id: string;
  name: string;
  description?: string;
  platform?: string;
  multiplier: number | null;
  default_multiplier?: number | null;
  multiplier_source?: string;
  models: string[];
  models_known: boolean;
  models_source?: string;
  models_fetched_at?: string;
  prices?: Price[];
};

export type Catalog = {
  groups: (Group)[];
  warnings?: (string)[] | null;
  scope: "" | "public" | "private" | "manual";
};

export type BridgeJob = {
  job_id: string;
  site_id: string;
  config_revision: number;
  operation: "sync" | "delete";
  name: string;
  url: string;
  type: "newapi" | "sub2api" | "others";
  account: string;
  password: string;
  access_token?: string;
  user_id?: number;
  refresh_models?: boolean;
};

export type SyncResult = {
  credential_id?: number;
  name?: string;
  url: string;
  type: "newapi" | "sub2api" | "others";
  checked_at: string;
  refresh?: string;
  catalog?: Catalog;
  warnings?: (string)[] | null;
  error?: string;
  error_stage?: string;
  error_category?: string;
  site_id?: string;
  job_id?: string;
  config_revision?: number;
};
