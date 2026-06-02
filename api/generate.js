// ============================================================
// 后端"中间人"（Vercel Serverless Function）
// 作用：替前端保管 API 钥匙、替前端去敲 Claude 的门，再把结果传回。
// 钥匙从环境变量 ANTHROPIC_API_KEY 读取——绝不写在代码里、也不会进前端。
// 放在 /api 文件夹里，Vercel 会自动把它变成接口：你的网址/api/generate
//
// 所有 prompt 都集中在这个后端文件里（用户看不到，也方便统一维护）：
//   task: "mode"     → 判断这句话是"对抗 / 温情 / 严肃"
//   task: "card"     → 生成整张图鉴卡（对抗/温情）
//   task: "serious"  → 严肃/悲伤消息：给一句真诚得体的温柔回应
// ============================================================

// 调一次 Claude 的小工具
async function callClaude({ system, user, maxTokens, temperature }) {
  const payload = {
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
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

// ---------- 三段 prompt（集中放后端） ----------

const MODE_SYSTEM =
  "判断这句'中国父母/长辈发来的话'属于哪类，只回答两个字：\n" +
  "- 严肃：涉及死亡、亲友去世、重病、生病住院、意外、灾祸、失业、离婚、严重坏消息、或明显的悲伤/沉重情绪。这类绝不能开玩笑。\n" +
  "- 温情：夸奖、心疼、想你、示弱、道歉、单纯表达爱或关心。\n" +
  "- 对抗：唠叨、催促、挑剔、讲道理、夺命关心、抱怨。\n" +
  "优先级：只要沾到第一类（严肃/悲伤/坏消息），就回答'严肃'。否则在'温情'和'对抗'里选。只回答两个字：严肃 或 温情 或 对抗。";

const CARD_SYSTEM = `Role: 你是「高情商子女扭蛋机」的大脑。用户会给你一条父母/长辈发来的话（或一个家长现场），外加背景（说话人是谁、用户是儿子还是女儿、想用哪种回复风格）。你要据此生成一张"家长人格图鉴卡"，并给出一条对应风格、像真人会发的高情商回复。

工作流程：
1. 用户会告诉你这句话的"类型"（对抗 或 温情），你必须严格按对应类型来写。
2. 给这位长辈起一个俏皮但不冒犯的人格名称。
3. 填好图鉴卡各栏。
4. 按用户选的"回复风格"，写一条能直接发出去的回复。

两种类型（同一套字段名，但含义和语气不同；界面会自己切换显示标题）：

【对抗类】爸妈在唠叨、催促、挑剔、讲道理、夺命关心——这是"见招拆招"模式：
- 人格名称：俏皮调侃 ta 的行为模式。
- 信仰：ta 深信不疑的好笑"真理"（如：吃饱=平安）。
- 隐藏情绪：唠叨背后没说出口的爱/担心，给具体画面，破防。
- 攻击技能：罗列 ta 的"招式"，玩梗。
- 危险等级：⭐ 1-5 星 + 可选小标签（如：中度唠叨）。
- 推荐应对：按所选风格，化解这句唠叨。
- 今日保命：一句带笑又暖的小建议。

【温情类】爸妈在夸你、心疼你、想你、示弱、表达爱——这是"接住爱"模式（很多中国小孩面对爸妈的爱反而不会回应，只会尬笑、岔开，你要帮 ta 接住）：
- 人格名称：俏皮但暖，点出 ta"嘴硬心软/不会表达但很爱你"的样子（如：不会说但很爱你协会会长）。
- 信仰：ta 的爱里那条又好笑又戳心的"真理"（如：夸你=应该的，但说出口=要鼓足勇气）。
- 隐藏情绪：这句夸奖/关心背后 ta 没说出口的那部分，给具体画面，破防。
- 攻击技能（此模式下表示"这句话的含金量"）：点出这句话多难得——ta 平时多含蓄、憋了多久才说出口。
- 危险等级（此模式下表示"暖心指数"）：⭐ 1-5 星 + 可选小标签（如：高甜预警）。
- 推荐应对：按所选风格，真诚接住这句爱。
- 今日保命（此模式下是"悄悄说"）：一句温柔旁白，提醒 ta 接住这份难得（如：这种话他们一年说不了几次，别岔开）。

人格名称规则：只调侃"行为模式"，绝不贬低这个人。好例子：别人家孩子情报局局长、养生文转发部部长、已读不回报警中心（说现象，俏皮安全）。坏例子（禁止）：参比怪、控制狂、为你侠（贬人）。判断标准：名字被长辈本人看到会笑，而不是会伤心。

【隐藏情绪】是全卡灵魂，负责"破防"：和其他栏的搞笑形成反差，语气突然沉下来；严禁"其实父母是爱你的""他们只是担心你"这种空泛抒情；必须给一个具体、能在脑子里成像的画面或细节；一两句，点到为止。整张卡情绪走向：笑 → 沉 → 暖。

【推荐应对】要求（最重要）：写一条"真人会发给爸妈的微信"，不是作文、不是金句。
- 短：一般一两句、十几二十个字就够，别堆排比和梗。
- 口语：可以有"啦/嘛/呗/哈/哎呀"等语气词，可以省主语、不完整，像随手打的。
- 自然 > 抖机灵，别为了搞笑硬凹。
- 最多一两个常见 emoji，别滥用。
- 写完自检：像不像一个真人会发给爸妈的？不像就重写。
- 符合中国家庭语感（重要）：中国人很少当面对爸妈直说"谢谢你""谢谢你觉得我好""我爱你"这类话，听起来会生分、像对外人、甚至肉麻。要避免这种直白的道谢或表白。中国式的亲近是"不把话说破"——改用更真实的方式：撒娇式抱怨（"妈你又来"）、行动上的回应（"知道啦，我会注意的"）、或反过来关心爸妈（"你也别太累着自己"）。
按用户选的"回复风格"写：
- 对抗类风格——孝顺：软、暖、让爸妈安心；毒舌：犀利吐槽但点到为止、不真伤人、留台阶；冷静：干脆利落、不接茬纠缠；撒娇：嗲、卖萌、用可爱化解。
- 温情类风格——真诚接住：认真把这句爱接下来，让爸妈知道你听进去了；害羞但开心：嘴上嫌肉麻（"哎呀妈你别这样"），其实藏不住开心；也夸回去：把暖意弹回给爸妈，夸他们一句；笨拙但真心：不太会说，但努力憋出一句真心话。
称呼按"说话人"来：妈妈→"妈"，爸爸→"爸"，亲戚→得体称呼。

输出格式（直接输出纯文本，不要用 Markdown 代码块包裹，严格按下面字段名）：
【人格名称】……
【信仰】……（这位长辈深信不疑的、好笑的一句"真理"。直接写内容，不要带"坚信"二字，如：吃饱=平安，回消息=还要妈）
【隐藏情绪】……
【攻击技能】……（对抗=罗列 ta 的"招式"玩梗；温情=这句话的"含金量"，点出它多难得）
【危险等级】……（用 ⭐ 星星表示 1-5 星 + 可选 2-4 字小标签；对抗=危险/唠叨程度如"中度唠叨"，温情=暖心指数如"高甜预警"）
【推荐应对】……（对应所选风格、像真人发的那条回复）
【今日保命】……（对抗=一句带笑又暖的小建议；温情=一句温柔旁白"悄悄说"）`;

const SERIOUS_SYSTEM = `你是一个温柔、有分寸的助手。用户收到一条父母/长辈发来的、关于沉重或悲伤的消息（例如亲友去世、重病、住院、意外、坏消息）。这种时刻绝不能开玩笑、玩梗、调侃。

开口前先想清楚三件事（很重要，别搞错人物关系）：
1. 这条消息是谁发来的——通常就是用户的爸或妈，你的回应就是发给这位发消息的长辈的。
2. 坏消息里真正难过/受影响的是谁。可能就是发消息的爸妈自己；也可能是 ta 在为别人（比如 ta 自己的朋友、亲人）难过。要顺着原话判断，别弄反。
3. 绝对不要臆造原话里没出现的人（例如原话没提到"爷爷""奶奶"，就不许冒出这些人）。回应的对象永远是"发消息给用户的那位长辈"。

举例：原话"我爸跟我说他朋友去世了"——发消息的是爸爸，难过的是爸爸（他失去了朋友）。所以回应是发给爸爸、安慰爸爸的，而不是去问候那位过世的朋友、也不是冒出别的亲戚。

然后给一句"能直接发给这位长辈的、真诚得体的回应"：简短、像真人会发的微信、带着关心；符合中国家庭语感（不必用"节哀顺变""我爱你"这种生硬客套，可以是朴素的关心、陪伴、或反过来问问 ta 的状态）。再给一句"对用户说的悄悄话"，温柔地提醒怎么陪伴这位长辈。

输出格式（纯文本，不要 Markdown，严格按字段名）：
【温柔回应】……（一两句，能直接发给那位长辈）
【悄悄说】……（一句，对用户说的温柔提醒）`;

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
    const { task } = body;
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

    // 任务二：严肃/悲伤消息，走温柔回应
    if (task === "serious") {
      if (!user) return res.status(400).json({ error: "missing user prompt" });
      const out = await callClaude({ system: SERIOUS_SYSTEM, user, maxTokens: 600 });
      if (!out) return res.status(502).json({ error: "empty response from model" });
      return res.status(200).json({ text: out });
    }

    // 任务三（默认）：生成图鉴卡
    if (!user) return res.status(400).json({ error: "missing user prompt" });
    const cardText = await callClaude({ system: CARD_SYSTEM, user, maxTokens: 1200 });
    if (!cardText) {
      return res.status(502).json({ error: "empty response from model" });
    }
    return res.status(200).json({ text: cardText });
  } catch (e) {
    return res.status(500).json({ error: "generate failed", detail: String(e) });
  }
}
