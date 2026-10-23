#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { runXhsSearch } from "../src/sources/xhs.mjs";
import { generateWithContract, decideWithContract } from "../src/engine.mjs";
import { runTextCli } from "../src/adapters/index.mjs";
import { runCloudText } from "../src/providers/openai.mjs";
import { sanitizeDetails } from "../src/redact.mjs";
import {
  xhsTopicContract,
  xhsDraftContract,
  xhsTopicDecision,
  xhsDraftDecision,
  xhsReferenceDecision,
} from "../src/contracts/xhs.mjs";
import { toHttpBody } from "../src/errors.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function mockProvider() {
  let call = 0;
  return {
    id: "mock",
    text: async ({ prompt }) => {
      call += 1;
      if (prompt.includes("topic candidates")) {
        return {
          raw: JSON.stringify({
            items: Array.from({ length: 10 }, (_, i) => ({
              title: `Mock 选题 ${i + 1}：${i % 2 === 0 ? "为什么你拍不出好照片" : "手机也能拍的三个角度"}`,
              angle: `切入角度 ${i + 1}`,
              audience: "想提升拍摄质感的普通人",
              hook: `大部分人第 ${i + 1} 步就错了`,
            })),
          }),
          durationMs: 1,
          commandPreview: "mock",
        };
      }
      if (prompt.includes("copy drafts")) {
        return {
          raw: JSON.stringify({
            items: Array.from({ length: 5 }, (_, i) => ({
              title: `Mock 文案 ${i + 1}`,
              body: `第一段讲现象。第二段给方法。第三段收束。\n\n#摄影技巧[话题]# #手机摄影[话题]#`,
              coverDirection: "白墙前的相机与笔记本，自然侧光",
            })),
          }),
          durationMs: 1,
          commandPreview: "mock",
        };
      }
      return {
        raw: JSON.stringify({ selectedIds: ["topic-1"], reason: "mock 决策" }),
        durationMs: 1,
        commandPreview: "mock",
      };
    },
  };
}

function makeProvider(args) {
  const mode = args.provider ?? "mock";

  if (mode === "mock") return { provider: mockProvider(), label: "mock" };

  if (mode === "cloud") {
    const apiKey = args["api-key"] ?? process.env.OPENAI_API_KEY;
    const baseUrl = args["base-url"] ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = args.model ?? "gpt-4o-mini";
    if (!apiKey) throw new Error("cloud 模式需要 --api-key 或 OPENAI_API_KEY。");
    return {
      label: `cloud:${model}`,
      provider: {
        text: async ({ prompt }) => runCloudText({ prompt, apiKey, baseUrl, model }),
      },
    };
  }

  const cliId = args.cli ?? "codex";
  const model = args.model;
  return {
    label: `cli:${cliId}${model ? `:${model}` : ""}`,
    provider: {
      text: async ({ prompt }) =>
        runTextCli({ prompt, model, cliId, cliCommand: args["cli-command"] }),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`用法：
  node bin/xhs-pipeline.mjs --keyword "AI 摄影" --persona "摄影师，讲普通人能用的方法"

参数：
  --keyword      必填，搜索与创作关键词
  --persona      必填，创作者人设
  --brief        撰写思路
  --provider     mock | cli | cloud（默认 mock）
  --cli          codex | kimi | claude | custom（provider=cli 时）
  --cli-command  custom CLI 的可执行路径
  --model        模型名
  --api-key      云端 API Key（或用 OPENAI_API_KEY）
  --base-url     云端 Base URL
  --max-refs     参考内容最多几条（默认 6）
  --skip-search  跳过 xhs 搜索，只靠人设和关键词生成
  --out          结果写入文件（默认打印到 stdout）
  --full         跑完整链路：选题 → 决策 → 文案 → 决策`);
    return;
  }

  const keyword = args.keyword;
  const persona = args.persona ?? args.persona;
  if (!keyword || !persona) {
    throw new Error("--keyword 和 --persona 都必填。用 --help 看用法。");
  }

  const { provider, label } = makeProvider(args);

  let references = [];
  if (args["refs-file"]) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(args["refs-file"], "utf8");
    references = text
      .split(/\n{2,}/)
      .map((block, index) => ({
        id: `ref-${index + 1}`,
        title: block.split("\n")[0].slice(0, 80),
        excerpt: block.replace(/\s+/g, " ").trim().slice(0, 220),
        metrics: "手动提供",
      }))
      .filter((item) => item.excerpt);
    process.stderr.write(`[1/4] 从 ${args["refs-file"]} 读取 ${references.length} 条参考（跳过抓取）\n`);
  } else if (!args["skip-search"]) {
    process.stderr.write(`[1/4] 抓取小红书热门：${keyword}\n`);
    try {
      const search = await runXhsSearch({ keyword, sort: "popular", type: "all" });
      references = search.items.slice(0, Number(args["max-refs"] ?? 6));
      process.stderr.write(`      拿到 ${search.items.length} 条，取 ${references.length} 条作参考\n`);
    } catch (error) {
      process.stderr.write(`      搜索不可用（${error.code}），降级为纯人设生成：${error.message}\n`);
    }
  }

  const context = {
    persona,
    keyword,
    writingBrief: args.brief ?? "",
    references: references.map((item) => `${item.title}｜${item.metrics}｜${item.excerpt}`).join("\n---\n"),
  };

  process.stderr.write(`[2/4] 生成 10 个选题（provider=${label}）\n`);
  const topics = await generateWithContract({
    contract: xhsTopicContract,
    context,
    provider,
    maxRepairs: 2,
  });
  process.stderr.write(`      通过校验，重试 ${topics.attempts - 1} 次\n`);

  let topicId = topics.items[0].id;
  if (args.full) {
    process.stderr.write(`[3/4] 决策：选题\n`);
    const decision = await decideWithContract({
      decision: xhsTopicDecision,
      options: topics.items,
      context,
      provider,
      maxRepairs: 1,
    });
    topicId = decision.selectedIds[0];
    process.stderr.write(`      选中 ${topicId}：${decision.reason}\n`);
  }

  const selectedTopic = topics.items.find((item) => item.id === topicId);

  let drafts = [];
  if (args.full) {
    process.stderr.write(`[4/4] 生成 5 篇文案\n`);
    const result = await generateWithContract({
      contract: xhsDraftContract,
      context: { ...context, topicTitle: selectedTopic.title, topicAngle: selectedTopic.angle },
      provider,
      maxRepairs: 2,
    });
    drafts = result.items;
  }

  const output = {
    keyword,
    persona,
    provider: label,
    references,
    topics: topics.items,
    selectedTopic,
    drafts,
    generatedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(output, null, 2);
  if (args.out) {
    await writeFile(args.out, json, "utf8");
    process.stderr.write(`已写入 ${args.out}\n`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  const { status, body } = toHttpBody(error);
  process.stderr.write(`\n失败 [${body.code}] HTTP ${status}\n${body.error}\n`);
  if (body.details) process.stderr.write(`详情：${sanitizeDetails(JSON.stringify(body.details), undefined, 400)}\n`);
  process.exit(1);
});
