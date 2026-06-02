// ============================================================
// 后端"中间人"（Vercel Serverless Function）
// 作用：替前端保管 API 钥匙、替前端去敲 Claude 的门，再把结果传回。
// 钥匙从环境变量 ANTHROPIC_API_KEY 读取——绝不写在代码里、也不会进前端。
// 放在 /api 文件夹里，Vercel 会自动把它变成接口：你的网址/api/generate
//
// 支持两种任务（前端用 task 字段指定）：
//   task: "mode"  → 只判断这句话是"对抗 / 温情 / 严肃"
//   task: "card"  → 生成整张图鉴卡（默认）
// ============================================================

// 调一次 Claude 的小工具
async function callClaude({ system, user, maxTokens, temperature }) {
  const payload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens || 1200,
    system: system || "",
    messages: [{ role: "user", content: user }]
  };
  // Claude 的 temperature 取值是 0~1；只在显式传了才带上（不传就用默认）
  if (typeof temperature === "number") payload.temperature = temperature;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY, // ← 钥匙从环境变量读
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload)
  });

  // 调失败时别静默吞掉——把错误打到 Vercel 日志，方便排查
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("Anthropic error:", r.status, detail);
    return "";
  }

  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

const MODE_SYSTEM =
  "判断这句'中国父母/长辈发来的话'属于哪类，只回答两个字：\n" +
  "- 严肃：涉及死亡、亲友去世、重病、生病住院、意外、灾祸、失业、离婚、严重坏消息、或明显的悲伤/沉重情绪。这类绝不能开玩笑。\n" +
  "- 温情：夸奖、心疼、想你、示弱、道歉、单纯表达爱或关心。\n" +
  "- 对抗：唠叨、催促、挑剔、讲道理、夺命关心、抱怨。\n" +
  "优先级：只要沾到第一类（严肃/悲伤/坏消息），就回答'严肃'。否则在'温情'和'对抗'里选。只回答两个字：严肃 或 温情 或 对抗。";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Vercel 一般会自动把 JSON body 解析好；万一拿到的是字符串，这里兜底再解一次
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    // 给输入加个长度上限，挡住超长 prompt 刷爆 token 账单
    const clip = (s) => (typeof s === "string" ? s.slice(0, 4000) : s);
    const { task, system } = body;
    const user = clip(body.user);
    const text = clip(body.text);

    // 任务一：判断模式（要稳定，用 temperature 0）
    if (task === "mode") {
      if (!text) return res.status(400).json({ error: "missing text" });
      const out = await callClaude({ system: MODE_SYSTEM, user: text, maxTokens: 10, temperature: 0 });
      let mode = "对抗";
      if (out.includes("严肃")) mode = "严肃";
      else if (out.includes("温情")) mode = "温情";
      return res.status(200).json({ mode });
    }

    // 任务二（默认）：生成卡片
    if (!user) return res.status(400).json({ error: "missing user prompt" });
    const cardText = await callClaude({ system, user, maxTokens: 1200 });
    if (!cardText) {
      return res.status(502).json({ error: "empty response from model" });
    }
    return res.status(200).json({ text: cardText });
  } catch (e) {
    return res.status(500).json({ error: "generate failed", detail: String(e) });
  }
}
