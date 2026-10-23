import test from "node:test";
import assert from "node:assert/strict";
import { normalizeItems, normalizeDecision, parseLooseJson, buildRepairPrompt } from "../src/validate.mjs";
import { ContractError } from "../src/errors.mjs";

const topicContract = {
  name: "topics",
  task: "Generate Xiaohongshu topic candidates.",
  count: 10,
  fields: {
    title: { aliases: ["title", "标题", "选题标题"] },
    angle: { aliases: ["angle", "选题角度", "角度"] },
    audience: { aliases: ["audience", "目标受众", "受众"] },
    hook: { aliases: ["hook", "内容爆点", "爆点", "钩子"] },
    reason: {
      aliases: ["reason", "推荐理由", "理由"],
      required: false,
      default: (ctx) => `基于角度展开，面向受众。`,
    },
  },
};

const draftContract = {
  name: "drafts",
  count: 5,
  fields: {
    title: { aliases: ["title", "标题"] },
    body: {
      aliases: ["body", "正文", "content"],
      rules: [{ test: /#.+?\[话题\]#/, message: "must contain a Xiaohongshu topic tag", example: "#话题名称[话题]#" }],
    },
    coverDirection: {
      aliases: ["coverDirection", "cover_direction", "封面方向"],
      required: false,
      default: (ctx) => `围绕「${ctx.title}」制作静物封面。`,
    },
  },
};

function makeTopics(n = 10, overrides = {}) {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      title: `选题 ${i + 1}`,
      angle: `角度 ${i + 1}`,
      audience: `受众 ${i + 1}`,
      hook: `爆点 ${i + 1}`,
      reason: `理由 ${i + 1}`,
      ...overrides,
    })),
  };
}

test("合法 10 条通过并注入稳定 id", () => {
  const out = normalizeItems(topicContract, makeTopics());
  assert.equal(out.length, 10);
  assert.equal(out[0].id, "topics-1");
  assert.equal(out[9].id, "topics-10");
});

test("数量不符直接拒绝并报出实际值", () => {
  assert.throws(
    () => normalizeItems(topicContract, makeTopics(9)),
    (error) => error instanceof ContractError && error.code === "LLM_BAD_COUNT" && /实际返回 9 条/.test(error.message),
  );
  assert.throws(() => normalizeItems(topicContract, makeTopics(11)), (e) => e.code === "LLM_BAD_COUNT");
});

test("缺字段拒绝并列出可接受键名", () => {
  const bad = makeTopics();
  delete bad.items[3].angle;
  assert.throws(
    () => normalizeItems(topicContract, bad),
    (error) =>
      error.code === "LLM_BAD_FIELD" &&
      /topics\[3\]\.angle/.test(error.message) &&
      error.details.acceptedKeys.includes("选题角度"),
  );
});

test("中文键名别名可用", () => {
  const cn = {
    items: Array.from({ length: 10 }, (_, i) => ({
      标题: `中文标题 ${i}`,
      选题角度: `中文角度 ${i}`,
      目标受众: `中文受众 ${i}`,
      内容爆点: `中文爆点 ${i}`,
      推荐理由: `中文理由 ${i}`,
    })),
  };
  const out = normalizeItems(topicContract, cn);
  assert.equal(out[0].title, "中文标题 0");
  assert.equal(out[0].audience, "中文受众 0");
});

test("可选字段缺失走 default 兜底", () => {
  const partial = {
    items: Array.from({ length: 10 }, () => ({ title: "t", angle: "a", audience: "u", hook: "h" })),
  };
  const out = normalizeItems(topicContract, partial);
  assert.equal(out[0].reason, "基于角度展开，面向受众。");
});

