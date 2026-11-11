import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { RECOVERY_LIMIT, downloadRecovery, uploadRecovery } from "./backup-api";

export function RecoverySettings({
  base,
  busy,
  run,
}: {
  base: string;
  busy: boolean;
  run: (fn: () => Promise<string>) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <section
      className="backup-settings recovery-settings"
      aria-label="完整灾难恢复"
    >
      <div className="form-section-title">
        <span>04</span>完整灾难恢复
      </div>
      <p className="field-help">
        协调暂停采集后备份 Web
        与同步器状态，包含目录、凭据、未完成任务、模型探测和临时 Key 清理记录。
        恢复时整体替换两个服务的数据；恢复后重新登录。普通目录备份用于站点迁移。
      </p>
      <p className="backup-sensitive">
        恢复包含明文凭据，请妥善保管，并保留相同版本的 Cerium 程序用于恢复。
      </p>
      <Button
        variant="secondary"
        isDisabled={busy}
        onPress={() =>
          void run(async () => {
            await downloadRecovery(base);
            return "完整恢复包已开始下载，请妥善保管。";
          })
        }
      >
        导出完整恢复包
      </Button>
      <div className="backup-import">
        <label htmlFor="recovery-file">完整恢复包 (.cerium.gz)</label>
        <input
          ref={input}
          id="recovery-file"
          type="file"
          accept=".gz,application/gzip"
          disabled={busy}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setConfirmed(false);
            setError("");
            if (
              selected &&
              (!selected.size || selected.size > RECOVERY_LIMIT)
            ) {
              setFile(null);
              if (input.current) input.current.value = "";
              setError(
                selected.size ? "恢复文件不能超过 512 MiB" : "恢复文件为空",
              );
            } else setFile(selected);
          }}
        />
        <p className="field-help">
          最多 512 MiB。恢复期间暂停数据修改；使用新服务生成的管理密码重新登录。
        </p>
        <label className="backup-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>我确认整体替换 Web 与同步器数据，并已另存当前数据。</span>
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <Button
          variant="danger-soft"
          isDisabled={busy || !file || !confirmed}
          onPress={() =>
            void run(async () => {
              if (!file) throw new Error("请先选择完整恢复包");
              const result = await uploadRecovery(base, file);
              if (!result.restored)
                throw new Error("恢复未完成，请查看服务诊断");
              const destination = new URL(result.admin_path, location.origin);
              if (
                destination.origin !== location.origin ||
                !result.admin_path.startsWith("/")
              )
                throw new Error("恢复完成，请重新打开当前管理入口登录");
              location.assign(destination.pathname);
              return `已恢复 ${result.sites} 个站点与 ${result.jobs} 个任务，正在重新打开管理入口。`;
            })
          }
        >
          确认整体恢复
        </Button>
      </div>
    </section>
  );
}
