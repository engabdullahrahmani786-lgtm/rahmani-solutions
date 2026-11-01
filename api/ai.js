// Vercel serverless function: /api/ai
// The AI key stays on the server. Set these in Vercel: Project → Settings → Environment Variables
//   ANTHROPIC_API_KEY  (your provider key)
//   AI_MODEL           (model name from your provider's current list)

const MAX_PROMPT = 4000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map(); // per-instance memory; a basic guard, not a full rate limiter

function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    hits.set(ip, list);
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  return true;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.AI_MODEL;

  if (req.method === "GET") {
    // Status only. The key itself is never returned.
    return res.status(200).json({ configured: Boolean(key && model) });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!key || !model) {
    return res.status(503).json({ error: "The AI assistant is not configured yet." });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (!allowed(ip)) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid request." }); }
  }
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "Write a question first." });
  if (prompt.length > MAX_PROMPT) return res.status(400).json({ error: "Question is too long." });

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: "You are the AI assistant of Rahmani Solutions. Answer any question the visitor asks, on any topic, as clearly and accurately as you can. Reply in the language the visitor writes in (English, Pashto, Dari, or another language). If a question needs current news or live data, say that you may not have the latest information. For medical, legal, or financial decisions, give general information and suggest a qualified professional. Do not invent facts, sources, or customer details.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.error("AI provider unreachable", String(err));
    return res.status(502).json({ error: "The AI could not be reached. Please try again." });
  }

  if (!upstream.ok) {
    // Log the real reason for the administrator (Vercel → Logs). Never send provider details to visitors.
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 300); } catch {}
    console.error("AI provider error", upstream.status, detail);
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(502).json({ error: "The AI service is not set up correctly. Please contact the administrator." });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ error: "The AI is busy right now. Please wait a minute and try again." });
    }
    if (upstream.status === 404 || upstream.status === 400) {
      return res.status(502).json({ error: "The AI service configuration needs checking. Please contact the administrator." });
    }
    return res.status(502).json({ error: "The AI is busy right now. Please try again shortly." });
  }

  const data = await upstream.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) return res.status(502).json({ error: "The AI provider returned an empty answer." });
  return res.status(200).json({ text });
}
