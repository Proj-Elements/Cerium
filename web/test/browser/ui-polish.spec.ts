import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ChangeNotice, Directory, Group } from "../../src/types";

async function directory(page: Page) {
  return (await (await page.request.get("/api/sites")).json()) as Directory;
}

async function login(page: Page) {
  const { adminPath, password } = JSON.parse(
    readFileSync("test-results/session.json", "utf8"),
  );
  await page.goto(adminPath);
  await page.getByLabel("管理密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: /进入管理面板/ }).click();
  await expect(page.getByRole("heading", { name: "站点管理。" })).toBeVisible();
}

function notice(site: Directory["sites"][number], index: number): ChangeNotice {
  return {
    id: `ui-polish-${index}`,
    site_id: site.id,
    site_name: site.name,
    checked_at: new Date().toISOString(),
    previous_checked_at: null,
    details: [
      {
        kind: "multiplier",
        group_id: "default",
        name: "默认线路",
        before: 1,
        after: 0.8,
        before_dynamic: false,
        after_dynamic: false,
      },
    ],
  };
}

test("admin previews fit 1–5 complete chips plus a compact disclosure on one row", async ({
  page,
}) => {
  const { adminPath } = JSON.parse(
    readFileSync("test-results/session.json", "utf8"),
  );
  let long = false;
  await page.route(`**${adminPath}/api/sites`, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const data: Directory = await response.json();
    const groups: Group[] = Array.from({ length: 44 }, (_, index) => ({
      id: `preview-${index}`,
      name:
        long && index === 0
          ? "007高稳国模分组（全模型，超高缓存）".repeat(8)
          : `线路 ${index + 1}`,
      platform: "openai",
      multiplier: 0.1,
      models: ["gpt-5.2-codex"],
      models_known: true,
    }));
    data.sites[0].catalog = { scope: "public", groups };
    await route.fulfill({ response, json: data });
  });
  await login(page);
  const preview = page
    .locator(".admin-site")
    .first()
    .locator(".group-preview-list");
  const badges = preview.locator(".group-badge");
  const more = preview.locator(".group-preview-more");
  await expect(badges).toHaveCount(5);
  for (const [width, height] of [
    [1440, 1000],
    [900, 1000],
    [600, 844],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(async () => {
        return preview.evaluate((element) => {
          const chips = [
            ...element.querySelectorAll<HTMLElement>(".group-badge"),
          ];
          const count = chips.length;
          const bounds = element.getBoundingClientRect();
          const children = [...element.children].map((child) =>
            child.getBoundingClientRect(),
          );
          return (
            count >= 1 &&
            count <= 5 &&
            element.querySelector(".group-preview-more")?.textContent ===
              `+${44 - count} 个分组` &&
            (count === 1 ||
              chips.every((chip) => {
                const label = chip.querySelector<HTMLElement>(".badge-name")!;
                return label.scrollWidth <= label.clientWidth + 1;
              })) &&
            children.every(
              (child) =>
                child.left >= bounds.left - 1 &&
                child.right <= bounds.right + 1 &&
                Math.abs(
                  (child.top +
                    child.bottom -
                    children[0].top -
                    children[0].bottom) /
                    2,
                ) <= 1,
            ) &&
            element.scrollWidth <= element.clientWidth
          );
        });
      })
      .toBe(true);
    expect(
      await more.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeLessThanOrEqual(11);
    await page.screenshot({
      path: `../artifacts/ui-polish/after-preview-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  long = true;
  await page.reload();
  await expect(badges).toHaveCount(1);
  await expect(more).toHaveText("+43 个分组");
  const label = badges.locator(".badge-name");
  expect(
    await label.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect(await label.getAttribute("title")).toContain("007高稳国模分组");
  await more.click();
  await expect(page.getByRole("dialog").locator(".group-badge")).toHaveCount(
    44,
  );
  await page.getByRole("button", { name: "关闭站点详情" }).click();
  await badges.first().click();
  await expect(page.locator(".models-sheet")).toBeVisible();
});

test("right-hand details keep the same width and position when models open and close", async ({
  page,
}) => {
  await page.goto("/");
  for (const [width, height] of [
    [1440, 1000],
    [1024, 768],
    [844, 390],
    [568, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "查看北辰 API详情" }).click();
    const right = page.locator(".detail-sheet");
    const group = right.getByRole("button", { name: /^default / });
    await expect(right).toBeVisible();
    await page.locator(".detail-container").evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await expect
      .poll(() =>
        page
          .locator(".detail-container")
          .evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe("none");
    const before = (await right.boundingBox())!;
    await group.click();
    await expect(page.locator(".models-sheet")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await right.boundingBox())!.width - before.width),
      )
      .toBeLessThan(1);
    expect(Math.abs((await right.boundingBox())!.x - before.x)).toBeLessThan(1);
    await page.locator(".models-sheet").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await page.screenshot({
      path: `../artifacts/ui-polish/after-panels-${width}.png`,
    });
    await page.getByRole("button", { name: "返回分组", exact: true }).click();
    await expect(group).toBeFocused();
    expect(
      Math.abs((await right.boundingBox())!.width - before.width),
    ).toBeLessThan(1);
    await page.getByRole("button", { name: "关闭站点详情" }).click();
  }
});

test("search adornments, stale notices and text-icon actions have balanced spacing", async ({
  page,
}) => {
  const data = await directory(page);
  data.sites[0].status = "error";
  data.changes = [notice(data.sites[0], 0)];
  await page.route("**/api/sites", (route) => route.fulfill({ json: data }));
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "站点目录", exact: true }),
  ).toHaveCount(0);
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    const spacing = await page
      .locator(".catalog-toolbar .search")
      .evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const icon = element.querySelector("svg")!.getBoundingClientRect();
        const input = element.querySelector("input")!;
        const field = input.getBoundingClientRect();
        return {
          gap:
            field.left +
            parseFloat(getComputedStyle(input).paddingLeft) -
            icon.right,
          center: Math.abs(
            (icon.top + icon.bottom - field.top - field.bottom) / 2,
          ),
          left: icon.left - bounds.left,
        };
      });
    expect(spacing.gap).toBeGreaterThanOrEqual(10);
    expect(spacing.center).toBeLessThan(1);
    expect(spacing.left).toBeGreaterThanOrEqual(12);
    await page.getByRole("button", { name: "查看北辰 API详情" }).click();
    const facts = (await page.locator(".detail-facts").boundingBox())!;
    const payments = (await page.locator(".detail-payments").boundingBox())!;
    const warning = (await page
      .locator(".detail-overview .notice")
      .boundingBox())!;
    expect(payments.y - facts.y - facts.height).toBeGreaterThanOrEqual(11);
    expect(warning.y - payments.y - payments.height).toBeGreaterThanOrEqual(11);
    await page.screenshot({
      path: `../artifacts/ui-polish/after-stale-${width}.png`,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "关闭站点详情" }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "倍率动态", exact: true }).click();
  const button = page.locator(".change-site-button");
  await button.hover();
  const padding = await button.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    return {
      left: parseFloat(getComputedStyle(element).paddingLeft),
      right: bounds.right - icon.right,
      gap: parseFloat(getComputedStyle(element).gap),
    };
  });
  expect(padding.left).toBeGreaterThanOrEqual(9);
  expect(padding.right).toBeGreaterThanOrEqual(9);
  expect(padding.gap).toBeGreaterThanOrEqual(6);
  await button.click();
  await expect(page.getByRole("dialog")).toHaveAttribute(
    "aria-label",
    "北辰 API详情",
  );
  await page.getByRole("button", { name: "关闭站点详情" }).click();
  await page.unroute("**/api/sites");
  await login(page);
  const viewGroups = page
    .getByRole("button", { name: "查看分组", exact: true })
    .first();
  expect(
    await viewGroups.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    ),
  ).toBeGreaterThanOrEqual(9);
  await viewGroups.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("activity rails use site logos and preserve fallback icons across themes", async ({
  page,
}) => {
  const data = await directory(page);
  data.changes = data.sites.slice(0, 2).map(notice);
  await page.route("**/api/sites", (route) => route.fulfill({ json: data }));
  await page.route("**/api/sites/*/icon", (route) => {
    const id = route.request().url().split("/").at(-2);
    return route.fulfill({
      json: { icons: [`/assets/ui-polish-site-${id}.svg`] },
    });
  });
  await page.route("**/assets/ui-polish-site-*.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" rx="9" fill="#1769eb"/><path d="M9 18h18M18 9v18" stroke="white" stroke-width="3"/></svg>',
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "倍率动态", exact: true }).click();
  const logos = page.locator(".timeline__marker .site-icon img");
  await expect(logos).toHaveCount(2);
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    for (const [index, site] of data.sites.slice(0, 2).entries()) {
      await expect(logos.nth(index)).toHaveAttribute(
        "src",
        `/assets/ui-polish-site-${site.id}.svg`,
      );
    }
    await expect(page.locator(".timeline__marker > svg")).toHaveCount(0);
    await page.screenshot({
      path: `../artifacts/ui-polish/after-activity-${mode}.png`,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "关闭倍率动态" }).click();
  await page.route("**/api/sites/*/icon", (route) =>
    route.fulfill({ json: { icons: ["/missing-site-icon.png"] } }),
  );
  await page.getByRole("button", { name: "倍率动态", exact: true }).click();
  await expect
    .poll(() =>
      logos.evaluateAll((elements) =>
        elements.every((element) => {
          const image = element as HTMLImageElement;
          return (
            image.complete &&
            image.naturalWidth > 0 &&
            !image.src.includes("missing-site-icon")
          );
        }),
      ),
    )
    .toBe(true);
});

test("content and panel reveals honor reduced motion and back navigation restores group focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator(".intro-copy")).toHaveCSS(
    "animation-name",
    "reveal",
  );
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  const group = page
    .getByRole("dialog")
    .getByRole("button", { name: /^default / });
  await group.press("Enter");
  await expect(page.locator(".models-sheet")).toHaveCSS(
    "animation-name",
    "panel-enter",
  );
  await expect(page.locator(".model-panel")).toHaveCSS(
    "animation-name",
    "content-enter",
  );
  await page
    .getByRole("button", { name: "返回分组", exact: true })
    .press("Enter");
  await expect(group).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await group.press("Enter");
  expect(
    await page
      .locator(".models-sheet")
      .evaluate((element) =>
        parseFloat(getComputedStyle(element).animationDuration),
      ),
  ).toBeLessThan(0.001);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "返回分组", exact: true }).click();
  await expect(group).toBeFocused();
  await group.press("Enter");
  await expect(
    page.getByRole("button", { name: "返回分组", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "关闭模型详情" }).click();
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
});
