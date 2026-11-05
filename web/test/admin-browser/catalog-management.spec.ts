import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function login(page: Page) {
  const session = JSON.parse(
    readFileSync(resolve("test-results/admin-data-session.json"), "utf8"),
  );
  await page.goto(session.adminPath);
  await page.getByRole("textbox", { name: "管理密码" }).fill(session.password);
  await page.getByRole("button", { name: "进入管理面板" }).click();
  await expect(page.getByRole("heading", { name: "站点管理。" })).toBeVisible();
  return session;
}

test("payment presets can be extended and selected with a normalized recharge rate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await login(page),
    base = session.adminPath + "/api",
    headers = { Origin: "http://127.0.0.1:4185", "X-Cerium-Admin": "1" };
  const original = await (await page.request.get(base + "/settings")).json();
  let id: string | undefined;
  try {
    await page.getByRole("button", { name: "同步与数据", exact: true }).click();
    const settings = page.getByRole("dialog");
    await settings
      .getByRole("textbox", { name: "支付渠道预设（每行一个）" })
      .fill("云猫寄售\n链动小铺\n站点直充\n银行卡");
    await settings.getByRole("button", { name: "保存支付渠道" }).click();
    await expect(settings.getByRole("status")).toContainText(
      "支付渠道预设已保存",
    );
    await settings.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "添加站点", exact: true }).click();
    const editor = page.getByRole("dialog");
    await expect(editor.locator(".automatic-icon")).toHaveCount(0);
    await expect(editor.getByText("充值倍率 ×", { exact: true })).toHaveCount(
      0,
    );
    await expect(editor.getByRole("spinbutton")).toHaveCount(1);
    await editor.getByRole("textbox", { name: /^站名/ }).fill("充值表单测试站");
    await editor.getByRole("button", { name: /站点类型/ }).click();
    await page
      .getByRole("option", { name: "其他 / 手动维护", exact: true })
      .click();
    await editor
      .getByRole("textbox", { name: "站点 URL" })
      .fill("https://recharge-browser.example");
    await editor
      .getByRole("spinbutton", { name: "充值兑换（可选）" })
      .fill("0.5");
    await editor
      .locator(".checkbox__content")
      .filter({ hasText: "云猫寄售" })
      .click();
    await editor
      .locator(".checkbox__content")
      .filter({ hasText: "银行卡" })
      .click();
    await expect(
      editor.getByRole("checkbox", { name: "云猫寄售", exact: true }),
    ).toBeChecked();
    await expect(
      editor.getByRole("checkbox", { name: "银行卡", exact: true }),
    ).toBeChecked();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const data = await (await page.request.get(base + "/sites")).json();
    const site = data.sites.find(
      (value: { name: string }) => value.name === "充值表单测试站",
    );
    id = site.id;
    expect(site.recharge_cny).toBe(0.5);
    expect(site.recharge_usd).toBe(1);
    expect(site.recharge_multiplier).toBeUndefined();
    expect(site.payment_methods).toEqual(["云猫寄售", "银行卡"]);
    await page.request.put(base + "/settings", {
      headers,
      data: { payment_presets: original.payment_presets },
    });
    await page.reload();
    const card = page
      .locator(".admin-site")
      .filter({ has: page.getByRole("heading", { name: site.name }) });
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "银行卡", exact: true }),
    ).toBeChecked();
    const legacyLabel = page
      .locator(".checkbox__content")
      .filter({ hasText: "银行卡" });
    await legacyLabel.click();
    await expect(legacyLabel).toBeVisible();
    await legacyLabel.click();
    await expect(
      page.getByRole("checkbox", { name: "银行卡", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("spinbutton", { name: "充值兑换（可选）" }),
    ).toHaveValue("0.5");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.goto("/");
    await page.getByRole("button", { name: `查看${site.name}详情` }).click();
    await expect(page.locator(".detail-facts")).toContainText(
      "0.5 CNY = 1 USD",
    );
    await expect(page.locator(".detail-facts")).not.toContainText("充值倍率");
    expect(errors).toEqual([]);
  } finally {
    if (id) await page.request.delete(`${base}/sites/${id}`, { headers });
    await page.request.put(base + "/settings", { headers, data: original });
  }
});

test("editor controls align on desktop and fit narrow mobile in both themes", async ({
  page,
}) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "添加站点", exact: true }).click();
  const editor = page.getByRole("dialog");
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        mode === "dark",
      );
      const field = editor.getByRole("textbox", { name: /^站名/ });
      const type = editor.getByRole("button", { name: /站点类型/ });
      await field.scrollIntoViewIfNeeded();
      const nameBox = await field.boundingBox(),
        typeBox = await type.boundingBox();
      expect(Math.abs(nameBox!.height - typeBox!.height)).toBeLessThan(1);
      if (width > 640)
        expect(Math.abs(nameBox!.y - typeBox!.y)).toBeLessThan(1);
      expect(
        await editor.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `../artifacts/catalog-editor-${width}-${mode}.png`,
        animations: "disabled",
      });
      if (width <= 640) {
        const recharge = editor.getByRole("spinbutton", {
          name: "充值兑换（可选）",
        });
        await recharge.scrollIntoViewIfNeeded();
        const amountBox = await recharge.boundingBox();
        const unitBox = await editor
          .locator(".recharge-fields > span")
          .boundingBox();
        expect(
          Math.abs(
            amountBox!.y +
              amountBox!.height / 2 -
              unitBox!.y -
              unitBox!.height / 2,
          ),
        ).toBeLessThan(1);
        await page.screenshot({
          path: `../artifacts/catalog-recharge-${width}-${mode}.png`,
          animations: "disabled",
        });
      }
    }
  }
});

test("payment selection respects the twelve-channel site limit", async ({
  page,
}) => {
  const session = await login(page);
  const response = await (
    await page.request.get(session.adminPath + "/api/sites")
  ).json();
  const presets = Array.from({ length: 13 }, (_, index) => `渠道 ${index + 1}`);
  await page.route("**/api/sites", (route) =>
    route.fulfill({ json: { ...response, payment_presets: presets } }),
  );
  await page.reload();
  await page.getByRole("button", { name: "添加站点", exact: true }).click();
  const editor = page.getByRole("dialog");
  for (const method of presets.slice(0, 12)) {
    await editor
      .locator(".checkbox__content")
      .getByText(method, { exact: true })
      .click();
  }
  const last = editor.getByRole("checkbox", { name: presets[12], exact: true });
  await expect(last).toBeDisabled();
  await editor
    .locator(".checkbox__content")
    .getByText(presets[0], { exact: true })
    .click();
  await expect(last).toBeEnabled();
});

test("failed and backed-off sites offer retry but a running sync stays disabled", async ({
  page,
}) => {
  const session = await login(page);
  const response = await (
    await page.request.get(session.adminPath + "/api/sites")
  ).json();
  const original = response.sites.find(
    (site: { type: string }) => site.type === "newapi",
  );
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: {
        ...response,
        sites: [
          { ...original, status: "error", error: "Temporary upstream error" },
        ],
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重新同步", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "重新同步", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("同步任务已加入");
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: { ...response, sites: [{ ...original, status: "retrying" }] },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重新同步", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/sites", (route) =>
    route.fulfill({
      json: { ...response, sites: [{ ...original, status: "pending" }] },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "同步", exact: true }),
  ).toBeDisabled();
});
