import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runXhsSearch, normalizeXhsItems } from "../src/sources/xhs.mjs";

async function makeFakeCli(scriptBody) {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-xhs-"));
  const file = path.join(dir, "xhs");
  await writeFile(file, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("正常 envelope 归一化出结构化条目", async () => {
  const cli = await makeFakeCli(`
    console.log(JSON.stringify({
      ok: true,
      data: { items: [
        { id: "abc123", note_card: {
            title: "手机摄影的三个误区",
            desc: "第一段摘要内容，讲最常见的构图错误。",
            type: "normal",
            user: { nickname: "某摄影师" },
            interact_info: { liked_count: "12,345", collected_count: 678 },
            tag_list: [{ name: "摄影" }, { name: "手机" }],
        } },
        { id: "def456", note_card: { title: "第二个笔记", desc: "摘要", type: "video" } },
      ] },
    }));
  `);

  const result = await runXhsSearch({ keyword: "手机摄影" }, { command: cli });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, "手机摄影的三个误区");
  assert.equal(result.items[0].author, "某摄影师");
  assert.match(result.items[0].metrics, /赞 1\.2万/);
  assert.match(result.items[0].metrics, /藏 678/);
  assert.deepEqual(result.items[0].tags, ["摄影", "手机"]);
  assert.equal(result.items[1].noteType, "video");
  assert.ok(result.items[0].id.includes("abc123"));
});

test("顶层直接是数组也能收", () => {
  const items = normalizeXhsItems([{ id: "x", title: "标题", desc: "摘要" }], { keyword: "k" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "标题");
});

test("未登录 envelope 映射成 XHS_AUTH_REQUIRED", async () => {
  const cli = await makeFakeCli(`
    console.log(JSON.stringify({ ok: false, error: { code: "not_authenticated", message: "login required" } }));
  `);
  await assert.rejects(
    () => runXhsSearch({ keyword: "k" }, { command: cli }),
    (error) => error.code === "XHS_AUTH_REQUIRED" && /xhs login/.test(error.message),
  );
});

test("search.feeds not ready 且退出码 1 时归因到 XHS_FEEDS_MISSING", async () => {
  const cli = await makeFakeCli(`
    console.log("18:15:02 [xhs_cli.client] WARNING: search.feeds not ready after 15.0s");
    console.log("❌ Search failed: search.feeds not ready after 15.0s");
    process.exit(1);
  `);
  await assert.rejects(
    () => runXhsSearch({ keyword: "k" }, { command: cli }),
    (error) =>
      error.code === "XHS_FEEDS_MISSING" &&
      /登录态过期/.test(error.message) &&
      /--refs-file/.test(error.message),
  );
});

test("camoufox 依赖缺失归因到 XHS_CLI_BROKEN", async () => {
  const cli = await makeFakeCli(`
    console.log("❌ Search failed: manifest.json is missing. Addon path must be a path to an extracted addon.");
    process.exit(1);
  `);
  await assert.rejects(
    () => runXhsSearch({ keyword: "k" }, { command: cli }),
    (error) => error.code === "XHS_CLI_BROKEN" && /camoufox fetch/.test(error.message),
  );
});

test("命令不存在归因到 XHS_CLI_MISSING", async () => {
  await assert.rejects(
    () => runXhsSearch({ keyword: "k" }, { command: "/nonexistent/xhs-binary-xyz" }),
    (error) => error.code === "XHS_CLI_MISSING" && /pipx install/.test(error.message),
  );
});

test("返回非 JSON 时归因到 XHS_BAD_JSON", async () => {
  const cli = await makeFakeCli(`console.log("这不是 JSON");`);
  await assert.rejects(
    () => runXhsSearch({ keyword: "k" }, { command: cli }),
    (error) => error.code === "XHS_BAD_JSON",
  );
});

test("关键词为空在入口就拒绝", async () => {
  await assert.rejects(() => runXhsSearch({ keyword: "  " }), (error) => error.code === "BAD_REQUEST");
});

test("排序参数非法在入口就拒绝", async () => {
  await assert.rejects(
    () => runXhsSearch({ keyword: "k", sort: "bogus" }),
    (error) => error.code === "BAD_REQUEST" && /popular/.test(error.message),
  );
});
