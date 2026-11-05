import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { parseBackup, serializeBackup } from "../server/backup.mjs";

const defaults = ["云猫寄售", "链动小铺", "站点直充"];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cerium-payments-")),
    path = join(dir, "web.db");
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(path);
    },
  };
}

test("payment presets have requested defaults, persist and do not reset the sync interval", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.paymentPresets, defaults);
  f.store.setInterval(120);
  f.store.setSettings({ payment_presets: [...defaults, "银行卡"] });
  assert.equal(f.store.interval, 120);
  f.restart();
  assert.deepEqual(f.store.paymentPresets, [...defaults, "银行卡"]);
  assert.equal(f.store.interval, 120);
});

test("invalid preset updates do not partially change settings", (t) => {
  const { store } = fixture(t);
  for (const payment_presets of [
    null,
    "card",
    [""],
    ["x".repeat(41)],
    Array(33).fill("card"),
    [false],
  ]) {
    assert.throws(
      () => store.setSettings({ sync_interval_seconds: 120, payment_presets }),
      { status: 400 },
    );
    assert.equal(store.interval, 900);
    assert.deepEqual(store.paymentPresets, defaults);
  }
  store.setSettings({ payment_presets: [" card ", "card"] });
  assert.deepEqual(store.paymentPresets, ["card"]);
});

for (const format of ["json", "sqlite"]) {
  test(`${format} backups preserve payment presets and old backups keep current presets`, async (t) => {
    const { store: source } = fixture(t),
      { store: target } = fixture(t);
    source.setSettings({ payment_presets: [...defaults, "银行卡"] });
    target.importData(
      parseBackup(await serializeBackup(source, format), format),
    );
    assert.deepEqual(target.paymentPresets, [...defaults, "银行卡"]);
    const old = source.exportData();
    delete old.settings.payment_presets;
    target.setSettings({ payment_presets: ["已配置渠道"] });
    target.importData(old);
    assert.deepEqual(target.paymentPresets, ["已配置渠道"]);
  });
}

test("new recharge entries use one USD while legacy pairs normalize without losing value", (t) => {
  const { store } = fixture(t),
    config = {
      name: "Legacy recharge",
      url: "https://recharge.example",
      type: "others",
      payment_methods: ["Legacy channel"],
      recharge_cny: 10,
      recharge_usd: 20,
      recharge_multiplier: 2,
    };
  const id = store.save(config);
  const saved = JSON.parse(store.row(id).config);
  assert.equal(saved.recharge_cny, 0.5);
  assert.equal(saved.recharge_usd, 1);
  assert.equal(saved.recharge_multiplier, undefined);
  assert.deepEqual(saved.payment_methods, ["Legacy channel"]);
  assert.equal(store.sites()[0].recharge_multiplier, undefined);
});
