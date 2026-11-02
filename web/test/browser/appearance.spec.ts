import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function chooseTheme(page: Page, label: string) {
  await page.getByRole("button", { name: /主题设置/ }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("filter values stay compact and the header keeps only the Cerium wordmark", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator(".brand")).toContainText("Cerium");
  await expect(page.locator(".brand .element")).toHaveCount(0);
  await expect(page.locator(".brand small")).toHaveCount(0);
  await expect(page.locator(".relay-select")).toHaveCount(3);

  for (const [width, height] of [
    [1440, 1000],
    [768, 1024],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const values = await page
        .locator(".relay-select .inline-select__value")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            const label = element.querySelector(".label");
            return {
              font: parseFloat(style.fontSize),
              weight: Number(style.fontWeight),
              labelFont: label
                ? getComputedStyle(label).fontSize
                : style.fontSize,
              valueFont: style.fontSize,
              fits: element.scrollWidth <= element.clientWidth,
            };
          }),
        );
      for (const value of values) {
        expect(value.font).toBeLessThanOrEqual(width <= 600 ? 11 : 12);
        expect(value.weight).toBeLessThanOrEqual(400);
        expect(value.labelFont).toBe(value.valueFont);
        expect(value.fits).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `../artifacts/polish-public-${width}-${mode}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});

test("back-to-groups button contains its icon and text and supports keyboard navigation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  const dialog = page.getByRole("dialog");
  const group = dialog.getByRole("button", { name: /^default / });
  for (const [width, height] of [
    [1440, 1000],
    [844, 390],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await group.click();
      const back = dialog.getByRole("button", {
        name: "返回分组",
        exact: true,
      });
      await back.focus();
      await expect(back).toBeFocused();
      await back.hover();
      const layout = await back.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        const content = range.getBoundingClientRect();
        return {
          height: bounds.height,
          leftPadding: icon.left - bounds.left,
          rightPadding: bounds.right - content.right,
          iconMargin: getComputedStyle(button.querySelector("svg")!).marginLeft,
        };
      });
      expect(layout.height).toBeGreaterThanOrEqual(34);
      expect(layout.leftPadding).toBeGreaterThanOrEqual(9);
      expect(layout.rightPadding).toBeGreaterThanOrEqual(9);
      expect(layout.iconMargin).toBe("0px");
      await dialog.locator(".models-sheet-header").screenshot({
        path: `../artifacts/polish-back-${width}-${mode}.png`,
        animations: "disabled",
      });
      await page.screenshot({
        path: `../artifacts/polish-models-${width}-${mode}.png`,
        animations: "disabled",
      });
      await back.press("Enter");
      await expect(dialog.locator(".models-sheet")).toHaveCount(0);
      await expect(group).toBeVisible();
    }
  }
});

test("system theme follows media changes, explicit themes persist and all three choices are accessible", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(request.url()));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  const trigger = page.getByRole("button", { name: /主题设置/ });
  await expect(root).toHaveAttribute("data-theme", "system");
  await expect(root).toHaveClass("dark");
  await expect(trigger).toHaveAttribute("aria-label", "主题设置：跟随系统");

  await trigger.press("Space");
  await expect(page.getByRole("listbox", { name: "主题模式" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(3);
  await expect(
    page.getByRole("option", { name: "跟随系统", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: "../artifacts/polish-theme-desktop-dark.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).not.toHaveClass("dark");

  await chooseTheme(page, "深色模式");
  await expect(root).toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveClass("dark");
  expect(await page.evaluate(() => localStorage.getItem("cerium-theme"))).toBe(
    "dark",
  );
  await page.reload();
  await expect(root).toHaveClass("dark");
  await expect(trigger).toHaveAttribute("aria-label", "主题设置：深色模式");

  await chooseTheme(page, "浅色模式");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).not.toHaveClass("dark");
  await page.reload();
  await expect(root).not.toHaveClass("dark");
  await expect(root).toHaveAttribute("data-theme", "light");

  await chooseTheme(page, "跟随系统");
  await expect(root).toHaveClass("dark");
  await page.reload();
  await expect(root).toHaveClass("dark");
  await expect(root).toHaveAttribute("data-theme", "system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).not.toHaveClass("dark");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await trigger.click();
      const bounds = await page.locator(".theme-select-popover").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../artifacts/polish-theme-${width}-${mode}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
});

test("theme is applied before React boot without relaxing the content security policy", async ({
  browser,
  baseURL,
}) => {
  for (const [preference, system, expected] of [
    [null, "dark", "dark"],
    [null, "light", "light"],
    ["invalid", "dark", "dark"],
    ["system", "dark", "dark"],
    ["system", "light", "light"],
    ["light", "dark", "light"],
    ["dark", "light", "dark"],
  ] as const) {
    const context = await browser.newContext({ baseURL, colorScheme: system });
    const page = await context.newPage();
    await page.addInitScript((value) => {
      if (value !== null) localStorage.setItem("cerium-theme", value);
    }, preference);
    await page.route(/\/assets\/index-[\w-]+\.js$/, (route) =>
      route.fulfill({ body: "", contentType: "text/javascript" }),
    );
    const response = await page.goto("/");
    expect(response!.headers()["content-security-policy"]).toContain(
      "script-src 'self';",
    );
    await expect(page.locator("#root")).toBeEmpty();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      preference === "invalid" || preference === null ? "system" : preference,
    );
    expect(
      await page
        .locator("html")
        .evaluate((root) => root.classList.contains("dark")),
    ).toBe(expected === "dark");
    await context.close();
  }
});

test("theme remains usable without storage and synchronizes preferences between tabs and admin", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL, colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass("dark");
  await chooseTheme(page, "浅色模式");
  await expect(page.locator("html")).not.toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass("dark");
  await chooseTheme(page, "跟随系统");
  await expect(page.locator("html")).toHaveClass("dark");
  await context.close();

  const shared = await browser.newContext({ baseURL, colorScheme: "dark" });
  const publicPage = await shared.newPage();
  const admin = await shared.newPage();
  const { adminPath } = JSON.parse(
    readFileSync("test-results/session.json", "utf8"),
  );
  await publicPage.goto("/");
  await admin.goto(adminPath);
  await expect(admin.locator(".brand .element")).toHaveCount(0);
  await chooseTheme(publicPage, "浅色模式");
  await expect(admin.locator("html")).not.toHaveClass("dark");
  await expect(admin.getByRole("button", { name: /主题设置/ })).toHaveAttribute(
    "aria-label",
    "主题设置：浅色模式",
  );
  await chooseTheme(admin, "跟随系统");
  await expect(publicPage.locator("html")).toHaveClass("dark");
  await expect(publicPage.locator("html")).toHaveAttribute(
    "data-theme",
    "system",
  );
  await shared.close();
});
