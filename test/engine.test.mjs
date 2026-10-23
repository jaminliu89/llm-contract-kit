import test from "node:test";
import assert from "node:assert/strict";
import { generateWithContract, decideWithContract } from "../src/engine.mjs";
import { buildItemPrompt, buildDecisionPrompt } from "../src/prompt.mjs";

const topicContract = {
  name: "topics",
  task: "Generate Xiaohongshu topic candidates.",
  count: 3,
  fields: {
    title: { aliases: ["title", "标题"] },
    hook: { aliases: ["hook", "爆点"] },
  },
};

function topicsJson(n) {
  return JSON.stringify({
    items: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, hook: `h${i}` })),
  });
}

function fakeProvider(responses) {
  const prompts = [];
  return {
    prompts,
    text: async ({ prompt }) => {
      prompts.push(prompt);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { raw: typeof next === "function" ? next() : next, durationMs: 1, commandPreview: "fake" };
    },
  };
}

test("一次通过", async () => {
  const provider = fakeProvider([topicsJson(3)]);
  const result = await generateWithContract({ contract: topicContract, provider });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  assert.equal(result.attempts, 1);
  assert.equal(result.items[0].id, "topics-1");
});

test("数量错自动带修复指令重试并成功", async () => {
  const provider = fakeProvider([topicsJson(2), topicsJson(3)]);
  const result = await generateWithContract({ contract: topicContract, provider, maxRepairs: 2 });
  assert.equal(result.attempts, 2);
  assert.equal(result.items.length, 3);
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1], /失败位置/);
  assert.match(provider.prompts[1], /实际观测值/);
  assert.match(provider.prompts[1], /可接受的形态/);
});

test("重试耗尽后抛出带 trace 的错误", async () => {
  const provider = fakeProvider([topicsJson(1), topicsJson(1), topicsJson(1)]);
  await assert.rejects(
    () => generateWithContract({ contract: topicContract, provider, maxRepairs: 2 }),
    (error) => {
      assert.equal(error.code, "LLM_BAD_COUNT");
      assert.equal(error.details.attempts, 3);
      assert.equal(error.details.trace.length, 3);
      assert.match(error.message, /已自动重试 2 次/);
      return true;
    },
  );
});

test("可修复错误后接不可修复错误时立即透传", async () => {
  const { ContractError } = await import("../src/errors.mjs");
  const provider = fakeProvider([
    topicsJson(2),
    new ContractError("CLI_UNAVAILABLE", "找不到 codex", 503),
  ]);
  await assert.rejects(
    () => generateWithContract({ contract: topicContract, provider, maxRepairs: 3 }),
    (error) => error.code === "CLI_UNAVAILABLE",
  );
  assert.equal(provider.prompts.length, 2);
});

test("决策一路通过", async () => {
  const options = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const provider = fakeProvider([JSON.stringify({ selectedIds: ["b"], reason: "更契合" })]);
  const result = await decideWithContract({ decision: { kind: "topic", min: 1, max: 1 }, options, provider });
  assert.deepEqual(result.selectedIds, ["b"]);
  assert.equal(result.attempts, 1);
});

test("决策选错 id 后重试成功", async () => {
  const options = [{ id: "a" }, { id: "b" }];
  const provider = fakeProvider([
    JSON.stringify({ selectedIds: ["zzz"] }),
    JSON.stringify({ selectedIds: ["a"] }),
  ]);
  const result = await decideWithContract({ decision: { kind: "topic", min: 1, max: 1 }, options, provider });
  assert.deepEqual(result.selectedIds, ["a"]);
  assert.equal(result.attempts, 2);
  assert.match(provider.prompts[1], /可用的候选 id：a, b/);
});

test("决策候选 id 重复在入口就拒绝，不消耗模型调用", async () => {
  const provider = fakeProvider(["{}"]);
  await assert.rejects(
    () => decideWithContract({ decision: { kind: "topic" }, options: [{ id: "a" }, { id: "a" }], provider }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.equal(provider.prompts.length, 0);
});

test("prompt 里带上精确数量与 exact keys", () => {
  const prompt = buildItemPrompt(topicContract, { persona: "摄影师", keyword: "效率" });
  assert.match(prompt, /Generate exactly 3 items/);
  assert.match(prompt, /Use these exact keys on every item: title, hook/);
  assert.match(prompt, /"items":\[\{"title":"string","hook":"string"\}\]/);
  assert.match(prompt, /persona: 摄影师/);
});

test("决策 prompt 包含数量规则与全部 options id", () => {
  const prompt = buildDecisionPrompt({ kind: "rag", min: 1, max: 8 }, [
    { id: "x-1", title: "标题一" },
    { id: "x-2", title: "标题二" },
  ]);
  assert.match(prompt, /between 1 and 8 option IDs/);
  assert.match(prompt, /ID: x-1/);
  assert.match(prompt, /ID: x-2/);
  assert.match(prompt, /Do not invent or rewrite IDs/);
});
