import { expect, test } from "@playwright/test";

const model = "cost-model";
const common = {
  url: "https://comparison.example",
  type: "others",
  icon: "",
  description: "",
  enabled: true,
  monitor_changes: true,
  recharge_usd: 1,
  payment_methods: [],
  payment_note: "",
  status: "manual",
  fetched_at: "2026-11-11T00:00:00Z",
};
const sites = [
  {
    ...common,
    id: "low-credit",
    name: "低额度价",
    recharge_cny: 8,
    catalog: {
      scope: "public",
      groups: [
        {
          id: "default",
          name: "Default",
          multiplier: 0.0000001,
          models_known: true,
          models: [model, "tiny-model"],
          prices: [
            { model, mode: "tokens", input: 1, output: 1 },
            {
              model: "tiny-model",
              mode: "tokens",
              input: 0.0000001,
              output: 0,
            },
          ],
        },
      ],
    },
  },
  {
    ...common,
    id: "low-cash",
    name: "低充值价",
    recharge_cny: 2,
    catalog: {
      scope: "public",
      groups: [
        {
          id: "standard",
          name: "Standard",
          multiplier: 5,
          models_known: true,
          models: [model],
          prices: [{ model, mode: "tokens", input: 2, output: 2 }],
        },
        {
          id: "dynamic",
          name: "Dynamic",
          multiplier: null,
          multiplier_source: "auto",
          models_known: true,
          models: [model],
          prices: [{ model, mode: "dynamic", expression: "tokens * factor" }],
        },
        {
          id: "request",
          name: "Per request",
          multiplier: 1,
          models_known: true,
          models: [model],
          prices: [{ model, mode: "request", request: 0.25 }],
        },
      ],
    },
  },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sites", (route) =>
    route.fulfill({ json: { sites, changes: [], interval: 900 } }),
  );
  await page.route("**/api/sites/*/icon", (route) =>
    route.fulfill({ json: { icons: [] } }),
  );
});

test("model comparison distinguishes recharge cost from credits and separates dynamic and per-request billing", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".relay-select")).toHaveCount(3);
  await expect(page.locator(".comparison-table")).toHaveCount(0);
  await page.locator(".model-comparison summary").click();
  await expect(page.getByLabel("比较模型", { exact: true })).toHaveValue(model);
  const rows = page.locator(".comparison-table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("低充值价");
  await expect(rows.first()).toContainText("¥8");
  await expect(rows.filter({ hasText: "Dynamic" })).toContainText("动态计费");
  await expect(rows.filter({ hasText: "Per request" })).toContainText(
    "按次计费",
  );
  await page.getByLabel("比较费用单位", { exact: true }).selectOption("USD");
  await expect(rows.first()).toContainText("低额度价");
  await expect(rows.first()).toContainText("$2");
  await page
    .getByLabel("比较计费方式", { exact: true })
    .selectOption("request");
  await page.getByLabel("请求次数", { exact: true }).fill("4");
  await expect(rows.first()).toContainText("Per request");
  await expect(rows.first()).toContainText("$1");
  await expect(page.getByRole("status")).toContainText("1 个分组可计算");
  await page.getByLabel("比较模型", { exact: true }).fill("cost-model-other");
  await expect(
    page.getByText("当前筛选范围没有这个完整模型 ID。", { exact: true }),
  ).toBeVisible();
});

test("tiny prices and multipliers stay nonzero and comparison fits narrow screens", async ({
  page,
}) => {
  await page.goto("/");
  const site = page.locator(".relay-card").filter({ hasText: "低额度价" });
  await expect(site.locator(".rate-summary strong")).toHaveText("0.0000001×");
  await page
    .getByRole("button", { name: "查看低额度价详情", exact: true })
    .click();
  await page.getByRole("button", { name: /^Default / }).click();
  await expect(
    page.locator('tr[data-model-id="tiny-model"] .price-number'),
  ).toHaveText(["$0.0000001", "$0"]);
  await page.getByRole("button", { name: "关闭模型详情", exact: true }).click();
  await page.locator(".model-comparison summary").click();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../artifacts/model-comparison-mobile-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
});
