import assert from "node:assert/strict";
import { test } from "node:test";
import { toDateString } from "./dates.ts";
import { timeZone } from "./timezone.ts";

test("默认时区是 Asia/Shanghai，跨日按上海时间计算", () => {
  assert.equal(timeZone, "Asia/Shanghai");
  // UTC 16:30 已经是上海次日 00:30。
  assert.equal(toDateString(new Date("2026-11-28T16:30:00Z")), "2026-11-29");
  // UTC 15:59 仍是上海当天 23:59。
  assert.equal(toDateString(new Date("2026-11-28T15:59:00Z")), "2026-11-28");
});
