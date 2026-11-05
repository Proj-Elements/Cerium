import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Directory } from "../../src/types";

async function chooseOption(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeAll(async ({ request }) => {
  await expect
    .poll(
      async () => {
        const data = await (await request.get("/api/sites")).json();
        return data.sites.filter((s: { status: string }) =>
          ["ok", "manual"].includes(s.status),
        ).length;
      },
      { timeout: 60000 },
    )
    .toBe(4);
});

test("public directory, model prices, filters and responsive light/dark views", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(request.failure()?.errorText ?? request.url()),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "北辰 API" })).toBeVisible();
  await expect(page.getByText("PRIVATE-GROUP-NEVER-PUBLISH")).toHaveCount(0);
  await expect(page.locator(".relay-card")).toHaveCount(4);
  await expect(page.locator(".relay-card .group-badge")).toHaveCount(0);
  await expect(
    page.locator(".relay-card").first().locator(".rate-summary strong"),
  ).toHaveText("0.6×");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "全部分组 4" }),
  ).toBeVisible();
  await expect(dialog.locator(".group-badge")).toHaveCount(4);
  await expect(dialog.getByTitle("gpt-5.2", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: /default/ }).click();
  await expect(dialog.getByTitle("gpt-5.2", { exact: true })).toBeVisible();
  await expect(dialog.locator(".model-panel")).toHaveCSS("opacity", "1");
  const modelCard = await dialog.locator(".models-sheet").boundingBox();
  const groupCard = await dialog.locator(".detail-sheet").boundingBox();
  expect(modelCard!.width).toBeGreaterThan(400);
  expect(groupCard!.width).toBeGreaterThan(400);
  expect(modelCard!.x + modelCard!.width).toBeLessThan(groupCard!.x);
  expect(Math.abs(modelCard!.y - groupCard!.y)).toBeLessThan(2);
  await expect(dialog.locator(".detail-sheet .model-panel")).toHaveCount(0);
  await expect(
    dialog.getByRole("cell", { name: "$1.75 / 1M", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../artifacts/redesign-detail-desktop.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: /premium/ }).click();
  await expect(
    dialog.getByTitle("video-dynamic", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /auto/ }).click();
  await expect(dialog.locator(".model-rate")).toHaveText("动态");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "返回分组", exact: true }).click();
  await dialog.getByRole("button", { name: /default/ }).click();
  await page.screenshot({
    path: "../artifacts/redesign-detail-mobile.png",
    animations: "disabled",
  });
  await dialog.getByTitle("gpt-5.2", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../artifacts/redesign-models-mobile.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "关闭模型详情" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "../artifacts/public-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("textbox", { name: "搜索站点或模型" }).fill("松间");
  await expect(page.locator(".relay-card")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "搜索站点或模型" })
    .fill("no-such-site");
  await expect(page.getByText("没有找到匹配站点")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).last().click();
  await chooseOption(page, "站点类型", "Sub2API");
  await expect(page.locator(".relay-card")).toHaveCount(1);
  await chooseOption(page, "站点类型", "所有类型");
  await chooseOption(page, "充值方式", "LDXP");
  await expect(page.locator(".relay-card")).toHaveCount(2);
  await chooseOption(page, "充值方式", "所有充值方式");
  await chooseOption(page, "主题设置", "深色模式");
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: "../artifacts/public-desktop-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  for (const [width, height, columns] of [
    [390, 844, 1],
    [768, 1024, 1],
    [1024, 768, 2],
    [844, 390, 2],
    [568, 320, 2],
    [1600, 1000, 2],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page
        .locator(".site-grid")
        .evaluate(
          (grid) =>
            getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(columns);
    await expect(page.locator(".relay-card")).toHaveCount(4);
    expect(
      await page
        .locator(".relay-card")
        .first()
        .evaluate((card) => card.getBoundingClientRect().height),
    ).toBeLessThan(150);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: `../artifacts/redesign-public-${width}x${height}-dark.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(page, "主题设置", "浅色模式");
  await page.screenshot({
    path: "../artifacts/public-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("reference prices, Lobe model icons and hidden dynamic expressions work across themes and touch", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(request.failure()?.errorText ?? "failed request"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  await page.getByRole("button", { name: /premium/ }).click();
  const panel = page.locator(".model-panel");
  const row = (model: string) =>
    panel.locator("tbody tr").filter({
      has: page.getByTitle(model, { exact: true }),
    });
  const opus = row("claude-opus-5-5-thinking");
  await expect(opus.locator(".price-number")).toHaveText(["$4", "$20"]);
  await expect(opus.locator('[data-price-source="default"]')).toHaveCount(2);
  await expect(
    opus.getByRole("img", { name: "Anthropic / Claude" }),
  ).toBeVisible();
  const glm = row("z-ai/glm-5.3");
  await expect(glm.locator(".price-number")).toHaveText(["$1.4", "$4.4"]);
  await expect(glm.getByRole("img", { name: "Z.ai" })).toBeVisible();
  await expect(row("glm-5.3-flash").locator(".price-number")).toHaveText([
    "$0.15",
    "$0.5",
  ]);
  await expect(row("qwen3.8-27b").locator(".price-number")).toHaveText([
    "—",
    "—",
  ]);
  await expect(
    row("qwen3.8-27b").getByRole("img", { name: "Qwen", exact: true }),
  ).toBeVisible();
  await expect(
    row("gpt-5.2").locator("td:not(:first-child) .price-number"),
  ).toHaveText(["$2.625", "$21"]);
  await expect(
    row("gpt-5.2").getByRole("button", { name: /默认价格来源/ }),
  ).toHaveCount(0);
  await expect(panel.getByText("计费表达式", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("input_tokens * 4 + output_tokens * 20", { exact: true }),
  ).toHaveCount(0);
  const dynamic = opus.getByRole("button", {
    name: "claude-opus-5-5-thinking 的动态计费说明",
  });
  await dynamic.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "input_tokens * 4 + output_tokens * 20",
  );
  await page.screenshot({
    path: "../artifacts/prices-desktop-hover.png",
    animations: "disabled",
  });
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await dynamic.focus();
  await expect(page.getByRole("tooltip")).toContainText("站点使用动态计费");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await dynamic.press("Shift+Tab");
  await expect(
    opus.getByRole("button", { name: /默认价格来源/ }),
  ).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("保守归一化匹配");
  await expect(page.getByRole("tooltip")).toContainText("未乘分组倍率");
  await page.mouse.move(0, 0);
  await panel.getByRole("textbox").focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme,
    );
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await panel.getByRole("textbox").fill("");
      await panel.locator(".price-table-wrap").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: `../artifacts/prices-${width}-${theme}.png`,
        animations: "disabled",
      });
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
      expect(
        await panel
          .locator(".model-icon img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      ).toBe(true);
    }
  }
  await panel.getByRole("textbox").fill("claude-opus-5-5-thinking");
  await dynamic.click();
  await expect(page.getByRole("tooltip")).toContainText(
    "input_tokens * 4 + output_tokens * 20",
  );
  await page.screenshot({
    path: "../artifacts/prices-mobile-dynamic.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("default-price loading failures leave upstream prices usable", async ({
  page,
}) => {
  await page.route(/\/assets\/model-prices-[\w-]+\.js$/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  await page.getByRole("button", { name: /default/ }).click();
  await expect(page.getByText("默认价暂不可用", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "$1.75 / 1M", exact: true }),
  ).toBeVisible();
});

test("dynamic-price badges disclose expressions on real touch and dismiss on blur", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "查看北辰 API详情" }).tap();
    await page.getByRole("button", { name: /premium/ }).tap();
    const search = page.locator(".model-panel").getByRole("textbox");
    await search.fill("claude-opus-5-5-thinking");
    await page
      .getByRole("button", { name: "claude-opus-5-5-thinking 的动态计费说明" })
      .tap();
    await expect(page.getByRole("tooltip")).toContainText(
      "input_tokens * 4 + output_tokens * 20",
    );
    await search.tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page
      .getByRole("button", { name: "claude-opus-5-5-thinking 的默认价格来源" })
      .tap();
    await expect(page.getByRole("tooltip")).toContainText("LiteLLM 默认参考价");
    await page.screenshot({
      path: "../artifacts/prices-touch-source.png",
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
});

test("provider and inclusive dual-thumb filters match the same group", async ({
  page,
}) => {
  await page.goto("/");
  const families = page.getByRole("group", { name: "分组平台筛选" });
  const lower = page.getByRole("slider", { name: /倍率下限/ });
  const upper = page.getByRole("slider", { name: /倍率上限/ });
  await expect(page.locator(".catalog-toolbar .slider__track")).toHaveCount(1);
  await expect(page.getByRole("slider")).toHaveCount(2);
  await families.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.locator(".relay-card")).toHaveCount(3);
  await expect(
    page.locator(".relay-card").first().locator(".rate-summary strong"),
  ).toHaveText("1×");
  for (let i = 0; i < 4; i++) await lower.press("PageUp");
  await upper.press("Home");
  await expect(lower).toHaveValue("0.8");
  await expect(upper).toHaveValue("0.8");
  await expect(page.locator(".relay-card")).toHaveCount(1);
  await expect(page.locator(".relay-card")).toContainText("松间模型");
  await expect(page.locator(".rate-summary strong")).toHaveText("0.8×");
  await families.getByRole("button", { name: "GPT / Codex" }).click();
  await expect(page.getByText("没有找到匹配站点")).toBeVisible();
  await page.getByRole("button", { name: "重置倍率", exact: true }).click();
  await expect(page.locator(".relay-card")).toHaveCount(3);
  for (let i = 0; i < 6; i++) await lower.press("PageUp");
  await upper.press("Home");
  await expect(lower).toHaveValue("1.2");
  await expect(upper).toHaveValue("1.2");
  await expect(page.locator(".relay-card")).toHaveCount(1);
  await expect(page.locator(".relay-card")).toContainText("松间模型");
  await expect(page.locator(".rate-summary strong")).toHaveText("1.2×");
  await page.screenshot({
    path: "../artifacts/compact-filtered-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.locator(".relay-card")).toHaveCount(4);

  const track = await page
    .locator(".catalog-toolbar .slider__track")
    .boundingBox();
  const thumb = await page
    .locator(".catalog-toolbar .slider__thumb")
    .first()
    .boundingBox();
  await page.mouse.move(
    thumb!.x + thumb!.width / 2,
    thumb!.y + thumb!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    track!.x + track!.width / 2,
    track!.y + track!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await lower.inputValue()))
    .toBeGreaterThan(0.9);
  await expect
    .poll(async () => Number(await lower.inputValue()))
    .toBeLessThan(1.1);
  await expect(upper).toHaveValue("2");
  await page.getByRole("button", { name: "重置倍率", exact: true }).click();
  await expect(page.locator(".relay-card")).toHaveCount(4);
});

test("Sub2API badges, group filters and independent responsive model cards", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看松间模型详情" }).click();
  const dialog = page.getByRole("dialog");
  const claude = dialog.getByRole("button", { name: /Claude 稳定线路/ });
  const codex = dialog.getByRole("button", { name: /Codex 专线/ });
  await expect(claude.locator('[data-platform="anthropic"]')).toHaveCount(1);
  await expect(claude.locator('[data-platform="openai"]')).toHaveCount(0);
  await expect(codex.locator('[data-platform="openai"]')).toHaveCount(1);
  await claude.click();
  await expect(
    dialog.getByTitle("claude-sonnet-4-5", { exact: true }),
  ).toBeVisible();
  await codex.click();
  await expect(
    dialog.getByTitle("gpt-5.2-codex", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByTitle("claude-sonnet-4-5", { exact: true }),
  ).toHaveCount(0);
  for (const [width, height] of [
    [1440, 1000],
    [1024, 768],
    [844, 390],
    [568, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        dialog.locator(".detail-sheet, .models-sheet").evaluateAll((cards) =>
          cards.every((card) => {
            const bounds = card.getBoundingClientRect();
            return bounds.bottom <= innerHeight && bounds.right <= innerWidth;
          }),
        ),
      )
      .toBe(true);
    const left = await dialog.locator(".models-sheet").boundingBox();
    const right = await dialog.locator(".detail-sheet").boundingBox();
    expect(left!.x + left!.width).toBeLessThan(right!.x);
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
    expect(left!.width).toBeGreaterThan(width >= 1024 ? 400 : 240);
    expect(right!.width).toBeGreaterThan(width >= 1024 ? 400 : 220);
    expect(right!.x + right!.width).toBeLessThanOrEqual(width);
    expect(left!.y + left!.height).toBeLessThanOrEqual(height);
    expect(
      await dialog
        .locator(".detail-sheet, .models-sheet")
        .evaluateAll((cards) =>
          cards.every((card) => card.scrollWidth <= card.clientWidth),
        ),
    ).toBe(true);
    await expect(dialog.locator(".detail-sheet .model-panel")).toHaveCount(0);
    if (height < 550) {
      expect(
        await dialog
          .locator(".modal__body")
          .evaluate((body) => body.clientHeight),
      ).toBeGreaterThan(110);
      await claude.scrollIntoViewIfNeeded();
      await claude.click();
      await expect(dialog.locator(".models-sheet")).toContainText(
        "Claude Sonnet 4.5",
      );
      await codex.click();
    }
    await page.screenshot({
      path: `../artifacts/compact-sub2api-${width}x${height}.png`,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(dialog.locator(".models-sheet")).toHaveCount(0);
  await expect(dialog.locator(".group-badge")).toHaveCount(1);
  await expect(claude).toBeVisible();
  await dialog.getByRole("textbox", { name: "搜索分组" }).fill("Codex");
  await expect(dialog.getByText("没有符合条件的分组")).toBeVisible();
  await dialog.getByRole("button", { name: "清除分组筛选" }).click();
  const lower = dialog.getByRole("slider", { name: /倍率下限/ });
  const upper = dialog.getByRole("slider", { name: /倍率上限/ });
  for (let i = 0; i < 4; i++) await lower.press("PageUp");
  await upper.press("Home");
  await expect(dialog.locator(".group-badge")).toHaveCount(1);
  await expect(claude).toBeVisible();
  await claude.click();
  await page.screenshot({
    path: "../artifacts/compact-sub2api-desktop.png",
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: "../artifacts/compact-sub2api-desktop-dark.png",
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator(".detail-sheet")).toBeHidden();
  await expect(dialog.locator(".models-sheet")).toBeVisible();
  await dialog.getByRole("button", { name: "返回分组", exact: true }).click();
  await expect(dialog.locator(".detail-sheet")).toBeVisible();
  await expect(claude).toBeVisible();
  await claude.click();
  await expect(
    dialog.getByRole("button", { name: "返回分组", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: "../artifacts/compact-sub2api-mobile.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "关闭模型详情" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("long model lists scroll independently and every model remains reachable", async ({
  page,
}) => {
  await page.route("**/api/sites", async (route) => {
    const response = await route.fetch();
    const data: Directory = await response.json();
    const group = data.sites
      .find((site) => site.name === "北辰 API")!
      .catalog!.groups.find((item) => item.id === "default")!;
    group.models = Array.from(
      { length: 120 },
      (_, i) => `gpt-fixture-${String(i).padStart(3, "0")}`,
    );
    group.prices = [];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /default/ }).click();
  const right = dialog.locator(".detail-sheet .modal__body");
  const initialScroll = await right.evaluate((body) => body.scrollTop);
  await expect(dialog.locator("tbody tr")).toHaveCount(30);
  await dialog.getByRole("button", { name: /再显示 50 个/ }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(80);
  await dialog.getByRole("button", { name: /再显示 50 个/ }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(120);
  await dialog
    .getByTitle("gpt-fixture-119", { exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await dialog
      .locator(".price-table-wrap")
      .evaluate((table) => table.scrollTop),
  ).toBeGreaterThan(0);
  expect(await right.evaluate((body) => body.scrollTop)).toBe(initialScroll);
  await expect(dialog.getByRole("button", { name: /premium/ })).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "搜索 default 的模型" })
    .fill("fixture-119");
  await expect(dialog.locator("tbody tr")).toHaveCount(1);
  await expect(
    dialog.getByTitle("gpt-fixture-119", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /premium/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "搜索 premium 的模型" }),
  ).toHaveValue("");
});

test("admin login, edit, sync, create, hide, delete and logout", async ({
  page,
}) => {
  const { adminPath, password } = JSON.parse(
    readFileSync(resolve("test-results/session.json"), "utf8"),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(adminPath);
  await expect(
    page.getByRole("heading", { name: "打理你的目录。" }),
  ).toBeVisible();
  await page.screenshot({
    path: "../artifacts/admin-login.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("管理密码", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: /进入管理面板/ }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect");
  await page.getByLabel("管理密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: /进入管理面板/ }).click();
  await expect(page.getByRole("heading", { name: "站点管理。" })).toBeVisible();
  await page.screenshot({
    path: "../artifacts/admin-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .locator(".admin-site")
    .filter({ hasText: "松间模型" })
    .getByRole("button", { name: /Claude 稳定线路/ })
    .click();
  await expect(page.getByRole("dialog").locator(".models-sheet")).toContainText(
    "Claude Sonnet 4.5",
  );
  await expect(
    page.getByRole("dialog").locator(".group-badge[aria-pressed=true]"),
  ).toContainText("Claude 稳定线路");
  await page.getByRole("button", { name: "关闭模型详情" }).click();
  await page
    .locator(".admin-site")
    .first()
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByLabel("密码（留空保留原密码）", { exact: true }),
  ).toHaveValue("");
  await page.screenshot({
    path: "../artifacts/admin-editor.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.getByRole("dialog").evaluate((dialog) => {
      const edge = dialog.getBoundingClientRect();
      return [...dialog.querySelectorAll("input")].every(
        (input) =>
          input.type === "checkbox" ||
          input.getBoundingClientRect().right <= edge.right,
      );
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../artifacts/admin-editor-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("一句话简介").fill("已验证持久化编辑与同步。");
  await page.getByRole("button", { name: "保存并同步" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .locator(".admin-site")
      .first()
      .getByRole("button", { name: "同步", exact: true }),
  ).toBeEnabled();
  await page
    .locator(".admin-site")
    .first()
    .getByRole("button", { name: "同步", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("同步任务");
  await page.getByRole("button", { name: "添加站点", exact: true }).click();
  await page.getByLabel("站名", { exact: true }).fill("UI 测试手动站");
  await chooseOption(page, "站点类型", "其他 / 手动维护");
  await page
    .getByLabel("站点 URL", { exact: true })
    .fill("https://ui-test.example");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const created = page
    .locator(".admin-site")
    .filter({ hasText: "UI 测试手动站" });
  await expect(created).toBeVisible();
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator(".publish-row")
    .filter({ hasText: "公开展示" })
    .locator(".switch__control")
    .click();
  await expect(
    page.getByRole("switch", { name: "公开展示" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(created.getByText("已隐藏")).toBeVisible();
  const publicData = await (await page.request.get("/api/sites")).json();
  expect(
    publicData.sites.some((s: { name: string }) => s.name === "UI 测试手动站"),
  ).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../artifacts/admin-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await created.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(created).toHaveCount(0);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "打理你的目录。" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "打理你的目录。" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("NewAPI token editor, real Go synchronization and blank-token retention", async ({
  page,
}) => {
  const { adminPath, password, upstreamURL } = JSON.parse(
    readFileSync(resolve("test-results/session.json"), "utf8"),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(adminPath);
  await page.getByLabel("管理密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: /进入管理面板/ }).click();
  await page.getByRole("button", { name: "添加站点", exact: true }).click();
  await page.getByLabel("站名", { exact: true }).fill("Token 登录测试");
  await page
    .getByLabel("站点 URL", { exact: true })
    .fill(upstreamURL + "/token");
  await chooseOption(page, "认证方式", "访问令牌 + 用户 ID");
  await expect(page.getByLabel("账号 / 邮箱", { exact: true })).toHaveCount(0);
  await page.getByLabel("用户 ID", { exact: true }).fill("42");
  await page
    .getByLabel("访问令牌", { exact: true })
    .fill("fixture-panel-token");
  await page.getByLabel("用户 ID", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../artifacts/admin-token-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("用户 ID", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../artifacts/admin-token-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: "../artifacts/admin-token-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "保存并同步" }).click();
  const created = page
    .locator(".admin-site")
    .filter({ hasText: "Token 登录测试" });
  await expect(created).toBeVisible();
  await expect
    .poll(async () => {
      const data = await (await page.request.get("/api/sites")).json();
      return data.sites.find(
        (s: { name: string }) => s.name === "Token 登录测试",
      )?.status;
    })
    .toBe("ok");
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("button", { name: /认证方式/ })).toContainText(
    "访问令牌 + 用户 ID",
  );
  await expect(page.getByLabel("用户 ID", { exact: true })).toHaveValue("42");
  await expect(
    page.getByLabel("访问令牌（留空保留原令牌）", { exact: true }),
  ).toHaveValue("");
  await page.getByLabel("一句话简介").fill("保留令牌后重新同步");
  await page.getByRole("button", { name: "保存并同步" }).click();
  await expect
    .poll(async () => {
      const data = await (await page.request.get("/api/sites")).json();
      return data.sites.find(
        (s: { name: string }) => s.name === "Token 登录测试",
      )?.status;
    })
    .toBe("ok");
  const pub = await (await page.request.get("/api/sites")).text();
  for (const field of [
    "fixture-panel-token",
    "access_token",
    "user_id",
    "PRIVATE-GROUP-NEVER-PUBLISH",
  ])
    expect(pub).not.toContain(field);
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await chooseOption(page, "认证方式", "账号密码");
  await expect(page.getByLabel("账号 / 邮箱", { exact: true })).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "required",
    "",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await created.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(created).toHaveCount(0);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  expect(errors).toEqual([]);
});

test("group changes surface publicly and admins can withdraw or restore the announcement", async ({
  page,
}) => {
  const { adminPath, password } = JSON.parse(
    readFileSync(resolve("test-results/session.json"), "utf8"),
  );
  await page.goto(adminPath);
  await page.getByLabel("管理密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: /进入管理面板/ }).click();
  await page.getByRole("button", { name: "添加站点", exact: true }).click();
  await page.getByLabel("站名", { exact: true }).fill("波动测试站");
  await chooseOption(page, "站点类型", "其他 / 手动维护");
  await page
    .getByLabel("站点 URL", { exact: true })
    .fill("https://changes.example");
  await page
    .getByLabel("分组 JSON")
    .fill(
      JSON.stringify([
        { id: "base", name: "基础组", multiplier: 1, models: [] },
      ]),
    );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const created = page.locator(".admin-site").filter({ hasText: "波动测试站" });
  await expect(created).toBeVisible();
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("分组 JSON").fill(
    JSON.stringify([
      { id: "base", name: "基础组", multiplier: 0.7, models: [] },
      { id: "new", name: "新线路", multiplier: 1.5, models: [] },
    ]),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("button", { name: /倍率动态 1/ })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("region", { name: "倍率动态" })).toContainText(
    "波动测试站",
  );
  await page.getByRole("button", { name: "查看动态" }).click();
  await expect(page.getByRole("dialog")).toContainText("基础组");
  await expect(page.getByRole("dialog")).toContainText("新线路");
  await page.screenshot({
    path: "../artifacts/redesign-changes-desktop.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭倍率动态" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../artifacts/redesign-changes-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.goto(adminPath);
  await page.getByRole("button", { name: /倍率动态 1/ }).click();
  const notice = page.locator(".change-item").filter({ hasText: "波动测试站" });
  await expect(notice).toContainText("基础组");
  await page.screenshot({
    path: "../artifacts/redesign-changes-admin.png",
    animations: "disabled",
  });
  await notice.getByRole("button", { name: "撤下通报" }).click();
  await expect(notice.getByRole("button", { name: "恢复通报" })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/sites")).json()).changes.length,
    )
    .toBe(0);
  await notice.getByRole("button", { name: "恢复通报" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/sites")).json()).changes.length,
    )
    .toBe(1);
  await page.getByRole("button", { name: /站点目录/ }).click();
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator(".publish-row")
    .filter({ hasText: "倍率动态监测" })
    .locator(".switch__control")
    .click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(created).toContainText("已暂停监测");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/sites")).json()).changes.length,
    )
    .toBe(0);
  await created.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator(".publish-row")
    .filter({ hasText: "倍率动态监测" })
    .locator(".switch__control")
    .click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/sites")).json()).changes.length,
    )
    .toBe(1);
  await created.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(created).toHaveCount(0);
});

test("unavailable discovered icons fall back to bundled provider icons", async ({
  page,
}) => {
  await page.route("**/api/sites/*/icon", (route) =>
    route.fulfill({ json: { icons: ["/missing-site-icon.png"] } }),
  );
  await page.goto("/");
  const icons = page.locator(".relay-card .site-icon img");
  await expect(icons).toHaveCount(4);
  await expect
    .poll(() =>
      icons.evaluateAll((images) =>
        images.every((image) => {
          const icon = image as HTMLImageElement;
          return (
            icon.complete &&
            icon.naturalWidth > 0 &&
            !icon.src.includes("missing-site-icon")
          );
        }),
      ),
    )
    .toBe(true);
  await expect(icons.nth(0)).toHaveAttribute("src", /newapi/);
  await expect(icons.nth(1)).toHaveAttribute("src", /sub2api|data:image\/svg/);
});
