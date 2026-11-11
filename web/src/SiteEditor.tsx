import { useState, type FormEvent } from "react";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Input,
  Label,
  Modal,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { api, APIError, message } from "./api";
import { Field, Select } from "./ui";
import closeIcon from "./assets/figma-close.svg";
import type { Directory, Site } from "./types";

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
    recharge_cny:
      site?.recharge_cny != null && site.recharge_usd
        ? String(site.recharge_cny / site.recharge_usd)
        : "",
    payment_methods: site?.payment_methods ?? [],
    payment_note: site?.payment_note ?? "",
    enabled: site?.enabled ?? true,
    monitor_changes: site?.monitor_changes ?? true,
    manual: JSON.stringify(site?.manual_catalog?.groups ?? [], null, 2),
  };
}

export function SiteEditor({
  base,
  site,
  close,
  saved,
  paymentPresets,
}: {
  base: string;
  site?: Site;
  close: () => void;
  saved: () => void;
  paymentPresets: string[];
}) {
  const [currentSite, setCurrentSite] = useState(site),
    [value, setValue] = useState(() => draft(site)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false);
  const update = <Key extends keyof Draft>(key: Key, next: Draft[Key]) =>
    setValue((previous) => ({ ...previous, [key]: next }));

  async function reload() {
    if (busy || !currentSite) return;
    setBusy(true);
    try {
      const directory = await api<Directory>(`${base}/sites`),
        latest = directory.sites.find((entry) => entry.id === currentSite.id);
      if (!latest) throw new Error("站点已被删除，请关闭编辑器并刷新目录。");
      setCurrentSite(latest);
      setValue(draft(latest));
      setConflict(false);
      setError("");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict) return;
    setBusy(true);
    setError("");
    try {
      const { manual, ...fields } = value,
        tokenMode = value.type === "newapi" && value.auth_mode === "token",
        input = {
          ...fields,
          ...(currentSite ? { revision: currentSite.revision } : {}),
          auth_mode: tokenMode ? "token" : "password",
          account: tokenMode || value.type === "others" ? "" : value.account,
          password: tokenMode || value.type === "others" ? "" : value.password,
          access_token: tokenMode ? value.access_token : "",
          user_id: tokenMode ? Number(value.user_id) : 0,
          recharge_cny:
            value.recharge_cny === "" ? null : Number(value.recharge_cny),
          recharge_usd: value.recharge_cny === "" ? null : 1,
          payment_methods: value.payment_methods,
          manual_catalog:
            value.type === "others" ? { groups: JSON.parse(manual) } : null,
        };
      await api(
        `${base}/sites${currentSite ? "/" + currentSite.id : ""}`,
        currentSite ? "PUT" : "POST",
        input,
      );
      saved();
      close();
    } catch (failure) {
      if (failure instanceof APIError && failure.status === 409) {
        setConflict(true);
        setError(
          "站点配置已发生变化，本次修改尚未保存。草稿已保留，请先核对并载入最新配置。",
        );
      } else setError(message(failure));
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
              <Modal.Heading>
                {currentSite ? "编辑站点" : "添加站点"}
              </Modal.Heading>
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
                    onChange={(next) => update("name", next)}
                    required
                  />
                  <div className="select-field">
                    <label>站点类型</label>
                    <Select
                      label="站点类型"
                      value={value.type}
                      onChange={(next) => update("type", next as Site["type"])}
                      options={[
                        { value: "newapi", label: "NewAPI" },
                        { value: "sub2api", label: "Sub2API" },
                        { value: "others", label: "其他 / 手动维护" },
                      ]}
                    />
                  </div>
                </div>
                <Field
                  label="站点 URL"
                  value={value.url}
                  onChange={(next) => update("url", next)}
                  type="url"
                  required
                  placeholder="https://relay.example.com"
                />
                <Field
                  label="一句话简介"
                  value={value.description}
                  onChange={(next) => update("description", next)}
                  placeholder="这个站点有什么不同？"
                />
                <div className="form-section-title">
                  <span>02</span>充值信息
                </div>
                <TextField
                  type="number"
                  value={value.recharge_cny}
                  onChange={(next) => update("recharge_cny", next)}
                  variant="secondary"
                  className="recharge-field"
                >
                  <Label>充值兑换（可选）</Label>
                  <div className="recharge-fields">
                    <Input min="0.000001" step="any" placeholder="如 0.5" />
                    <span>CNY = 1 USD</span>
                  </div>
                </TextField>
                <CheckboxGroup
                  value={value.payment_methods}
                  onChange={(next) => update("payment_methods", next)}
                  isDisabled={busy}
                  className="payment-methods-field"
                >
                  <Label>支付渠道（可多选）</Label>
                  <div className="payment-options">
                    {[
                      ...new Set([
                        ...paymentPresets,
                        ...(currentSite?.payment_methods ?? []),
                      ]),
                    ].map((method) => (
                      <Checkbox
                        key={method}
                        value={method}
                        variant="secondary"
                        isDisabled={
                          value.payment_methods.length >= 12 &&
                          !value.payment_methods.includes(method)
                        }
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          {method}
                        </Checkbox.Content>
                      </Checkbox>
                    ))}
                  </div>
                  <p className="field-help">
                    最多选择 12 项，可在「同步与数据」中添加或调整预设。
                  </p>
                </CheckboxGroup>
                <Field
                  label="充值说明（可选）"
                  value={value.payment_note}
                  onChange={(next) => update("payment_note", next)}
                  placeholder="如手续费、起充金额"
                />
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
                          onChange={(next) =>
                            update("auth_mode", next as Draft["auth_mode"])
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
                          onChange={(next) => update("user_id", next)}
                          placeholder="如 123"
                          required
                          autoComplete="off"
                        />
                        <Field
                          label={
                            currentSite?.has_access_token
                              ? "访问令牌（留空保留原令牌）"
                              : "访问令牌"
                          }
                          type="password"
                          value={value.access_token}
                          onChange={(next) => update("access_token", next)}
                          required={!currentSite?.has_access_token}
                          autoComplete="new-password"
                        />
                      </div>
                    ) : (
                      <div className="form-grid">
                        <Field
                          label="账号 / 邮箱"
                          value={value.account}
                          onChange={(next) => update("account", next)}
                          required
                          autoComplete="off"
                        />
                        <Field
                          label={
                            currentSite?.has_password
                              ? "密码（留空保留原密码）"
                              : "密码"
                          }
                          type="password"
                          value={value.password}
                          onChange={(next) => update("password", next)}
                          required={!currentSite?.has_password}
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
                    onChange={(next) => update("manual", next)}
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
                    onChange={(next) => update("enabled", next)}
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
                      比较两次成功快照，自动通报分组、倍率、模型与价格变化。
                    </p>
                  </div>
                  <Switch
                    isSelected={value.monitor_changes}
                    onChange={(next) => update("monitor_changes", next)}
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
                {conflict && (
                  <div className="editor-conflict">
                    <p className="field-help">
                      载入会替换当前草稿和未保存的凭据，请先保留需要的内容。
                    </p>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void reload()}
                    >
                      载入最新配置
                    </Button>
                  </div>
                )}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" isDisabled={busy} onPress={close}>
                取消
              </Button>
              <Button
                type="submit"
                form="site-form"
                isPending={busy}
                isDisabled={conflict}
              >
                保存{value.type !== "others" && value.enabled ? "并同步" : ""}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
