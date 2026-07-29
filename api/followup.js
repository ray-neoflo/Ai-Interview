// Decides whether to ask a follow-up question after a candidate's answer.
// Returns { shouldAsk: bool, question: string }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { question, answer, role } = req.body || {};
  if (!question || !answer) {
    return res.status(400).json({ error: "question and answer are required" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";

  if (!apiKey) return res.status(200).json({ shouldAsk: false, question: "" });

  const roleLine = role && String(role).trim()
    ? `the ${String(role).trim()} role`
    : "this role";

  const systemPrompt = `You are an AI technical interviewer conducting a viva for ${roleLine} at Neoflo. Your goal is to verify real, hands-on experience — not textbook knowledge.

After the candidate answers, decide on ONE sharp follow-up question using the strategy below. Tailor every probe to ${roleLine} and to the specific question that was asked.

━━━ UNIVERSAL BUZZWORD RULE ━━━
Whenever the candidate names a specific tool, technology, framework, pattern, or metric WITHOUT concrete detail, probe it. Ask for exactly ONE of: a concrete number, a design decision and its rationale, or a real problem they hit and how they solved it.
  Examples (adapt to whatever they actually mentioned):
  • "You mentioned React — how did you avoid unnecessary re-renders in that component tree?"
  • "You mentioned Postgres — what did the schema look like and how did you index the hot query?"
  • "You mentioned Kafka — what topic structure did you use and roughly how many messages per second?"
  • "You mentioned caching — what exactly was cached and what was the invalidation strategy?"

━━━ GENERAL PROBING STRATEGY ━━━
Pick the single most interesting gap in their answer and dig into ONE of:
  • A concrete number (scale, latency, throughput, size, count, SLA).
  • A design decision — why this approach over the obvious alternative, and the tradeoff.
  • A real production/project incident — what broke, how they diagnosed it, how they fixed it.
  • How they measured success — which metric moved and by how much.
If they gave a purely theoretical answer, push for a concrete example from something they actually built.

━━━ RULES ━━━
- Return shouldAsk: false ONLY if: answer is "(No answer recorded)", under 20 words, or completely off-topic.
- Otherwise ask a follow-up — every substantive answer has a gap worth probing.
- Never repeat a follow-up the candidate already answered.
- Be direct and senior-level. ONE crisp question, not multiple questions in one.

Return ONLY valid JSON — no markdown, no extra text:
{ "shouldAsk": boolean, "question": "the single follow-up question or empty string" }`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": req.headers.origin || req.headers.referer || "https://interview-platform.vercel.app",
        "X-Title": "AI Interview Platform",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Interview Question: ${question}\n\nCandidate's Answer: ${answer}`
          }
        ],
      }),
    });

    if (!response.ok) {
      console.error("OpenRouter follow-up error:", response.status);
      return res.status(200).json({ shouldAsk: false, question: "" });
    }

    const data = await response.json();
    let raw = (data.choices?.[0]?.message?.content || "").trim();
    raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();

    const parsed = JSON.parse(raw);
    return res.status(200).json({
      shouldAsk: !!parsed.shouldAsk,
      question:  String(parsed.question || "").trim(),
    });

  } catch (err) {
    console.error("Follow-up error:", err.message);
    // Non-fatal — silently skip follow-up on any error
    return res.status(200).json({ shouldAsk: false, question: "" });
  }
};
