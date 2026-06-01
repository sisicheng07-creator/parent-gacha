// ============================================================
// 后端"中间人"（Vercel Serverless Function）
// 作用：替前端保管 API 钥匙、替前端去敲 Claude 的门，再把结果传回。
// 钥匙从环境变量 ANTHROPIC_API_KEY 读取——绝不写在代码里、也不会进前端。
// 放在 /api 文件夹里，Vercel 会自动把它变成接口：你的网址/api/generate
//
// 支持两种任务（前端用 task 字段指定）：
//   task: "mode"  → 只判断这句话是"对抗"还是"温情"
//   task: "card"  → 生成整张图鉴卡（默认）
// ============================================================

// 调一次 Claude 的小工具
async function callClaude({ system, user, maxTokens }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY, // ← 钥匙从环境变量读
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens || 1200,
      system: system || "",
      messages: [{ role: "user", content: user }]
    })
  });
  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

const MODE_SYSTEM =
  "判断这句'中国父母/长辈发来的话'属于哪类。对抗类=唠叨、催促、挑剔、讲道理、夺命关心、抱怨。温情类=夸奖、心疼、想你、示弱、道歉、单纯表达爱或关心。只回答两个字：对抗 或 温情。";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { task, system, user, text } = req.body || {};

    // 任务一：判断模式
    if (task === "mode") {
      if (!text) return res.status(400).json({ error: "missing text" });
      const out = await callClaude({ system: MODE_SYSTEM, user: text, maxTokens: 10 });
      const mode = out.includes("温情") ? "温情" : "对抗";
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
