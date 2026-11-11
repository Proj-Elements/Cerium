import { useRef, useState, type FormEvent } from "react";
import {
  Button,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
} from "@heroui/react";
import { api, APIError, message } from "./api";
import {
  BACKUP_LIMIT,
  downloadBackup,
  uploadBackup,
  type BackupFormat,
  type ImportMode,
} from "./backup-api";
import { Select } from "./ui";
import { RecoverySettings } from "./RecoverySettings";
import "./admin-settings.css";

type Props = {
  base: string;
  interval: number;
  paymentPresets: string[];
  siteCount: number;
  close: () => void;
  saved: (notice: string) => Promise<void>;
  unauthorized: () => void;
};
function SyncForm({
  base,
  interval,
  busy,
  run,
}: {
  base: string;
  interval: number;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const initialUnit =
    interval % 3600 === 0 ? "3600" : interval % 60 === 0 ? "60" : "1";
  const [unit, setUnit] = useState(initialUnit),
    [value, setValue] = useState(String(interval / Number(initialUnit)));
  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const converted = Number(value) * Number(unit),
        seconds = Math.round(converted);
      // Unit conversion can leave floating-point noise around an integer second.
      if (
        !Number.isSafeInteger(seconds) ||
        seconds < 60 ||
        seconds > 31536000 ||
        Math.abs(converted - seconds) >
          Number.EPSILON * Math.max(1, Math.abs(converted)) * 8
      )
        throw new Error("同步间隔须为整数秒，范围为 1 分钟至 365 天");
      await api(`${base}/settings`, "PUT", { sync_interval_seconds: seconds });
      return "同步周期已保存，新的等待时间已生效。";
    });
  }
  return (
    <form onSubmit={save} className="sync-settings-form">
      <div className="form-section-title">
        <span>01</span>自动同步
      </div>
      <p className="field-help">
        调整所有公开、自动抓取站点的同步间隔。配置重启后保留，已排队或执行中的任务不受影响。
      </p>
      <div className="sync-settings-controls">
        <TextField
          type="number"
          value={value}
          onChange={setValue}
          isRequired
          isDisabled={busy}
          variant="secondary"
        >
          <Label>同步间隔</Label>
          <Input
            min={60 / Number(unit)}
            max={31536000 / Number(unit)}
            step="any"
          />
        </TextField>
        <div className="select-field">
          <label>时间单位</label>
          <Select
            label="时间单位"
            value={unit}
            onChange={(next) => {
              if (busy) return;
              setValue(String((Number(value) * Number(unit)) / Number(next)));
              setUnit(next);
            }}
            options={[
              { value: "1", label: "秒" },
              { value: "60", label: "分钟" },
              { value: "3600", label: "小时" },
            ]}
          />
        </div>
      </div>
      <p className="field-help">
        最短 1 分钟，最长 365 天；同步排队不承诺精确秒级刷新。
      </p>
      <Button type="submit" variant="secondary" isDisabled={busy}>
        保存同步周期
      </Button>
    </form>
  );
}
function PaymentForm({
  base,
  presets,
  busy,
  run,
}: {
  base: string;
  presets: string[];
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const [value, setValue] = useState(presets.join("\n"));
  return (
    <form
      className="payment-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const payment_presets = [
            ...new Set(
              value
                .split(/\r?\n/)
                .map((name) => name.trim())
                .filter(Boolean),
            ),
          ];
          if (
            payment_presets.length > 32 ||
            payment_presets.some((name) => name.length > 40)
          )
            throw new Error("最多 32 个支付渠道，每个名称不超过 40 个字符");
          await api(`${base}/settings`, "PUT", { payment_presets });
          return "支付渠道预设已保存，添加或编辑站点时可选择。";
        });
      }}
    >
      <div className="form-section-title">
        <span>02</span>支付渠道预设
      </div>
      <TextField
        value={value}
        onChange={setValue}
        isDisabled={busy}
        variant="secondary"
      >
        <Label>支付渠道预设（每行一个）</Label>
        <TextArea rows={3} placeholder={"云猫寄售\n链动小铺\n站点直充"} />
      </TextField>
      <p className="field-help">
        最多 32 项。调整预设不会更改已保存站点的支付渠道。
      </p>
      <Button type="submit" variant="secondary" isDisabled={busy}>
        保存支付渠道
      </Button>
    </form>
  );
}
export function AdminSettings({
  base,
  interval,
  paymentPresets,
  siteCount,
  close,
  saved,
  unauthorized,
}: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [format, setFormat] = useState<BackupFormat>("json"),
    [mode, setMode] = useState<ImportMode>("merge");
  const [file, setFile] = useState<File | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const [includeCache, setIncludeCache] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  async function run(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      await saved(result);
      setNotice(result);
    } catch (error) {
      if (error instanceof APIError && error.status === 401) unauthorized();
      else setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  function resetFile() {
    setFile(null);
    setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
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
          <Modal.Dialog className="admin-settings-dialog">
            <Modal.CloseTrigger
              aria-label="关闭同步与数据设置"
              isDisabled={busy}
            />
            <Modal.Header>
              <Modal.Heading>同步与数据</Modal.Heading>
              <p className="muted">调整更新节奏，备份或迁移你的目录。</p>
            </Modal.Header>
            <Modal.Body>
              <SyncForm
                key={interval}
                base={base}
                interval={interval}
                busy={busy}
                run={run}
              />
              <PaymentForm
                key={JSON.stringify(paymentPresets)}
                base={base}
                presets={paymentPresets}
                busy={busy}
                run={run}
              />
              <section className="backup-settings" aria-label="数据备份">
                <div className="form-section-title">
                  <span>03</span>导入与导出
                </div>
                <p className="field-help">
                  包含全部站点、账号密码 /
                  面板令牌、最后成功快照、动态记录和同步周期。用于目录迁移；完整服务恢复请使用下方的完整恢复包。
                </p>
                <div className="select-field">
                  <label>备份格式</label>
                  <Select
                    label="备份格式"
                    value={format}
                    onChange={(value) => {
                      if (busy) return;
                      setFormat(value as BackupFormat);
                      resetFile();
                    }}
                    options={[
                      { value: "json", label: "JSON (.json)" },
                      { value: "sqlite", label: "SQLite (.db)" },
                    ]}
                  />
                </div>
                <p className="backup-sensitive">
                  备份包含明文凭据，请妥善保管，不要公开分享或提交到 Git。
                </p>
                <label className="backup-confirm">
                  <input
                    type="checkbox"
                    checked={includeCache}
                    disabled={busy}
                    onChange={(event) => setIncludeCache(event.target.checked)}
                  />
                  <span>包括图标缓存（文件过大时自动省略）</span>
                </label>
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const result = await downloadBackup(
                        base,
                        format,
                        includeCache,
                      );
                      return result.cacheOmitted
                        ? "备份已开始下载；已省略可重新获取的图标缓存，站点配置和凭据完整保留。"
                        : "备份已生成并开始下载，请妥善保管。";
                    })
                  }
                >
                  导出备份
                </Button>
                <div className="backup-import">
                  <label htmlFor="backup-file">导入备份文件</label>
                  <input
                    ref={fileInput}
                    id="backup-file"
                    type="file"
                    disabled={busy}
                    accept={
                      format === "json"
                        ? ".json,application/json"
                        : ".db,.sqlite,.sqlite3,application/vnd.sqlite3"
                    }
                    onChange={(event) => {
                      const selected = event.target.files?.[0] ?? null;
                      setConfirmed(false);
                      setError("");
                      if (
                        selected &&
                        (!selected.size || selected.size > BACKUP_LIMIT)
                      ) {
                        resetFile();
                        setError(
                          selected.size
                            ? "备份文件不能超过 64 MiB"
                            : "备份文件为空",
                        );
                      } else setFile(selected);
                    }}
                  />
                  <p className="field-help">
                    最多 64 MiB。SQLite 导入仅支持 Cerium web 数据库，不接受 SQL
                    脚本或同步器数据库。
                  </p>
                  <div className="select-field">
                    <label>导入方式</label>
                    <Select
                      label="导入方式"
                      value={mode}
                      onChange={(value) => {
                        if (busy) return;
                        setMode(value as ImportMode);
                        setConfirmed(false);
                      }}
                      options={[
                        {
                          value: "merge",
                          label: "合并：保留未收录于备份的站点",
                        },
                        { value: "replace", label: "替换：以备份恢复整个目录" },
                      ]}
                    />
                  </div>
                  <p className="field-help">
                    {mode === "merge"
                      ? "按站点 ID 或相同 URL、类型与账号 / 用户 ID 合并；匹配站点的配置与快照会被覆盖，其余站点保留。"
                      : `当前目录有 ${siteCount} 个站点。替换会移除备份中不存在的站点与动态记录，并排队清理其同步凭据。`}{" "}
                    同步周期采用备份设置；文件校验失败时不修改任何数据，管理入口保持不变。
                  </p>
                  {mode === "replace" && (
                    <label className="backup-confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={busy}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      <span>我确认替换当前目录，并已保存需要保留的数据。</span>
                    </label>
                  )}
                  <Button
                    variant={mode === "replace" ? "danger-soft" : "secondary"}
                    isDisabled={
                      busy || !file || (mode === "replace" && !confirmed)
                    }
                    onPress={() =>
                      void run(async () => {
                        if (!file) throw new Error("请先选择备份文件");
                        const result = await uploadBackup(
                          base,
                          format,
                          mode,
                          file,
                        );
                        resetFile();
                        return `已导入 ${result.imported} 个站点${result.removed ? `，移除 ${result.removed} 个旧站点` : ""}；自动同步任务已重新排队。`;
                      })
                    }
                  >
                    {busy
                      ? "正在处理…"
                      : mode === "replace"
                        ? "确认替换并导入"
                        : "合并导入"}
                  </Button>
                </div>
              </section>
              <RecoverySettings base={base} busy={busy} run={run} />
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="notice success" role="status">
                  {notice}
                </p>
              )}
              {busy && !notice && (
                <p className="field-help" role="status">
                  正在处理，请稍候…
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" isDisabled={busy} onPress={close}>
                完成
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
