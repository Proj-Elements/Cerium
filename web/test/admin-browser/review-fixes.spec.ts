import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("a failed admin chunk shows a reload action that recovers the login page", async ({
  page,
}, testInfo) => {
  const session = JSON.parse(
    readFileSync(resolve("test-results/admin-data-session.json"), "utf8"),
  );
  const chunk = /\/assets\/Admin-[\w-]+\.js$/;
  await page.route(chunk, (route) => route.abort());
  await page.goto(session.adminPath);
  const failure = page.getByRole("alert");
  await expect(failure).toContainText("页面加载失败");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const backgrounds = new Set<string>();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.dataset.theme = theme;
      }, colorScheme);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        colorScheme,
      );
      backgrounds.add(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`load-failure-${width}-${colorScheme}.png`),
      });
    }
    expect(backgrounds.size).toBe(2);
  }
  await page.unroute(chunk);
  await failure.getByRole("button", { name: "刷新页面" }).click();
  await expect(page.getByRole("textbox", { name: "管理密码" })).toBeVisible();
  await expect(failure).toHaveCount(0);
});

for (const body of ["<html>proxy error</html>", "{}", "null"])
  test(`an invalid successful response is recoverable and never displays an empty directory: ${body}`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/sites", (route) =>
      route.fulfill({ status: 200, body }),
    );
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("暂时无法加载目录");
    await expect(page.getByText("目录尚待点亮")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("directory-error.png") });
    await page.unroute("**/api/sites");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "测试手动站" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

test("a failed refresh retains the loaded directory and stays usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const site = page.getByRole("heading", { name: "测试手动站" });
  await expect(site).toBeVisible();
  await page.route("**/api/sites", (route) => route.fulfill({ json: {} }));
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "刷新失败，暂时显示已加载的数据",
  );
  await expect(site).toBeVisible();
  await page.unroute("**/api/sites");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("legacy duplicate quotes are shown as ambiguous in both detail and comparison", async ({
  page,
  request,
}) => {
  const directory = await (await request.get("/api/sites")).json();
  const site = directory.sites.find(
    (entry: { type: string }) => entry.type === "others",
  );
  const group = site.catalog.groups[0];
  group.models = ["gpt-6.1-sol"];
  group.models_known = true;
  group.prices = [
    { model: "gpt-6.1-sol", mode: "tokens", input: 1, output: 1 },
    { model: "gpt-6.1-sol", mode: "tokens", input: 100, output: 100 },
  ];
  site.recharge_cny = site.recharge_usd = 1;
  await page.route("**/api/sites", (route) =>
    route.fulfill({ json: { ...directory, sites: [site] } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: `查看${site.name}详情` }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${group.name} `) })
    .click();
  await expect(page.locator(".model-panel")).toContainText(
    "重复报价，无法确认单价",
  );
  await expect(page.locator(".model-panel .price-number")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭模型详情" }).click();
  await page.locator(".model-comparison summary").click();
  await expect(page.locator(".comparison-table")).toContainText(
    "重复报价，无法确认单价",
  );
  await expect(page.locator(".comparison-cost")).toHaveCount(0);
});

test("a recent pricing sync still exposes an old model snapshot in detail and comparison", async ({
  page,
  request,
}, testInfo) => {
  const directory = await (await request.get("/api/sites")).json();
  const site = directory.sites.find(
    (entry: { type: string }) => entry.type === "others",
  );
  const group = site.catalog.groups[0];
  Object.assign(group, {
    models: ["gpt-6.1-sol"],
    models_known: true,
    models_source: "gateway_once",
    models_fetched_at: "2020-01-01T00:00:00Z",
    prices: [{ model: "gpt-6.1-sol", mode: "tokens", input: 1, output: 2 }],
  });
  site.status = "ok";
  site.type = "sub2api";
  site.fetched_at = new Date().toISOString();
  site.recharge_cny = site.recharge_usd = 1;
  await page.route("**/api/sites", (route) =>
    route.fulfill({ json: { ...directory, sites: [site] } }),
  );
  await page.goto("/");
  await page.locator(".model-comparison summary").click();
  await expect(page.locator(".comparison-table")).toContainText(
    "模型列表较旧或时间未知",
  );
  await expect(page.locator(".comparison-table")).toContainText(
    "模型采集：2020",
  );
  await expect(page.locator(".comparison-cost")).toHaveText("¥3");
  await page.getByRole("button", { name: `查看${site.name}详情` }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${group.name} `) })
    .click();
  await expect(page.locator(".model-panel").getByRole("note")).toContainText(
    "模型列表较旧或时间未知",
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(
      colorScheme === "dark" ? /dark/ : /^(?!.*dark)/,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`old-models-${colorScheme}.png`),
      animations: "disabled",
    });
  }
});
