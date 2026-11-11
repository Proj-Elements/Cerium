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
  const base = session.adminPath + "/api";
  return {
    base,
    directory: await (await page.request.get(base + "/sites")).json(),
  };
}

test("stale edits retain the draft until the admin explicitly loads the latest configuration", async ({
  page,
}) => {
  const { base, directory } = await login(page);
  const site = {
    ...directory.sites.find(
      (entry: { type: string }) => entry.type === "others",
    ),
    name: "并发编辑测试站",
    revision: 10,
  };
  let current = site;
  const submissions: Record<string, unknown>[] = [];
  await page.route(
    (url) => url.pathname === base + "/sites",
    (route) => route.fulfill({ json: { ...directory, sites: [current] } }),
  );
  await page.route(
    (url) => url.pathname === `${base}/sites/${site.id}`,
    async (route) => {
      const submitted = route.request().postDataJSON();
      submissions.push(submitted);
      if (submissions.length === 1) {
        current = { ...site, revision: 11, name: "其他管理员已更新的名称" };
        await route.fulfill({
          status: 409,
          json: { error: "Site configuration changed; reload before saving" },
        });
      } else {
        current = { ...current, ...submitted, revision: 12 };
        await route.fulfill({ json: { id: site.id } });
      }
    },
  );
  await page.reload();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog");
  const name = editor.getByRole("textbox", { name: /^站名/ });
  await name.fill("尚未保存的本地草稿");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(name).toHaveValue("尚未保存的本地草稿");
  expect(submissions).toHaveLength(1);
  expect(submissions[0].revision).toBe(10);

  await editor
    .getByRole("button", { name: "载入最新配置", exact: true })
    .click();
  await expect(name).toHaveValue("其他管理员已更新的名称");
  await name.fill("合并后的名称");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toMatchObject({ revision: 11, name: "合并后的名称" });
  await expect(
    page.getByRole("heading", { name: "合并后的名称" }),
  ).toBeVisible();
});

test("admin history paginates beyond the first page and resets pagination when searching", async ({
  page,
}) => {
  const { base, directory } = await login(page);
  const site = directory.sites[0];
  const changes = Array.from({ length: 51 }, (_, index) => ({
    id: `history-${index + 1}`,
    site_id: site.id,
    site_name: index === 50 ? "历史第 51 条目标记录" : `历史记录 ${index + 1}`,
    checked_at: new Date(Date.now() - index * 60000).toISOString(),
    previous_checked_at: null,
    dismissed: false,
    details: [
      {
        kind: "multiplier",
        group_id: "default",
        name: "默认分组",
        before: 1,
        after: 2,
        before_dynamic: false,
        after_dynamic: false,
      },
    ],
  }));
  const requests: { offset: number; limit: number; query: string }[] = [];
  await page.route(
    (url) => url.pathname === base + "/changes",
    async (route) => {
      const parameters = new URL(route.request().url()).searchParams;
      const offset = Number(parameters.get("offset") ?? "0");
      const limit = Number(parameters.get("limit") ?? "50");
      const query = parameters.get("q") ?? "";
      requests.push({ offset, limit, query });
      const matching = changes.filter((change) =>
        change.site_name.includes(query),
      );
      await route.fulfill({
        json: {
          changes: matching.slice(offset, offset + limit),
          total: matching.length,
          offset,
          limit,
        },
      });
    },
  );
  await page
    .locator(".admin-tabs")
    .getByRole("button", { name: /动态/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "历史记录 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "历史第 51 条目标记录" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "历史第 51 条目标记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "上一页", exact: true }),
  ).toBeEnabled();
  expect(
    requests.some((request) => request.offset === 50 && request.limit === 50),
  ).toBe(true);

  await page.getByRole("textbox", { name: "搜索动态记录" }).fill("目标");
  await expect
    .poll(() => requests.at(-1))
    .toEqual({ offset: 0, limit: 50, query: "目标" });
  await expect(
    page.getByRole("heading", { name: "历史第 51 条目标记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "历史记录 1", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "上一页", exact: true }),
  ).toBeDisabled();
});

for (const type of ["newapi", "sub2api"])
  test(`${type} model discovery refresh requires deliberate confirmation and sends the explicit refresh contract`, async ({
    page,
  }) => {
    const { base, directory } = await login(page);
    const site = {
      ...directory.sites.find(
        (entry: { type: string }) => entry.type === "newapi",
      ),
      type,
      status: "ok",
      enabled: true,
    };
    const submissions: unknown[] = [];
    await page.route(
      (url) => url.pathname === base + "/sites",
      (route) => route.fulfill({ json: { ...directory, sites: [site] } }),
    );
    await page.route(
      (url) => url.pathname === `${base}/sites/${site.id}/models/refresh`,
      async (route) => {
        submissions.push(route.request().postDataJSON());
        await route.fulfill({ status: 202, json: { queued: true } });
      },
    );
    await page.reload();
    await page
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    const confirmation = page.getByRole("dialog");
    await expect(confirmation).toContainText(/临时.*(密钥|令牌)|API Key/);
    await expect(confirmation).toContainText(/费用|计费|消耗|付费/);
    expect(submissions).toHaveLength(0);
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    expect(submissions).toHaveLength(0);

    await page
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认刷新模型", exact: true })
      .click();
    await expect.poll(() => submissions).toEqual([{ confirmed: true }]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("模型");
  });
