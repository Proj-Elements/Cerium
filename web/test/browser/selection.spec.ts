import { expect, test } from "@playwright/test";

test("selected and keyboard-focused group badges keep their outlines inside the scroll area", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看北辰 API详情" }).click();
  const dialog = page.getByRole("dialog");
  const badge = dialog.getByRole("button", { name: /^auto / });
  await badge.click();
  for (const [width, height] of [
    [1440, 1000],
    [1024, 768],
    [844, 390],
    [568, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await badge.scrollIntoViewIfNeeded();
    await expect(badge).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        badge.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
          );
        }),
      )
      .toBeLessThanOrEqual(0);
    const bounds = await badge.boundingBox();
    const body = await dialog.locator(".modal__body").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(body!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      body!.x + body!.width,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await badge.scrollIntoViewIfNeeded();
  await badge.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toBeFocused();
  await expect(badge).toHaveCSS("outline-offset", "-2px");
  await expect(badge).toHaveCSS("box-shadow", "none");
  await dialog.locator(".group-section").screenshot({
    path: "../artifacts/fix-badge-outline-keyboard.png",
    animations: "disabled",
  });
  await dialog.getByRole("textbox", { name: "搜索 auto 的模型" }).click();
  await expect
    .poll(() =>
      badge.evaluate((element) => {
        const style = getComputedStyle(element);
        return parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      }),
    )
    .toBeLessThanOrEqual(0);
  await page.mouse.move(0, 0);
  await dialog.locator(".group-section").screenshot({
    path: "../artifacts/fix-badge-outline.png",
    animations: "disabled",
  });
  await page.screenshot({
    path: "../artifacts/fix-badge-outline-desktop.png",
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await dialog.locator(".group-section").screenshot({
    path: "../artifacts/fix-badge-outline-dark.png",
    animations: "disabled",
  });
});

test("HeroUI Pro selection menus support mouse, keyboard and mobile themes without native popups", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const sort = page.getByRole("button", { name: /排序方式/ });
  await expect(sort).toHaveAttribute("aria-haspopup", "listbox");
  expect(await sort.evaluate((trigger) => trigger.tagName)).toBe("BUTTON");
  await sort.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "默认排序", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator(".inline-select__popover .list-box-item"),
  ).toHaveCount(3);
  await page.screenshot({
    path: "../artifacts/fix-pro-select-desktop.png",
    animations: "disabled",
  });
  const triggerBounds = await sort.boundingBox();
  const menuBounds = await page.locator(".relay-select-popover").boundingBox();
  const left = Math.min(triggerBounds!.x, menuBounds!.x) - 12;
  const top = triggerBounds!.y - 12;
  await page.screenshot({
    path: "../artifacts/fix-pro-select.png",
    animations: "disabled",
    clip: {
      x: left,
      y: top,
      width:
        Math.max(
          triggerBounds!.x + triggerBounds!.width,
          menuBounds!.x + menuBounds!.width,
        ) -
        left +
        12,
      height: menuBounds!.y + menuBounds!.height - top + 12,
    },
  });
  await page.getByRole("option", { name: "最低倍率优先", exact: true }).click();
  await expect(sort).toContainText("最低倍率优先");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sort).toBeFocused();
  await expect(page.locator(".relay-card .rate-summary strong")).toHaveText([
    "0.6×",
    "0.6×",
    "0.8×",
    "1×",
  ]);
  await sort.press("Space");
  await expect(
    page.getByRole("option", { name: "最低倍率优先", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(sort).toContainText("最近更新优先");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sort).toBeFocused();
  await sort.press("Space");
  await expect(
    page.getByRole("option", { name: "最近更新优先", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sort).toContainText("最近更新优先");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const dark of [false, true]) {
    await page.evaluate(
      (enabled) => document.documentElement.classList.toggle("dark", enabled),
      dark,
    );
    await sort.click();
    await expect(sort).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(
      page.locator(
        '.relay-select-popover [role="option"][aria-selected="true"]',
      ),
    ).toBeFocused();
    await expect
      .poll(() =>
        page.locator(".relay-select-popover").evaluate((menu) => {
          const bounds = menu.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: `../artifacts/fix-pro-select-mobile${dark ? "-dark" : ""}.png`,
      animations: "disabled",
    });
    await page.getByRole("option", { name: "默认排序", exact: true }).click();
    await expect(sort).toContainText("默认排序");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
