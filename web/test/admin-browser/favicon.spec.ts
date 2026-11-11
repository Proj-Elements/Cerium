import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test.use({ reducedMotion: "reduce" });

test("cached favicon survives refresh without any browser request to the provider", async ({
  page,
}) => {
  const session = JSON.parse(
      readFileSync(resolve("test-results/admin-data-session.json"), "utf8"),
    ),
    base = session.adminPath + "/api",
    headers = {
      Origin: "http://127.0.0.1:4185",
      "X-Cerium-Admin": "1",
    },
    config = {
      name: "Favicon fixture",
      url: "https://favicon-browser-fixture.example",
      type: "others",
      icon: "",
      payment_methods: [],
      manual_catalog: { groups: [{ id: "g", name: "Group", multiplier: 1 }] },
    },
    iconURL = config.url + "/favicon-fixed.svg",
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#166534"/></svg>';
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().startsWith(config.url))
      externalRequests.push(request.url());
  });
  const login = await page.request.post(base + "/login", {
    headers,
    data: { password: session.password },
  });
  expect(login.status()).toBe(200);
  const created = await page.request.post(base + "/sites", {
    headers,
    data: config,
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const cachedURL = `/api/sites/${id}/icon/image`;
  const cachedSource = new RegExp(`^${cachedURL}(?:\\?v=\\d+)?$`);
  try {
    const backupResponse = await page.request.post(
      base + "/data/export?format=json",
      { headers },
    );
    expect(backupResponse.status()).toBe(200);
    const backup = await backupResponse.json();
    backup.sites = backup.sites.filter(
      (site: { id: string }) => site.id === id,
    );
    backup.changes = [];
    backup.sites[0].favicon = {
      url: config.url,
      icons: [iconURL],
      selected: iconURL,
    };
    backup.sites[0].favicon_cache = {
      type: "image/svg+xml",
      data: Buffer.from(svg).toString("base64"),
    };
    const restored = await page.request.post(
      base + "/data/import?format=json&mode=merge",
      {
        headers,
        data: backup,
      },
    );
    expect(restored.status()).toBe(200);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const card = page.locator(".relay-card").filter({
      has: page.getByRole("heading", { name: config.name, exact: true }),
    });
    const icon = card.locator(".site-icon img");
    await card.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("src", cachedSource);
    await expect
      .poll(() =>
        icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(16);

    const current = await (await page.request.get(`${base}/sites`)).json();
    const revision = current.sites.find(
      (site: { id: string }) => site.id === id,
    ).revision;
    const edited = await page.request.put(`${base}/sites/${id}`, {
      headers,
      data: {
        ...config,
        revision,
        manual_catalog: {
          groups: [{ id: "g", name: "Group", multiplier: 0.75 }],
        },
      },
    });
    expect(edited.status()).toBe(200);
    await page
      .getByRole("button", { name: "\u5237\u65b0\u76ee\u5f55", exact: true })
      .click();
    await expect(card.locator(".rate-summary strong")).toContainText("0.75");
    await expect(icon).toHaveAttribute("src", cachedSource);
    await page.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("src", cachedSource);
    await expect
      .poll(() =>
        icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(16);
    const cachedImage = await page.request.get(cachedURL);
    expect(cachedImage.status()).toBe(200);
    expect(await cachedImage.text()).toBe(svg);
    await page.screenshot({ path: "../artifacts/favicon-cache-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("src", cachedSource);
    await expect
      .poll(() =>
        icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(16);
    await page.screenshot({ path: "../artifacts/favicon-cache-mobile.png" });

    await page.route(`**${cachedURL}*`, (route) =>
      route.fulfill({ status: 404, body: "Missing" }),
    );
    await page.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("src", /\/assets\/newapi.*\.png$/);
    await expect
      .poll(() =>
        icon.evaluate((image) => {
          const node = image as HTMLImageElement;
          return node.complete && node.naturalWidth > 0;
        }),
      )
      .toBe(true);
    expect(
      await (await page.request.get(`/api/sites/${id}/icon`)).json(),
    ).toEqual({ icons: [cachedURL] });
    const exported = await (
      await page.request.post(base + "/data/export?format=json", { headers })
    ).json();
    expect(
      exported.sites.find((site: { id: string }) => site.id === id).favicon,
    ).toEqual(backup.sites[0].favicon);
    expect(
      exported.sites.find((site: { id: string }) => site.id === id)
        .favicon_cache,
    ).toEqual(backup.sites[0].favicon_cache);
    await page.route(`**/api/sites/${id}/icon`, (route) =>
      route.fulfill({ json: { icons: [iconURL] } }),
    );
    await page.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(icon).toHaveAttribute("src", /\/assets\/newapi.*\.png$/);
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`${base}/sites/${id}`, { headers });
  }
});
