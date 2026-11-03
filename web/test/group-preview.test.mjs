import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPreviewCount } from "../src/group-preview.ts";

test("previews show at most five groups and at least one nonempty group", () => {
  assert.equal(
    groupPreviewCount(1000, Array(8).fill(30), Array(8).fill(60), 8),
    5,
  );
  assert.equal(groupPreviewCount(0, [900, 200], [80, 80], 8), 1);
  assert.equal(groupPreviewCount(200, [], [], 8), 0);
});

test("actual label widths and the more action determine the largest single-row preview", () => {
  const groups = [120, 240, 40, 50, 60];
  const more = [64, 64, 64, 64, 64];
  assert.equal(groupPreviewCount(350, groups, more, 8), 1);
  assert.equal(groupPreviewCount(500, groups, more, 8), 3);
  assert.equal(groupPreviewCount(614, groups, more, 8), 5);
  assert.equal(groupPreviewCount(613, groups, more, 8), 4);
});

test("the disclosure action gets its own gap and disappears when every group fits", () => {
  const groups = [100, 100, 100];
  const more = [62, 62, 0];
  assert.equal(groupPreviewCount(277, groups, more, 8), 1);
  assert.equal(groupPreviewCount(278, groups, more, 8), 2);
  assert.equal(groupPreviewCount(316, groups, more, 8), 3);
  assert.equal(groupPreviewCount(140, [100, 20], [100, 0], 8), 2);
});

test("changing viewport and count-label widths recomputes rather than freezing the preview", () => {
  const groups = Array(5).fill(30);
  assert.equal(groupPreviewCount(250, groups, Array(5).fill(60), 8), 5);
  assert.equal(groupPreviewCount(249, groups, Array(5).fill(60), 8), 4);
  assert.equal(groupPreviewCount(250, groups, Array(5).fill(70), 8), 4);
  assert.equal(groupPreviewCount(140, groups, Array(5).fill(60), 8), 2);
});
