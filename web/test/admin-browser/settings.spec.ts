import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

async function login(page: Page) {
  const session = JSON.parse(
    readFileSync(resolve("test-results/admin-data-session.json"), "utf8"),
  );
  await page.goto(session.adminPath);
  await page.getByRole("textbox", { name: "管理密码" }).fill(session.password);
  await page.getByRole("button", { name: "进入管理面板" }).click();
  await expect(page.getByRole("heading", { name: "站点管理。" })).toBeVisible();
  await page.getByRole("button", { name: "同步与数据", exact: true }).click();
  return session;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("admin can change sync timing, download JSON and SQLite, merge, replace and recover from bad imports", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await login(page),
    dialog = page.getByRole("dialog"),
    base = session.adminPath + "/api";
  await dialog.getByRole("spinbutton", { name: "同步间隔" }).fill("1.5");
  await dialog.getByRole("button", { name: "保存同步周期" }).click();
  await expect(dialog.getByRole("status")).toContainText("同步周期已保存");
  await expect(
    dialog.getByRole("spinbutton", { name: "同步间隔" }),
  ).toHaveValue("90");
  await choose(page, "时间单位", "分钟");
  await dialog.getByRole("spinbutton", { name: "同步间隔" }).fill("4.1");
  await dialog.getByRole("button", { name: "保存同步周期" }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "同步间隔" }),
  ).toHaveValue("246");
  await choose(page, "时间单位", "分钟");
  await dialog.getByRole("spinbutton", { name: "同步间隔" }).fill("1.5");
  await dialog.getByRole("button", { name: "保存同步周期" }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "同步间隔" }),
  ).toHaveValue("90");
  expect(
    (await (await page.request.get(base + "/settings")).json())
      .sync_interval_seconds,
  ).toBe(90);
  await expect(
    page.locator(".admin-metrics > div").last().locator("strong"),
  ).toHaveText("90秒");

  const jsonDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出备份" }).click();
  const json = await jsonDownload;
  expect(json.suggestedFilename()).toMatch(/\.json$/);
  const data = JSON.parse(readFileSync((await json.path())!, "utf8"));
  expect(data.settings.sync_interval_seconds).toBe(90);
  expect(data.sites).toHaveLength(3);
  expect(JSON.stringify(data)).toContain("PRIVATE-FIXTURE-PASSWORD");
  expect(JSON.stringify(data)).not.toContain(session.adminPath);
  await expect(dialog.getByRole("status")).toContainText("备份已生成");

  await choose(page, "备份格式", "SQLite (.db)");
  const dbDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出备份" }).click();
  const db = await dbDownload;
  expect(db.suggestedFilename()).toMatch(/\.db$/);
  expect(
    readFileSync((await db.path())!)
      .subarray(0, 16)
      .toString("binary"),
  ).toBe("SQLite format 3\0");
  await expect(dialog.getByRole("status")).toContainText("备份已生成");
  await dialog.getByLabel("导入备份文件").setInputFiles((await db.path())!);
  await dialog.getByRole("button", { name: "合并导入" }).click();
  await expect(dialog.getByRole("status")).toContainText("已导入 3 个站点");

  await choose(page, "备份格式", "JSON (.json)");
  data.settings.sync_interval_seconds = 300;
  data.sites = data.sites.slice(0, 1);
  data.sites[0].config.name = "已恢复的测试站";
  data.changes = [];
  const file = {
    name: "restore.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  };
  await dialog.getByLabel("导入备份文件").setInputFiles(file);
  await dialog.getByRole("button", { name: "合并导入" }).click();
  await expect(dialog.getByRole("status")).toContainText("已导入 1 个站点");
  const merged = await (await page.request.get(base + "/sites")).json();
  expect(merged.sites).toHaveLength(3);
  expect(merged.interval).toBe(300);
  expect(merged.sites[0].name).toBe("已恢复的测试站");

  await dialog.getByLabel("导入备份文件").setInputFiles(file);
  await choose(page, "导入方式", "替换：以备份恢复整个目录");
  await expect(
    dialog.getByRole("button", { name: "确认替换并导入" }),
  ).toBeDisabled();
  await dialog
    .getByRole("checkbox", {
      name: "我确认替换当前目录，并已保存需要保留的数据。",
    })
    .check();
  await dialog.getByRole("button", { name: "确认替换并导入" }).click();
  await expect(dialog.getByRole("status")).toContainText("移除 2 个旧站点");
  expect(
    (await (await page.request.get(base + "/sites")).json()).sites,
  ).toHaveLength(1);

  await choose(page, "导入方式", "合并：保留未收录于备份的站点");
  await dialog.getByLabel("导入备份文件").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("not-json"),
  });
  await dialog.getByRole("button", { name: "合并导入" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Invalid JSON backup");
  expect(
    (await (await page.request.get(base + "/sites")).json()).sites,
  ).toHaveLength(1);
  expect(await (await page.request.get("/api/sites")).text()).not.toContain(
    "PRIVATE-FIXTURE",
  );
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  await expect(
    page.locator(".admin-metrics > div").last().locator("strong"),
  ).toHaveText("5分钟");
  expect(errors).toEqual([]);
});

test("sync and backup controls fit mobile and remain usable in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "同步与数据" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("spinbutton", { name: "同步间隔" }),
  ).toBeVisible();
  await choose(page, "时间单位", "小时");
  await expect(
    dialog.getByRole("spinbutton", { name: "同步间隔" }),
  ).toBeVisible();
  await choose(page, "备份格式", "SQLite (.db)");
  mkdirSync(resolve("../artifacts"), { recursive: true });
  await page.screenshot({
    path: "../artifacts/admin-settings-mobile-light.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await dialog.getByLabel("导入备份文件").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../artifacts/admin-settings-mobile-dark.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "同步与数据", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "同步与数据", exact: true }).click();
  await page.screenshot({
    path: "../artifacts/admin-settings-desktop.png",
    animations: "disabled",
  });
});
