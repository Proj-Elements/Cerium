import { expect, test } from "@playwright/test";

const site = {
  id: "presentation",
  name: "展示测试站",
  url: "https://presentation.example",
  type: "newapi",
  icon: "",
  description: "模型展示与倍率动态",
  enabled: true,
  payment_methods: [],
  status: "ok",
  fetched_at: "2026-11-02T10:00:00Z",
  catalog: {
    scope: "public",
    groups: [
      {
        id: "default",
        name: "default",
        multiplier: 1,
        models_known: true,
        models: [
          "gpt-6.1-terra",
          "codex-auto-review",
          "claude-opus-5-5-thinking",
          "z-ai/glm-5.3",
          "qwen3.8-27b",
        ],
        prices: [
          { model: "gpt-6.1-terra", mode: "tokens", input: 1, output: 5 },
          {
            model: "claude-opus-5-5-thinking",
            mode: "dynamic",
            expression: "input_tokens * 4 + output_tokens * 20",
          },
        ],
      },
    ],
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: {
        sites: [site],
        interval: 900,
        changes: [
          {
            id: "change",
            site_id: site.id,
            site_name: site.name,
            checked_at: "2026-11-02T11:00:00Z",
            previous_checked_at: site.fetched_at,
            details: [
              {
                kind: "added",
                group_id: "a",
                name: "新增线路",
                before: null,
                after: 1,
              },
              {
                kind: "removed",
                group_id: "b",
                name: "移除线路",
                before: 1,
                after: null,
              },
              {
                kind: "multiplier",
                group_id: "c",
                name: "上调线路",
                before: 1,
                after: 2,
              },
              {
                kind: "multiplier",
                group_id: "d",
                name: "下调线路",
                before: 1,
                after: 0.5,
              },
            ].map((detail) => ({
              ...detail,
              before_dynamic: false,
              after_dynamic: false,
            })),
          },
        ],
      },
    }),
  );
});

test("readable model names retain raw IDs and keep badges beside names on desktop and mobile", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".shell > footer")).toHaveCount(0);
  await page.getByRole("button", { name: `查看${site.name}详情` }).click();
  await page.getByRole("button", { name: /^default / }).click();
  const panel = page.locator(".model-panel");
  await expect(panel.getByTitle("gpt-6.1-terra", { exact: true })).toHaveText(
    "GPT 6.1 Terra",
  );
  await expect(
    panel.getByTitle("codex-auto-review", { exact: true }),
  ).toHaveText("Codex Auto Review");
  const opus = panel.getByTitle("claude-opus-5-5-thinking", { exact: true });
  await expect(opus).toHaveText("Claude Opus 5.5 Thinking");
  const row = panel.locator('tr[data-model-id="claude-opus-5-5-thinking"]');
  await expect(row.locator(".price-number")).toHaveText(["$4", "$20"]);
  await expect(row.locator(".price-unit")).toHaveText(["/ 1M", "/ 1M"]);
  await expect(row.locator(".model-identity .price-badge")).toHaveCount(2);
  await expect(row.locator("td:not(:first-child) .price-badge")).toHaveCount(0);

  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const layout = await row.evaluate((element) => {
        const cell = element.querySelector("td")!.getBoundingClientRect();
        const badges = [...element.querySelectorAll(".price-badge")].map(
          (badge) => badge.getBoundingClientRect(),
        );
        return {
          oneLine: Math.abs(badges[0].top - badges[1].top) < 1,
          contained: badges.every(
            (badge) => badge.left >= cell.left && badge.right <= cell.right,
          ),
        };
      });
      expect(layout).toEqual({ oneLine: true, contained: true });
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `../artifacts/presentation-models-${width}-${mode}.png`,
        animations: "disabled",
      });
    }
  }
  await panel.getByRole("textbox").fill("Claude Opus 5.5");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(opus).toBeVisible();
  await panel.getByRole("textbox").fill("claude-opus-5-5-thinking");
  await expect(opus).toBeVisible();
});

test("descriptions stay in details only and empty descriptions have no placeholder", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".relay-card .site-description")).toHaveCount(0);
  await expect(page.locator(".relay-card")).not.toContainText(site.description);
  await page.getByRole("button", { name: `查看${site.name}详情` }).click();
  await expect(page.locator(".detail-description")).toHaveText(
    site.description,
  );
  await page.getByRole("button", { name: "关闭站点详情" }).click();
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: {
        sites: [{ ...site, description: "" }],
        interval: 900,
        changes: [],
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: `查看${site.name}详情` }).click();
  await expect(page.locator(".detail-description")).toHaveCount(0);
  await expect(
    page.getByText("查看本站公开分组与倍率。", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("一个值得发现的 AI 入口，点击了解更多。", { exact: true }),
  ).toHaveCount(0);
});

test("multiplier activity uses one name and green/red semantic badges and values", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "倍率动态" })).toBeVisible();
  await page.getByRole("button", { name: "倍率动态", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".section-eyebrow")).toHaveText("倍率动态");
  await expect(dialog.locator(".added .chip--success")).toHaveText("新增");
  await expect(dialog.locator(".removed .chip--danger")).toHaveText("移除");
  await expect(dialog.locator(".increase .chip--default")).toHaveText("倍率");
  await expect(dialog.locator(".decrease .chip--default")).toHaveText("倍率");
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    if (mode === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    for (const kind of ["added", "removed"]) {
      const detail = dialog.locator(`.change-detail.${kind}`);
      const color = await detail.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await expect(detail.locator(".change-values")).toHaveCSS("color", color);
    }
    for (const [direction, token] of [
      ["increase", "--danger"],
      ["decrease", "--success"],
    ]) {
      const color = await page.evaluate((variable) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${variable})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }, token);
      await expect(
        dialog.locator(`.${direction} .change-values strong`),
      ).toHaveCSS("color", color);
    }
    await page.screenshot({
      path: `../artifacts/presentation-changes-${mode}.png`,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "关闭倍率动态" }).click();
  await expect(dialog).toHaveCount(0);
});
