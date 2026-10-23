export const xhsTopicContract = {
  name: "topics",
  idPrefix: "topic",
  role: "You are a Xiaohongshu content strategist who writes for a specific creator persona.",
  task: "Generate Xiaohongshu topic candidates that the persona can actually shoot or write this week.",
  count: 10,
  fields: {
    title: { aliases: ["title", "标题", "选题标题"] },
    angle: {
      aliases: ["angle", "选题角度", "角度", "内容角度", "contentAngle"],
    },
    audience: {
      aliases: ["audience", "目标受众", "受众", "适合人群", "targetAudience"],
    },
    hook: {
      aliases: ["hook", "内容爆点", "爆点", "钩子", "开头钩子", "sellingPoint"],
    },
    reason: {
      aliases: ["reason", "推荐理由", "理由", "rationale", "why"],
      required: false,
      default: (ctx, index) => `基于第 ${index + 1} 个切入点展开，面向目标受众，靠开头钩子留住人。`,
    },
  },
};

export const xhsDraftContract = {
  name: "drafts",
  idPrefix: "draft",
  role: "You are a Xiaohongshu copywriter. You write concrete, useful posts, never vague hype.",
  task: "Generate Xiaohongshu copy drafts for the selected topic.",
  count: 5,
  fields: {
    title: { aliases: ["title", "标题", "文案标题", "copyTitle"] },
    body: {
      aliases: ["body", "正文", "文案正文", "content", "copy"],
      rules: [
        {
          test: /#.+?\[话题\]#/,
          message: "must contain at least one Xiaohongshu topic tag",
          example: "#效率工具[话题]#",
        },
      ],
      maxLength: 1200,
    },
    coverDirection: {
      aliases: ["coverDirection", "cover_direction", "封面方向", "封面方向建议"],
      required: false,
      default: (ctx) => `围绕「${ctx.title}」制作信息清晰的静物封面，突出核心方法。`,
    },
  },
};

export const xhsCoverPromptContract = {
  name: "coverPrompts",
  idPrefix: "prompt",
  role: "You are an art director writing image-generation prompts for Xiaohongshu covers.",
  task: "Generate cover image prompts that stay in static-life product photography and avoid AI-detectable human elements.",
  count: 5,
  fields: {
    title: { aliases: ["title", "标题", "封面标题"] },
    prompt: {
      aliases: ["prompt", "coverPrompt", "cover_prompt", "imagePrompt", "封面Prompt", "提示词"],
      mustInclude: ["明确排除真人、脸、手和动物。"],
      maxLength: 1200,
    },
  },
};

export const xhsTopicDecision = {
  kind: "topic",
  role: "You pick the single most shootable Xiaohongshu topic for this creator.",
  task: "choose the best topic candidate for the next copywriting step",
  min: 1,
  max: 1,
};

export const xhsDraftDecision = {
  kind: "draft",
  role: "You pick the draft that is most ready to publish.",
  task: "choose the best copy draft for Xiaohongshu publishing readiness",
  min: 1,
  max: 1,
};

export const xhsReferenceDecision = {
  kind: "rag",
  role: "You pick reference notes worth studying, not everything that showed up.",
  task: "choose Xiaohongshu hot-content references worth studying",
  min: 1,
  max: 8,
};

export const XHS_CONTRACTS = {
  topics: xhsTopicContract,
  drafts: xhsDraftContract,
  coverPrompts: xhsCoverPromptContract,
};
