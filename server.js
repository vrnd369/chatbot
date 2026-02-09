import express from "express";
import cors from "cors";
import { FAQ } from "./FAQ.js";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      process.env.RENDER_FRONTEND_URL || "https://chatbot-up4o.onrender.com",
      "https://vrnd.tech",
      "https://chatbot-up4o.onrender.com"
    ]
  })
);

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ✅ Put your WhatsApp number here (no +)
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "YOUR_WHATSAPP_NUMBER";

const SYSTEM_PROMPT = `
You are the customer support assistant for vrnd.tech (VRND BUSINESS SOLUTION).
Be concise, friendly, and accurate.
Use the provided FAQ knowledge when it matches the question.
If unsure, ask a clarifying question.
Never invent pricing, policies, or guarantees.
If the user wants to talk to a human, suggest using the "Talk on WhatsApp" option.
`.trim();

// -------- FAQ matching (simple) --------
function normalize(text = "") {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function buildFaqContext(userText, maxItems = 3) {
  const q = normalize(userText);
  if (!q) return "";

  const words = q.split(" ").filter((w) => w.length >= 3);
  if (words.length === 0) return "";

  const matches = FAQ.map((item) => {
    const qn = normalize(item.q);
    const an = normalize(item.a);
    let score = 0;
    for (const w of words) {
      if (qn.includes(w)) score += 2;
      if (an.includes(w)) score += 1;
    }
    return { item, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((x) => x.item);

  if (matches.length === 0) return "";

  const lines = matches.map((m, i) => `FAQ ${i + 1}\nQ: ${m.q}\nA: ${m.a}`).join("\n\n");
  return `Use this FAQ knowledge if relevant:\n\n${lines}`.trim();
}

async function groqChatCompletion(messages) {
  if (!GROQ_API_KEY) {
    return { ok: false, status: 500, error: "GROQ_API_KEY is not set" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages,
        temperature: 0.4
      })
    });

    const rawText = await resp.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch { }

    return { ok: resp.ok, status: resp.status, data, rawText };
  } catch (err) {
    if (err?.name === "AbortError") return { ok: false, status: 408, error: "Timeout" };
    return { ok: false, status: 500, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/whatsapp-link", (req, res) => {
  // frontend can use this if you want the number stored server-side
  res.json({ number: WHATSAPP_NUMBER });
});

app.get("/wakeup", (req, res) => {
  console.log("Wakeup signal received");
  res.json({ status: "awake" });
});

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const lastUser = [...messages].reverse().find((m) => m?.role === "user")?.content || "";
    const faqContext = buildFaqContext(lastUser);

    const finalMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(faqContext ? [{ role: "system", content: faqContext }] : []),
      ...messages
    ];

    const result = await groqChatCompletion(finalMessages);

    if (!result.ok) {
      if (result.status === 429) {
        return res.status(200).json({
          reply:
            "I’m getting too many requests right now (rate limit). Please try again in a minute, or tap ‘WhatsApp Support’ to talk to a human."
        });
      }
      if (result.status === 401) {
        return res.status(500).json({
          error: "Groq Unauthorized. Check GROQ_API_KEY."
        });
      }
      if (result.status === 408) {
        return res.status(200).json({
          reply:
            "The AI took too long to respond. Please try again, or tap ‘WhatsApp Support’ to talk to a human."
        });
      }

      return res.status(500).json({
        error: "Groq request failed",
        status: result.status,
        details: result.error || result.rawText || "Unknown error"
      });
    }

    const reply = result?.data?.choices?.[0]?.message?.content?.trim();
    return res.json({ reply: reply || "Sorry, I couldn’t generate a reply." });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error", details: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`AI support backend running on port ${PORT}`);
});