test("正则规则强制话题标签", () => {
  const bad = { items: Array.from({ length: 5 }, () => ({ title: "t", body: "没有标签的正文" })) };
  assert.throws(
    () => normalizeItems(draftContract, bad),
    (error) => error.code === "LLM_BAD_FORMAT" && /#话题名称\[话题\]#/.test(error.message),
  );

  const good = { items: Array.from({ length: 5 }, () => ({ title: "t", body: "正文 #效率工具[话题]# 结尾" })) };
  const out = normalizeItems(draftContract, good);
  assert.equal(out.length, 5);
  assert.match(out[0].body, /\[话题\]#/);
});

test("forbid 命中即拒", () => {
  const contract = {
    name: "copy",
    count: 1,
    fields: {
      body: { aliases: ["body"], forbid: [/百分百治愈/] },
    },
  };
  assert.throws(
    () => normalizeItems(contract, { items: [{ body: "这个方案百分百治愈" }] }),
    (error) => error.code === "LLM_BAD_FORMAT" && /命中禁用表达/.test(error.message),
  );
});

test("mustInclude 缺一即拒", () => {
  const contract = {
    name: "cover",
    count: 1,
    fields: { prompt: { aliases: ["prompt"], mustInclude: ["明确排除真人、脸、手和动物。"] } },
  };
  assert.throws(
    () => normalizeItems(contract, { items: [{ prompt: "静物摄影，暖光" }] }),
    (error) => error.code === "LLM_BAD_FORMAT" && /必须包含/.test(error.message),
  );
  const ok = normalizeItems(contract, { items: [{ prompt: "静物摄影。明确排除真人、脸、手和动物。" }] });
  assert.equal(ok.length, 1);
});

test("parseLooseJson 吃掉 markdown 围栏与前后噪声", () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('好的，结果如下：{"a":1} 希望有帮助'), { a: 1 });
  assert.throws(() => parseLooseJson("完全不是 JSON"), (e) => e.code === "LLM_BAD_JSON");
  assert.throws(() => parseLooseJson(""), (e) => e.code === "LLM_BAD_JSON");
});

test("顶层直接是数组也能收", () => {
  const out = normalizeItems(topicContract, Array.from({ length: 10 }, () => ({
    title: "t", angle: "a", audience: "u", hook: "h", reason: "r",
  })));
  assert.equal(out.length, 10);
});

test("决策白名单：合法单选", () => {
  const options = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const out = normalizeDecision({ min: 1, max: 1 }, { selectedIds: ["b"], reason: "最佳" }, options);
  assert.deepEqual(out.selectedIds, ["b"]);
  assert.equal(out.reason, "最佳");
});

test("决策：自造 id 被拒并给出可用示例", () => {
  const options = [{ id: "a" }, { id: "b" }];
  assert.throws(
    () => normalizeDecision({ min: 1, max: 1 }, { selectedIds: ["zzz"] }, options),
    (error) => error.code === "LLM_BAD_DECISION" && /不存在的候选 id：zzz/.test(error.message),
  );
});

test("决策：重复 id 被拒", () => {
  const options = [{ id: "a" }, { id: "b" }];
  assert.throws(
    () => normalizeDecision({ min: 1, max: 2 }, { selectedIds: ["a", "a"] }, options),
    (error) => error.code === "LLM_BAD_DECISION" && /重复/.test(error.message),
  );
});

test("决策：多选区间校验", () => {
  const options = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(normalizeDecision({ min: 1, max: 8 }, { selectedIds: ["a", "c"] }, options).selectedIds.length, 2);
  assert.throws(
    () => normalizeDecision({ min: 1, max: 1 }, { selectedIds: ["a", "b"] }, options),
    (error) => error.code === "LLM_BAD_DECISION" && /正好 1 个/.test(error.message),
  );
  assert.throws(
    () => normalizeDecision({ min: 1, max: 8 }, { selectedIds: [] }, options),
    (error) => error.code === "LLM_BAD_DECISION",
  );
});

test("决策兼容单数字段 selectedId", () => {
  const out = normalizeDecision({ min: 1, max: 1 }, { selectedId: "a" }, [{ id: "a" }]);
  assert.deepEqual(out.selectedIds, ["a"]);
});

test("修复 prompt 含三段式：位置 / 实际值 / 可接受形态", () => {
  let captured;
  try {
    normalizeItems(topicContract, makeTopics(9));
  } catch (error) {
    captured = error;
  }
  const repair = buildRepairPrompt(topicContract, captured, '{"items":[]}');
  assert.match(repair, /失败位置/);
  assert.match(repair, /实际观测值/);
  assert.match(repair, /可接受的形态/);
  assert.match(repair, /10 条/);
});
