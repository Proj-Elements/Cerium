import { test, expect } from "@playwright/test";

const site = {
  id: "4b6974a0-dea2-4a74-a0ec-bcce36163495",
  name: "实时图标与模型动态",
  url: "https://catalog-notices.example",
  type: "others",
  icon: "",
  icon_revision: 1,
  description: "",
  enabled: true,
  monitor_changes: true,
  recharge_cny: null,
  recharge_usd: null,
  payment_methods: [],
  payment_note: "",
  fetched_at: null,
  last_checked: null,
  status: "manual",
  catalog: { scope: "public", groups: [] },
};

test("an open directory refreshes the configured cached icon without reloading the page", async ({
  page,
}) => {
  let revision = 1;
  const endpoint = `/api/sites/${site.id}/icon/image`;
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: {
        sites: [{ ...site, icon_revision: revision }],
        changes: [],
        interval: 900,
      },
    }),
  );
  await page.route(`**/api/sites/${site.id}/icon`, (route) =>
    route.fulfill({ json: { icons: [endpoint] } }),
  );
  await page.route(`**${endpoint}*`, (route) => {
    const size =
      new URL(route.request().url()).searchParams.get("v") === "2" ? 32 : 16;
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="green"/></svg>`,
    });
  });
  await page.goto("/");
  const icon = page.locator(".relay-card .site-icon img");
  await expect(icon).toHaveAttribute("src", endpoint + "?v=1");
  await expect
    .poll(() =>
      icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(16);
  revision = 2;
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await expect(icon).toHaveAttribute("src", endpoint + "?v=2");
  await expect
    .poll(() =>
      icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(32);
});

test("model and price notices disclose exact changes and billing expressions", async ({
  page,
}) => {
  const checkedAt = new Date().toISOString();
  const common = {
    group_id: "g",
    name: "分组",
    before: 1,
    after: 1,
    before_dynamic: false,
    after_dynamic: false,
  };
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: {
        sites: [site],
        interval: 900,
        changes: [
          {
            id: "notice",
            site_id: site.id,
            site_name: site.name,
            checked_at: checkedAt,
            previous_checked_at: checkedAt,
            details: [
              {
                ...common,
                kind: "models",
                models_added: ["gpt-added"],
                models_removed: ["gpt-removed"],
              },
              {
                ...common,
                kind: "prices",
                price_changes: [
                  {
                    model: "gpt-added",
                    before: {
                      model: "gpt-added",
                      mode: "tokens",
                      input: 0,
                      output: 1e-7,
                    },
                    after: {
                      model: "gpt-added",
                      mode: "dynamic",
                      expression: "tokens * 2",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page
    .locator(".announcement")
    .getByRole("button", { name: "查看动态" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("新增 1 个模型 · 移除 1 个模型", { exact: true })
    .click();
  await expect(
    dialog.getByText("新增 gpt-added", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("移除 gpt-removed", { exact: true }),
  ).toBeVisible();
  await dialog.getByText("1 个模型价格调整", { exact: true }).click();
  await expect(
    dialog.getByText("动态：tokens * 2", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/输入 \$0 · 输出 \$0\.0000001/)).toBeVisible();
});
