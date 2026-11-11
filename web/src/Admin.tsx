import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Button, Card, Modal } from "@heroui/react";
import { api, APIError, clearAPICache, message } from "./api";
import { createLatestRequest } from "./latest-request";
import { Field, Glyph, Header } from "./ui";
import { SiteDetails } from "./Catalog";
import { AdminSettings } from "./AdminSettings";
import { AdminSites } from "./AdminSites";
import { AdminChanges } from "./AdminChanges";
import { SiteEditor } from "./SiteEditor";
import type { Directory, Site } from "./types";

const base = `${location.pathname}/api`;
const abnormal = (site: Site) =>
  ["error", "retrying", "stale"].includes(site.status);

export default function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState<Directory>({
    sites: [],
    changes: [],
    interval: 900,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const [refreshingModels, setRefreshingModels] = useState<Site | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<{
    site: Site;
    groupId?: string;
  } | null>(null);
  const [tab, setTab] = useState("sites");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [requests] = useState(() => createLatestRequest<Directory>());
  const authenticated = useRef<boolean | null>(null);
  const authenticate = useCallback(
    (value: boolean) => {
      authenticated.current = value;
      setAuthed(value);
      if (!value) {
        requests.cancel();
        clearAPICache();
        setDirectory({ sites: [], changes: [], interval: 900 });
        setEditing(null);
        setPreview(null);
        setDeleting(null);
        setRefreshingModels(null);
        setSettingsOpen(false);
      }
    },
    [requests],
  );
  const load = useCallback(async () => {
    try {
      const result = await requests.run((signal) =>
        api<Directory>(`${base}/sites`, "GET", undefined, 15000, {
          signal,
          conditional: true,
        }),
      );
      if (!result.current) return false;
      setDirectory(result.value);
      authenticate(true);
      setError("");
      return true;
    } catch (error) {
      if (error instanceof APIError && error.status === 401)
        authenticate(false);
      else setError(message(error));
      return false;
    }
  }, [authenticate, requests]);
  useEffect(() => {
    void load();
    return () => requests.cancel();
  }, [load, requests]);
  useEffect(() => {
    if (!authed) return;
    let stopped = false;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped)
        timer = setTimeout(tick, Math.min(60000, 5000 * 2 ** failures));
    };
    const tick = async () => {
      if (document.hidden || running || stopped) return;
      running = true;
      try {
        const success = await load();
        failures = success ? 0 : Math.min(4, failures + 1);
      } finally {
        running = false;
        schedule();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [authed, load]);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`${base}/login`, "POST", { password });
      setPassword("");
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function action(fn: () => Promise<unknown>, text: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    requests.cancel();
    try {
      await fn();
      setNotice(text);
      setHistoryRevision((value) => value + 1);
      if (authenticated.current) await load();
    } catch (error) {
      if (error instanceof APIError && error.status === 401)
        authenticate(false);
      else setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  const {
    sites,
    changes,
    interval,
    payment_presets: paymentPresets = [],
  } = directory;
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
            isDisabled={busy}
            onPress={() =>
              void action(async () => {
                await api(`${base}/logout`, "POST");
                authenticate(false);
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
                <Button onPress={() => void load()} variant="ghost">
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
                  让收录、同步与每一次目录变化，都井然有序。
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
              <AdminSites
                sites={sites}
                busy={busy}
                edit={setEditing}
                remove={setDeleting}
                preview={(site, groupId) => setPreview({ site, groupId })}
                sync={(site) =>
                  void action(
                    () => api(`${base}/sites/${site.id}/sync`, "POST"),
                    "同步任务已加入持久化队列。",
                  )
                }
                refreshModels={setRefreshingModels}
              />
            ) : (
              <AdminChanges
                base={base}
                sites={sites}
                busy={busy}
                revision={`${historyRevision}:${changes.map((change) => `${change.id}:${change.dismissed}`).join(",")}`}
                unauthorized={() => authenticate(false)}
                onVisibility={(change) =>
                  void action(
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
          paymentPresets={paymentPresets}
          siteCount={sites.length}
          close={() => setSettingsOpen(false)}
          unauthorized={() => authenticate(false)}
          saved={async (text) => {
            setNotice(text);
            await load();
          }}
        />
      )}
      {editing && authed && (
        <SiteEditor
          base={base}
          site={editing === "new" ? undefined : editing}
          paymentPresets={paymentPresets}
          close={() => setEditing(null)}
          saved={() => {
            setNotice("已保存站点配置。");
            void load();
          }}
        />
      )}
      {preview && authed && (
        <SiteDetails
          site={
            sites.find((site) => site.id === preview.site.id) ?? preview.site
          }
          initialGroup={preview.groupId}
          key={`${preview.site.id}-${preview.groupId ?? "overview"}`}
          close={() => setPreview(null)}
        />
      )}
      {refreshingModels && authed && (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open && !busy) setRefreshingModels(null);
          }}
        >
          <Modal.Backdrop isDismissable={!busy}>
            <Modal.Container size="sm">
              <Modal.Dialog>
                <Modal.CloseTrigger
                  aria-label="取消模型刷新"
                  isDisabled={busy}
                />
                <Modal.Header>
                  <Modal.Heading>
                    刷新 {refreshingModels.name} 的模型？
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p className="muted">
                    这会重新探测公开分组的模型列表，可能创建并删除上游临时 API
                    Key、发送模型请求，并产生上游费用。普通同步会继续复用已有探测结果。
                  </p>
                  <p className="field-help">
                    仅在需要重新获取模型时确认；现有临时 Key
                    清理完成后再进行新的探测。
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => setRefreshingModels(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="secondary"
                    isPending={busy}
                    onPress={() =>
                      void action(async () => {
                        await api(
                          `${base}/sites/${refreshingModels.id}/models/refresh`,
                          "POST",
                          { confirmed: true },
                        );
                        setRefreshingModels(null);
                      }, "模型刷新任务已加入队列。")
                    }
                  >
                    确认刷新模型
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
      {deleting && authed && (
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
                      void action(async () => {
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
