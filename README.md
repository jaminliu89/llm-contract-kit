# llm-contract-kit

一份契约同时生成 prompt 和硬校验。LLM 输出不合规时自动带修复指令重试。

现有 LLM 接法的通病是 prompt 里写一遍格式要求、代码里再手写一遍校验，两边迟早对不上。这里把「要求」收成一份声明式契约，prompt 和校验都从它推导。

## 三个能力

一、契约驱动校验

```js
import { normalizeItems, buildItemPrompt } from "llm-contract-kit";

const topicContract = {
  name: "topics",
  count: 10,
  fields: {
    title: { aliases: ["title", "标题"] },
    body: {
      aliases: ["body", "正文"],
      rules: [{ test: /#.+?\[话题\]#/, message: "must contain a topic tag", example: "#效率工具[话题]#" }],
    },
    coverDirection: { aliases: ["coverDirection", "封面方向"], required: false, default: (ctx) => `...` },
  },
};

buildItemPrompt(topicContract, { persona, keyword }); // 生成含 exact keys 与精确数量的 prompt
normalizeItems(topicContract, parsed);                // 数量/字段/别名/正则/禁用词全查
```

契约支持的约束：
`count` 精确或区间、`aliases` 中英双语键名、`required` 与 `default` 兜底、`rules` 正则、`mustInclude` 必含短语、`mustIncludeAny` 命中任一、`forbid` 禁用表达、`maxLength` 裁剪。

二、自动修复循环

```js
import { generateWithContract } from "llm-contract-kit";

const result = await generateWithContract({
  contract: topicContract,
  context: { persona, keyword },
  provider,      // { text: async ({prompt}) => ({raw, durationMs}) }
  maxRepairs: 2, // 不合规就把"失败位置 + 实际值 + 可接受形态"回灌重试
});
// result.items / result.attempts / result.trace
```

回灌的是三段式反馈，不是笼统的「再改改」。配置类错误（缺 key、CLI 不存在）不重试，直接透传。

三、双 provider 路线

本地 CLI：`codex`（exec + --output-last-message）、`kimi`（--prompt --output-format stream-json）、`claude`（--print --output-format json --safe-mode）、以及符合 print protocol 的任意 `custom` CLI。
云端：任意 OpenAI-compatible `/chat/completions`，Kimi 官方接口（api.moonshot.cn / api.moonshot.ai / api.kimi.com/coding）自动切到 `max_completion_tokens` 且不传 `temperature`。

## 快速开始

```bash
npm test                                    # 43 个用例，含真实 HTTP 往返
node bin/xhs-pipeline.mjs --help

# 先验证管线（不需要任何 key、CLI、网络）
node bin/xhs-pipeline.mjs --keyword "手机摄影" --persona "摄影博主" --provider mock --skip-search --full --out /tmp/out.json

# 接真模型
node bin/xhs-pipeline.mjs --keyword "手机摄影" --persona "..." --provider cloud \
  --base-url https://api.deepseek.com --model deepseek-chat --api-key "$KEY" --full
```

`bin/xhs-pipeline.mjs` 是一条完整选题流水线：小红书热门抓取（可选降级）→ 10 选题 → 模型决策 → 5 文案 → 决策。抓取失败不中断，降级为纯人设生成。

抓取链路不稳定时，直接给参考内容，绕开 xhs 整条链路：

```bash
# refs.txt 用空行分隔每一条，第一行当标题
node bin/xhs-pipeline.mjs --keyword "手机摄影" --persona "..." --provider cloud ... --refs-file refs.txt
```

## xhs 抓取的真实状态

`xhs` CLI 走 camoufox（headless Firefox 反检测）+ 读 `window.__INITIAL_STATE__`，不碰签名算法。这条链路有三个已知断点，代码里各自映射成独立错误码：

`XHS_CLI_MISSING` 未安装 → `pipx install xhs-cli`
`XHS_CLI_BROKEN` camoufox 的 UBO addon 没解压 → `camoufox fetch`
`XHS_FEEDS_MISSING` 浏览器起来了但搜索页不吐数据 → 登录态过期 / 命中风控 / 小红书改了前端结构。`xhs status` 显示已登录也不代表 cookie 还有效。

本机实测：camoufox 装好后仍然卡在 `XHS_FEEDS_MISSING`。这条链路能跑，但不要把它当稳定依赖——`--refs-file` 是更可靠的入口。

## 接进 Vite

```js
import { vitePluginContractApi } from "llm-contract-kit/server";

export default defineConfig({
  plugins: [
    react(),
    vitePluginContractApi({
      routes: {
        "/topics/generate": async (payload) => generateWithContract({ ... }),
      },
    }),
  ],
});
```

路由默认做三件事：只接受 loopback Host（挡 DNS rebinding）、校验 Origin、128KB body 上限。需要更强保护时传 `requireToken`。

## 契约怎么写

```js
{
  name: "drafts",
  idPrefix: "draft",        // 归一化后自动注入 draft-1..N
  role: "You are ...",      // 拼进 prompt 的角色行
  task: "Generate ...",     // 拼进 prompt 的任务行
  count: 5,
  fields: { ... },
  transform: (item, index) => item,   // 可选，归一化后自定义加工
}
```

决策契约：

```js
{ kind: "rag", min: 1, max: 8, role: "...", task: "..." }
```

决策校验会强制：id 必须来自候选项、不许重复、数量落在 [min, max]。自造 id 直接拒，并回灌可用 id 列表。

## 已知边界

校验只管**结构、数量、格式、引用完整性**，不管内容好坏。「这条选题是否可行」需要另起评审角色，见 llm-output-stability 的软校验一节。

`autoRepair` 会额外消耗模型调用。默认 2 次，高风险场景建议先跑黄金样例集确认修复率，再决定是否放开。

本地 CLI 的 stdout 契约必须严格：kimi / custom 走 stream-json 逐行，claude 走 `--output-format json` 的 result 字段，codex 走 `--output-last-message` 文件。少一样就是 CLI_BAD_OUTPUT，不会静默猜。

## 来源

契约结构和校验规则抽取自 xiaohongshu-assistant（薄荷工坊）的 server/codex 实现；在此之上补了三处原项目没有的东西：契约单一来源、失败自动修复循环、本地 HTTP 端的 rebinding/Origin 防护。
