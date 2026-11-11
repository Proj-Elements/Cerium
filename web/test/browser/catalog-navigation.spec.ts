import { expect, test } from "@playwright/test";

const group = (
  id: string,
  name: string,
  multiplier: number,
  model: string,
) => ({
  id,
  name,
  multiplier,
  models: [model],
  models_known: true,
});
const site = (id: string, groups: ReturnType<typeof group>[]) => ({
  id,
  name: `${id} 站点`,
  url: `https://${id}.example`,
  description: "目录测试",
  type: "newapi",
  icon: "",
  enabled: true,
  monitor_changes: true,
  recharge_cny: 7,
  recharge_usd: 1,
  payment_methods: ["支付宝"],
  payment_note: "",
  status: "ok",
  catalog: { scope: "public", groups },
});
const sites = [
  site("mixed", [
    group("expensive", "高价", 5, "gpt-5"),
    group("cheap", "低价", 0.1, "claude-sonnet-4"),
  ]),
  site("matching", [
    group("fast", "快速", 0.5, "gpt-5"),
    group("backup", "备用", 0.8, "gpt-5"),
  ]),
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: { sites, changes: [], interval: 900 },
    }),
  );
  await page.route("**/api/sites/*/icon", (route) =>
    route.fulfill({ json: { icons: [] } }),
  );
});

test("shareable links restore filters and group selection through reload and browser history", async ({
  page,
}) => {
  await page.goto("/?q=gpt&rate_min=0&rate_max=1&site=matching&group=fast");
  await expect(
    page.getByRole("textbox", { name: "搜索站点或模型" }),
  ).toHaveValue("gpt");
  await expect(
    page.getByRole("button", { name: "查看mixed 站点详情" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看matching 站点详情" }),
  ).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "matching 站点详情" });
  await expect(
    dialog.getByRole("region", { name: "快速 的模型" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    dialog.getByRole("region", { name: "快速 的模型" }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "返回分组", exact: true }).click();
  await expect(page).not.toHaveURL(/group=fast/);
  await dialog.getByRole("button", { name: /^备用 / }).click();
  await expect(page).toHaveURL(/group=backup/);
  await page.goBack();
  await expect(
    dialog.getByRole("region", { name: "分组模型卡片" }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(
    dialog.getByRole("region", { name: "快速 的模型" }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    dialog.getByRole("region", { name: "分组模型卡片" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭站点详情" }).click();
  await expect(page).not.toHaveURL(/site=/);
  await page.goBack();
  await expect(dialog).toBeVisible();
});

test("directory polling revalidates with ETag and reuses the cached directory on 304", async ({
  page,
}) => {
  let calls = 0;
  let conditional = "";
  await page.unroute("**/api/sites");
  await page.route("**/api/sites", async (route) => {
    calls++;
    conditional = route.request().headers()["if-none-match"] ?? "";
    if (conditional === '"catalog-v1"')
      await route.fulfill({ status: 304, headers: { ETag: '"catalog-v1"' } });
    else
      await route.fulfill({
        json: { sites, changes: [], interval: 900 },
        headers: { ETag: '"catalog-v1"' },
      });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "查看matching 站点详情" }),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.clock.fastForward(15000);
  await expect.poll(() => calls).toBe(2);
  expect(conditional).toBe('"catalog-v1"');
  await expect(
    page.getByRole("button", { name: "查看matching 站点详情" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("manual refreshes coalesce while pending and hidden pages pause polling", async ({
  page,
}) => {
  let calls = 0;
  let release: () => void = () => {};
  await page.unroute("**/api/sites");
  await page.route("**/api/sites", async (route) => {
    calls++;
    if (calls === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: { sites, changes: [], interval: 900 } });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "查看matching 站点详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "刷新目录" }).click();
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("button", { name: "刷新目录" }).click();
  await page.clock.fastForward(60000);
  expect(calls).toBe(2);
  release();
  await expect(page.locator(".refreshing")).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(120000);
  expect(calls).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls).toBe(3);
});

test("directory polling backs off after failure and restores data on recovery", async ({
  page,
}) => {
  let calls = 0;
  await page.unroute("**/api/sites");
  await page.route("**/api/sites", async (route) => {
    calls++;
    if (calls === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Temporary failure" },
      });
    else await route.fulfill({ json: { sites, changes: [], interval: 900 } });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Temporary failure");
  await page.clock.fastForward(15000);
  expect(calls).toBe(1);
  await page.clock.fastForward(15000);
  await expect.poll(() => calls).toBe(2);
  await expect(
    page.getByRole("button", { name: "查看matching 站点详情" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
