import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { api, APIError, message } from "./api";
import { Empty, Field, Glyph, Header, n, Select, when } from "./ui";
import { SiteDetails } from "./Catalog";
import { lowestRate, Provider, SiteIcon, Status } from "./relay";
import { GroupPreview } from "./GroupPreview";
import { ChangeList } from "./Changes";
import { AdminSettings } from "./AdminSettings";
import closeIcon from "./assets/figma-close.svg";
import type { ChangeNotice, Directory, Site } from "./types";

const base = `${location.pathname}/api`;
type Draft = ReturnType<typeof draft>;
function draft(site?: Site) {
  return {
    name: site?.name ?? "",
    url: site?.url ?? "",
    type: site?.type ?? "newapi",
    icon: site?.icon ?? "",
    description: site?.description ?? "",
    account: site?.account ?? "",
    password: "",
    auth_mode: site?.auth_mode ?? "password",
    access_token: "",
    user_id: site?.user_id ? String(site.user_id) : "",
    recharge_cny: site?.recharge_cny?.toString() ?? "",
    recharge_usd: site?.recharge_usd?.toString() ?? "",
    recharge_multiplier: site?.recharge_multiplier?.toString() ?? "",
    payment_methods: site?.payment_methods.join(", ") ?? "",
    payment_note: site?.payment_note ?? "",
    enabled: site?.enabled ?? true,
    monitor_changes: site?.monitor_changes ?? true,
    manual: JSON.stringify(site?.manual_catalog?.groups ?? [], null, 2),
  };
}
function Editor({
  site,
  close,
  saved,
}: {
  site?: Site;
  close: () => void;
  saved: () => void;
}) {
  const [value, setValue] = useState(() => draft(site)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const update = <K extends keyof Draft>(key: K, v: Draft[K]) =>
    setValue((old) => ({ ...old, [key]: v }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { manual, ...fields } = value;
      const tokenMode = value.type === "newapi" && value.auth_mode === "token";
      const input = {
        ...fields,
        auth_mode: tokenMode ? "token" : "password",
        account: tokenMode || value.type === "others" ? "" : value.account,
        password: tokenMode || value.type === "others" ? "" : value.password,
        access_token: tokenMode ? value.access_token : "",
        user_id: tokenMode ? Number(value.user_id) : 0,
        recharge_cny:
          value.recharge_cny === "" ? null : Number(value.recharge_cny),
        recharge_usd:
          value.recharge_usd === "" ? null : Number(value.recharge_usd),
        recharge_multiplier:
          value.recharge_multiplier === ""
            ? null
            : Number(value.recharge_multiplier),
        payment_methods: value.payment_methods
          .split(/[,，]/)
          .map((p) => p.trim())
          .filter(Boolean),
        manual_catalog:
          value.type === "others" ? { groups: JSON.parse(manual) } : null,
      };
      await api(
        `${base}/sites${site ? "/" + site.id : ""}`,
        site ? "PUT" : "POST",
        input,
      );
      saved();
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Modal.Backdrop isDismissable={!busy}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog className="site-editor">
            <Modal.CloseTrigger aria-label="关闭编辑器" isDisabled={busy}>
              <img src={closeIcon} alt="" width="16" height="16" />
            </Modal.CloseTrigger>
            <Modal.Header>
              <Modal.Heading>{site ? "编辑站点" : "添加站点"}</Modal.Heading>
              <p className="muted">
                基本信息公开展示，登录凭据仅用于后台同步。
              </p>
            </Modal.Header>
            <Modal.Body>
              <form id="site-form" onSubmit={save} className="editor-form">
                <div className="form-section-title">
                  <span>01</span>站点信息
                </div>
                <div className="form-grid">
                  <Field
                    label="站名"
                    value={value.name}
                    onChange={(v) => update("name", v)}
                    required
                  />
                  <div className="select-field">
                    <label>站点类型</label>
                    <Select
                      label="站点类型"
                      value={value.type}
                      onChange={(v) => update("type", v as Site["type"])}
                      options={[
                        { value: "newapi", label: "NewAPI" },
                        { value: "sub2api", label: "Sub2API" },
                        { value: "others", label: "其他 / 手动维护" },
                      ]}
                    />
                  </div>
                  <Field
                    label="站点 URL"
                    value={value.url}
                    onChange={(v) => update("url", v)}
                    type="url"
                    required
                    placeholder="https://relay.example.com"
                  />
                </div>
                <div className="automatic-icon">
                  <SiteIcon
                    site={{
                      id: site?.id ?? "preview",
                      url: value.url,
                      type: value.type,
                      enabled: Boolean(site?.enabled && site.url === value.url),
                    }}
                  />
                  <div>
                    <strong>站点图标，自动发现</strong>
                    <p>
                      独立发现并保存图标地址，后续同步不重新获取；失败时使用{" "}
                      {value.type === "sub2api" ? "Sub2API" : "NewAPI"}{" "}
                      默认图标。修改站点 URL 后才重新发现。
                    </p>
                  </div>
                </div>
                <Field
                  label="一句话简介"
                  value={value.description}
                  onChange={(v) => update("description", v)}
                  placeholder="这个站点有什么不同？"
                />
                <div className="form-section-title">
                  <span>02</span>充值信息
                </div>
                <div className="recharge-fields">
                  <Field
                    label="支付 CNY"
                    type="number"
                    min="0.000001"
                    step="any"
                    value={value.recharge_cny}
                    onChange={(v) => update("recharge_cny", v)}
                    placeholder="10"
                  />
                  <span>=</span>
                  <Field
                    label="获得 USD 额度"
                    type="number"
                    min="0.000001"
                    step="any"
                    value={value.recharge_usd}
                    onChange={(v) => update("recharge_usd", v)}
                    placeholder="20"
                  />
                  <Field
                    label="充值倍率 ×"
                    type="number"
                    min="0"
                    step="any"
                    value={value.recharge_multiplier}
                    onChange={(v) => update("recharge_multiplier", v)}
                    placeholder="2"
                  />
                </div>
                <div className="form-grid">
                  <Field
                    label="充值方式（逗号分隔）"
                    value={value.payment_methods}
                    onChange={(v) => update("payment_methods", v)}
                    placeholder="LDXP, 闲鱼, 易支付"
                  />
                  <Field
                    label="充值说明（可选）"
                    value={value.payment_note}
                    onChange={(v) => update("payment_note", v)}
                    placeholder="如手续费、起充金额"
                  />
                </div>
                <div className="form-section-title">
                  <span>03</span>
                  {value.type === "others" ? "手动分组" : "同步凭据"}
                </div>
                {value.type !== "others" ? (
                  <>
                    {value.type === "newapi" && (
                      <div className="select-field">
                        <label>认证方式</label>
                        <Select
                          label="认证方式"
                          value={value.auth_mode}
                          onChange={(v) =>
                            update("auth_mode", v as Draft["auth_mode"])
                          }
                          options={[
                            { value: "password", label: "账号密码" },
                            { value: "token", label: "访问令牌 + 用户 ID" },
                          ]}
                        />
                      </div>
                    )}
                    {value.type === "newapi" && value.auth_mode === "token" ? (
                      <div className="form-grid">
                        <Field
                          label="用户 ID"
                          type="number"
                          min="1"
                          step="1"
                          value={value.user_id}
                          onChange={(v) => update("user_id", v)}
                          placeholder="如 123"
                          required
                          autoComplete="off"
                        />
                        <Field
                          label={
                            site?.has_access_token
                              ? "访问令牌（留空保留原令牌）"
                              : "访问令牌"
                          }
                          type="password"
                          value={value.access_token}
                          onChange={(v) => update("access_token", v)}
                          required={!site?.has_access_token}
                          autoComplete="new-password"
                        />
                      </div>
                    ) : (
                      <div className="form-grid">
                        <Field
                          label="账号 / 邮箱"
                          value={value.account}
                          onChange={(v) => update("account", v)}
                          required
                          autoComplete="off"
                        />
                        <Field
                          label={
                            site?.has_password
                              ? "密码（留空保留原密码）"
                              : "密码"
                          }
                          type="password"
                          value={value.password}
                          onChange={(v) => update("password", v)}
                          required={!site?.has_password}
                          autoComplete="new-password"
                        />
                      </div>
                    )}
                    <p className="field-help">
                      {value.type === "newapi" && value.auth_mode === "token"
                        ? "填写面板访问令牌（非模型 API Key）和对应用户 ID，适用于第三方登录。令牌不自动刷新，失效后需更换。"
                        : "自动获取公开分组与价格；需要验证码或双重验证的站点不支持无人值守密码登录。"}
                    </p>
                  </>
                ) : (
                  <TextField
                    value={value.manual}
                    onChange={(v) => update("manual", v)}
                  >
                    <Label>分组 JSON</Label>
                    <TextArea className="manual-json" rows={5} />
                    <p className="field-help">
                      数组格式：
                      {
                        '[{"id":"default","name":"默认","multiplier":1,"models":[],"models_known":false}]'
                      }
                    </p>
                  </TextField>
                )}
                <div className="form-section-title">
                  <span>04</span>发布与监测
                </div>
                <div className="publish-row">
                  <div>
                    <strong>公开展示</strong>
                    <p className="muted">关闭后不展示，也不自动同步。</p>
                  </div>
                  <Switch
                    isSelected={value.enabled}
                    onChange={(v) => update("enabled", v)}
                    aria-label="公开展示"
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </div>
                <div className="publish-row">
                  <div>
                    <strong>倍率动态监测</strong>
                    <p className="muted">
                      比较两次成功快照，自动通报倍率调整与分组增删。
                    </p>
                  </div>
                  <Switch
                    isSelected={value.monitor_changes}
                    onChange={(v) => update("monitor_changes", v)}
                    aria-label="倍率动态监测"
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </div>
                {error && (
                  <p className="notice error" role="alert">
                    {error}
                  </p>
                )}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" isDisabled={busy} onPress={close}>
                取消
              </Button>
              <Button type="submit" form="site-form" isPending={busy}>
                保存{value.type !== "others" && value.enabled ? "并同步" : ""}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
export default function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [changes, setChanges] = useState<ChangeNotice[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [interval, setIntervalValue] = useState(900);
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<{
    site: Site;
    groupId?: string;
  } | null>(null);
  const [tab, setTab] = useState("sites");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const load = useCallback(async () => {
    try {
      const data = await api<Directory>(`${base}/sites`);
      setSites(data.sites);
      setChanges(data.changes ?? []);
      setIntervalValue(data.interval);
      setAuthed(true);
      setError("");
    } catch (e) {
      if (e instanceof APIError && e.status === 401) setAuthed(false);
      else setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!authed) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [authed, load]);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`${base}/login`, "POST", { password });
      setPassword("");
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function action(fn: () => Promise<unknown>, text: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setNotice(text);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const abnormal = (site: Site) =>
    ["error", "retrying", "stale"].includes(site.status);
  const filtered = sites.filter(
    (site) =>
      (filter === "all" ||
        (filter === "published" && site.enabled) ||
        (filter === "hidden" && !site.enabled) ||
        (filter === "error" && abnormal(site))) &&
      [site.name, site.url, site.type, site.description]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="shell admin-shell">
      <Header admin>
        <a href="/" className="back-link">
          查看前台
          <Glyph name="arrow-up-right" size={14} />
        </a>
        {authed && (
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              action(async () => {
                await api(`${base}/logout`, "POST");
                setAuthed(false);
              }, "")
            }
          >
            退出
          </Button>
        )}
      </Header>
      <main>
        {authed === null ? (
          <div className="loading" role="status">
            正在检查管理会话…
            {error && (
              <div className="notice error">
                {error}
                <Button onPress={load} variant="ghost">
                  重试
                </Button>
              </div>
            )}
          </div>
        ) : !authed ? (
          <div className="login-wrap">
            <div className="login-symbol">
              <Glyph name="shield-check" size={30} />
            </div>
            <div className="section-eyebrow">私有管理入口</div>
            <h1>打理你的目录。</h1>
            <p className="muted">让每一个入口，保持清晰、及时、可靠。</p>
            <Card className="login-card">
              <Card.Content>
                <form onSubmit={login}>
                  <Field
                    label="管理密码"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    required
                    autoComplete="current-password"
                    placeholder="输入本次启动生成的密码"
                  />
                  {error && (
                    <p role="alert" className="notice error">
                      {error}
                    </p>
                  )}
                  <Button type="submit" fullWidth isPending={busy}>
                    进入管理面板
                    <Glyph name="arrow-right" size={16} />
                  </Button>
                </form>
              </Card.Content>
            </Card>
            <p className="field-help">
              密码在服务启动时生成，可在 Docker 日志中查看。
              <br />
              管理入口不在前台公开 · 会话有效期 8 小时
            </p>
          </div>
        ) : (
          <>
            <section className="admin-intro">
              <div>
                <div className="section-eyebrow">
                  <Glyph name="sliders" size={15} />
                  管理工作台
                </div>
                <h1>
                  站点管理<span>。</span>
                </h1>
                <p className="muted">
                  让收录、同步与每一次倍率变化，都井然有序。
                </p>
              </div>
              <div className="admin-primary-actions">
                <Button
                  variant="secondary"
                  onPress={() => setSettingsOpen(true)}
                >
                  <Glyph name="sliders" size={16} />
                  同步与数据
                </Button>
                <Button onPress={() => setEditing("new")}>
                  <Glyph name="plus" size={16} />
                  添加站点
                </Button>
              </div>
            </section>
            <div className="admin-metrics">
              <div>
                <span>收录站点</span>
                <strong>
                  {String(sites.length).padStart(2, "0")}
                  <small>个</small>
                </strong>
              </div>
              <div>
                <span>公开展示</span>
                <strong>
                  {String(sites.filter((site) => site.enabled).length).padStart(
                    2,
                    "0",
                  )}
                  <small>个</small>
                </strong>
              </div>
              <div>
                <span>需要关注</span>
                <strong className={sites.some(abnormal) ? "warning-text" : ""}>
                  {String(sites.filter(abnormal).length).padStart(2, "0")}
                  <small>个</small>
                </strong>
              </div>
              <div>
                <span>同步周期</span>
                <strong>
                  {interval % 60 === 0 ? interval / 60 : interval}
                  <small>{interval % 60 === 0 ? "分钟" : "秒"}</small>
                </strong>
              </div>
            </div>
            <div className="admin-tabs">
              <div>
                <Button
                  variant="ghost"
                  aria-pressed={tab === "sites"}
                  onPress={() => setTab("sites")}
                >
                  <Glyph name="layers" size={16} />
                  站点目录<span>{sites.length}</span>
                </Button>
                <Button
                  variant="ghost"
                  aria-pressed={tab === "changes"}
                  onPress={() => setTab("changes")}
                >
                  <Glyph name="activity" size={16} />
                  倍率动态<span>{changes.length}</span>
                </Button>
              </div>
              <span className="admin-live">
                <i className="live-dot" />
                后台自动同步
              </span>
            </div>
            {error && (
              <div role="alert" className="notice error">
                <Glyph name="info" size={16} />
                {error}
              </div>
            )}
            {notice && (
              <div role="status" className="notice success">
                <Glyph name="circle-check" size={16} />
                <span>{notice}</span>
                <Button size="sm" variant="ghost" onPress={() => setNotice("")}>
                  关闭
                </Button>
              </div>
            )}
            {tab === "sites" ? (
              <>
                <div className="admin-toolbar">
                  <TextField
                    aria-label="搜索管理站点"
                    className="search"
                    value={query}
                    onChange={setQuery}
                    variant="secondary"
                  >
                    <Glyph name="magnifier" size={18} />
                    <Input placeholder="搜索站点名称、地址或类型…" />
                  </TextField>
                  <Select
                    label="管理筛选"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "全部状态" },
                      { value: "published", label: "公开展示" },
                      { value: "error", label: "需要关注" },
                      { value: "hidden", label: "已隐藏" },
                    ]}
                  />
                </div>
                {filtered.length ? (
                  <div className="admin-list">
                    {filtered.map((site, index) => (
                      <Card
                        key={site.id}
                        className="admin-site"
                        style={{
                          animationDelay: `${Math.min(index, 5) * 40}ms`,
                        }}
                      >
                        <Card.Header className="admin-site-main">
                          <SiteIcon site={site} />
                          <div className="admin-site-info">
                            <div className="site-name">
                              <h2>{site.name}</h2>
                              <Provider type={site.type} />
                              {!site.enabled && (
                                <span className="hidden-label">已隐藏</span>
                              )}
                            </div>
                            <a
                              href={site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {site.url.replace(/^https?:\/\//, "")}
                              <Glyph name="arrow-up-right" size={12} />
                            </a>
                          </div>
                          <div className="admin-site-status">
                            <Status site={site} />
                            <small>{when(site.fetched_at)}</small>
                          </div>
                          <div className="admin-site-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={
                                busy ||
                                !site.enabled ||
                                site.type === "others" ||
                                site.status === "pending"
                              }
                              onPress={() =>
                                action(
                                  () =>
                                    api(
                                      `${base}/sites/${site.id}/sync`,
                                      "POST",
                                    ),
                                  "同步任务已加入持久化队列。",
                                )
                              }
                            >
                              同步
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onPress={() => setEditing(site)}
                            >
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="danger-soft"
                              onPress={() => setDeleting(site)}
                            >
                              删除
                            </Button>
                          </div>
                        </Card.Header>
                        <Card.Content className="admin-site-content">
                          <GroupPreview
                            groups={site.catalog?.groups ?? []}
                            onGroup={(group) =>
                              setPreview({ site, groupId: group.id })
                            }
                            onMore={() => setPreview({ site })}
                          />
                          <div className="admin-site-detail">
                            <span>
                              最低{" "}
                              {lowestRate(site) == null
                                ? "待确认"
                                : `${n(lowestRate(site))}×`}
                            </span>
                            <span>
                              {site.payment_methods.join(" / ") ||
                                "未配置支付方式"}
                            </span>
                            <span>
                              <Glyph
                                name={
                                  site.monitor_changes !== false
                                    ? "activity"
                                    : "eye-slash"
                                }
                                size={13}
                              />
                              {site.monitor_changes !== false
                                ? "动态监测中"
                                : "已暂停监测"}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() => setPreview({ site })}
                            >
                              查看分组
                              <Glyph name="arrow-right" size={13} />
                            </Button>
                          </div>
                          {site.error || site.warnings?.length ? (
                            <details className="diagnostic">
                              <summary>
                                <Glyph name="info" size={14} />
                                {site.error
                                  ? "查看同步错误"
                                  : `${site.warnings?.length} 条同步提醒`}
                              </summary>
                              {site.error && <p>{site.error}</p>}
                              {site.warnings?.map((warning, i) => (
                                <p key={i}>{warning}</p>
                              ))}
                            </details>
                          ) : null}
                        </Card.Content>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title={
                      sites.length ? "没有匹配的站点" : "添加你的第一个站点"
                    }
                    description={
                      sites.length
                        ? "试试其他关键词或状态筛选。"
                        : "填写站点信息，Cerium 会自动收集公开分组与价格。"
                    }
                    action={
                      <Button
                        variant="secondary"
                        onPress={() => {
                          if (sites.length) {
                            setQuery("");
                            setFilter("all");
                          } else setEditing("new");
                        }}
                      >
                        {sites.length ? "清除筛选" : "添加站点"}
                      </Button>
                    }
                  />
                )}
              </>
            ) : (
              <section className="admin-changes">
                <div className="section-heading">
                  <div>
                    <h2>分组与倍率的每一次变化</h2>
                    <p>
                      保留最近 30 天记录；前台展示 7 天内最新 20
                      条通报，可随时撤下或恢复。
                    </p>
                  </div>
                </div>
                <ChangeList
                  changes={changes}
                  sites={sites}
                  busy={busy}
                  onVisibility={(change) =>
                    action(
                      () =>
                        api(`${base}/changes/${change.id}/visibility`, "POST", {
                          visible: Boolean(change.dismissed),
                        }),
                      change.dismissed
                        ? "已恢复前台通报。"
                        : "通报已从前台撤下，历史记录仍然保留。",
                    )
                  }
                />
              </section>
            )}
            <div className="admin-note">
              <Glyph name="shield-check" size={16} />
              <p>
                凭据仅用于后台同步，不向前台公开。首次同步建立基准；同步失败保留快照，不触发波动通报。
              </p>
            </div>
          </>
        )}
      </main>
      {settingsOpen && authed && (
        <AdminSettings
          base={base}
          interval={interval}
          siteCount={sites.length}
          close={() => setSettingsOpen(false)}
          unauthorized={() => setAuthed(false)}
          saved={async (text) => {
            setNotice(text);
            await load();
          }}
        />
      )}
      {editing && (
        <Editor
          site={editing === "new" ? undefined : editing}
          close={() => setEditing(null)}
          saved={() => {
            setNotice("已保存站点配置。");
            void load();
          }}
        />
      )}
      {preview && (
        <SiteDetails
          site={
            sites.find((site) => site.id === preview.site.id) ?? preview.site
          }
          initialGroup={preview.groupId}
          key={`${preview.site.id}-${preview.groupId ?? "overview"}`}
          close={() => setPreview(null)}
        />
      )}
      {deleting && (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
        >
          <Modal.Backdrop isDismissable={!busy}>
            <Modal.Container size="sm">
              <Modal.Dialog>
                <Modal.CloseTrigger aria-label="取消删除" isDisabled={busy} />
                <Modal.Header>
                  <Modal.Heading>删除 {deleting.name}？</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p className="muted">
                    站点与波动记录将从目录移除，并排队清理同步器中的凭据和会话。此操作无法撤销。
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => setDeleting(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    isPending={busy}
                    onPress={() =>
                      action(async () => {
                        await api(`${base}/sites/${deleting.id}`, "DELETE");
                        setDeleting(null);
                      }, "站点已移除，后台凭据清理已排队。")
                    }
                  >
                    确认删除
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </div>
  );
}
