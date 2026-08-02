// api/chat.js
//
// Serverless proxy for the floating "Cash Flow Assistant" chat widget in
// cash_flow_generator_1.html — Vercel version.
//
// WHY VERCEL INSTEAD OF NETLIFY: this function used to live at
// netlify/functions/chat.js. It was migrated here because the Netlify
// team's account got stuck showing "running on operational credits —
// production deploys and Agent Runners are paused" (a known Netlify
// billing-flag bug affecting multiple accounts). Netlify only applies a
// newly-set environment variable (GEMINI_API_KEY) on the *next successful
// deploy* — so with deploys blocked, the key could never actually reach
// the running function. Vercel's free tier has no equivalent blocker, so
// moving here sidesteps the issue entirely. Functionally this file is
// identical to the Netlify version; only the request/response shape
// (Vercel's `(req, res)` instead of Netlify's `exports.handler(event)`)
// changed.
//
// WHY THIS FILE EXISTS AT ALL: the generator itself is a static HTML file
// with no backend. A real LLM chat needs an API key, and an API key must
// never be shipped to the browser. This function runs server-side, reads
// the key from an environment variable, and is the only thing that ever
// talks to the LLM provider. The browser only ever talks to this function.
//
// DEFAULT PROVIDER: Google Gemini (via Google AI Studio) — genuinely free,
// ongoing tier, no credit card required.
//
// SETUP (one-time):
//   1. Get a free API key at https://aistudio.google.com/apikey (any
//      Google account, no credit card).
//   2. Deploy this whole project folder to Vercel:
//        - Easiest: `npm i -g vercel` (once), then from this folder run
//          `vercel` (first time) and `vercel --prod` to go live. Or:
//        - Connect the GitHub repo at vercel.com/new and let Vercel
//          auto-deploy on every push (no CLI needed).
//      Vercel auto-detects any file under /api as a serverless function
//      and exposes api/chat.js at /api/chat — no config needed for that
//      part. vercel.json (alongside this file) just makes the bare domain
//      load cash_flow_generator_1.html directly.
//   3. In the Vercel dashboard: Project → Settings → Environment Variables
//      → add GEMINI_API_KEY, applied to Production (and Preview/Development
//      if you want those to work too) → Save.
//   4. Redeploy once (Deployments → ⋯ → Redeploy) so the function picks up
//      the key — same "env vars need a fresh deploy" rule as Netlify, but
//      Vercel deploys aren't blocked, so this is a 30-second, one-time step.
//
// FREE TIER LIMITS (subject to change by Google — check
// https://ai.google.dev/gemini-api/docs/rate-limits for current numbers):
// roughly a few hundred to ~1,000 requests/day depending on the model,
// reset daily. If you hit the daily cap, the chatbot will show an error
// until it resets — see the catch block below for the friendlier message.
// Vercel's own free tier (Hobby plan) separately allows 100GB-hours of
// serverless function execution and 100k invocations/month, which a chat
// widget like this won't come close to.
//
// SWITCHING PROVIDER: to use Anthropic Claude or OpenAI instead, see the
// commented alternatives at the bottom of callLLM().

const SYSTEM_PROMPT = `You are the "Cash Flow Assistant" embedded in an Ind AS 7 (Statement of Cash Flows) preparation tool. It is used both by practising accountants and by students learning Ind AS 7 for the first time — assume the person asking may be a naive student unless the context/history suggests otherwise, and default to plain, step-by-step language, defining technical terms the first time you use them.

Your job:
- Explain Ind AS 7 concepts (objective, cash equivalents, direct vs indirect method, classification of interest/dividends/tax, business combinations under Ind AS 103 read with Ind AS 7 paras 39-42B, non-cash transactions under para 43, components of cash under para 45) clearly and correctly, in the simplest language that is still accurate.
- Explain how this specific tool builds a statement: it uses the indirect method starting from Profit Before Tax, adds back non-cash adjustments, applies working-capital movements from the Balance Sheet, deducts income tax paid, and separately computes Investing and Financing activities from Additional Inputs, any student-added Custom Items, and (in consolidated mode) a Group Events log.
- CALCULATE, don't just describe: when given a "Context" block with the user's actual computed figures (subtotals, working-capital breakdown, investing/financing line items), do the arithmetic yourself and show your work when it helps understanding — e.g. if asked "why is my net operating cash flow negative", walk through PBT + adjustments + working capital - tax paid using their real numbers, not generic placeholders.
- CLASSIFY new/custom items: when a user describes a line item they want to add (an unusual receipt, payment, or adjustment not in the standard list), tell them plainly which bucket it belongs in — Operating (non-cash adjustment to PBT), Operating (working-capital movement), Investing, or Financing — the sign convention to use, and a one-line reason tied to the relevant Ind AS 7 paragraph. If genuinely ambiguous, say so and explain the factors that would tip it one way or the other, rather than guessing silently.
- COMMENT ON FLAGGED ANOMALIES: the Context block may list currently flagged "unusual balances" or "significant variations" (e.g. a negative balance where one is not expected, or a large year-on-year swing). If the user asks about these, explain in plain terms why the figure looks unusual and what to check, rather than just repeating the flag text.
- Be concise (aim for 3-8 sentences unless the question needs a structured list or a calculation walkthrough) and use plain language a student can follow, not dense textbook prose.
- If asked something outside Ind AS 7 / cash flow statements / this tool's mechanics, answer briefly if you can, but note it's outside this tool's core purpose.
- Always make clear this is general educational guidance, not a substitute for professional judgement or a signed audit opinion.
- Never fabricate a specific paragraph number you are not confident about — describe the requirement in plain terms instead if unsure of the exact para reference.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Vercel's Node.js runtime auto-parses a JSON request body into req.body.
  // Guard anyway in case it arrives as a raw string (e.g. some proxies/tools).
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload || '{}'); } catch (e) { payload = {}; }
  }
  payload = payload || {};

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const context = typeof payload.context === 'string' ? payload.context : '';

  if (!messages.length) {
    res.status(400).json({ error: 'No messages provided' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey, set it in Vercel → Project → Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  try {
    const reply = await callLLM({ apiKey, messages, context });
    res.status(200).json({ reply });
  } catch (err) {
    console.error('chat function error:', err);
    const quotaLikely = /429|quota|rate/i.test(String(err && err.message));
    res.status(502).json({
      error: quotaLikely
        ? "Gemini's free daily quota may be exhausted for this project — it resets daily. Try again later, or upgrade to a paid Gemini tier if this happens often."
        : 'Upstream LLM request failed.',
    });
  }
};

async function callLLM({ apiKey, messages, context }) {
  // ---- Google Gemini generateContent API (default, free tier) -------------
  // Gemini uses roles "user" and "model" (not "assistant"), and takes the
  // system prompt as a separate systemInstruction field rather than a
  // leading message.
  const geminiContents = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const systemPrompt = context
    ? `${SYSTEM_PROMPT}\n\nContext — the user's current statement figures and any live anomaly flags (may be absent if they haven't generated a statement yet):\n${context}`
    : SYSTEM_PROMPT;

  // gemini-2.5-flash: good quality/quota balance for a guidance chatbot.
  // If you hit the daily free-tier cap often, try "gemini-2.5-flash-lite"
  // instead, which trades a little quality for a noticeably higher quota.
  const model = 'gemini-2.5-flash';

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: geminiContents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 650 },
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const candidate = (data.candidates || [])[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || '').join('')
    : '';
  return text || '(No text returned by the model.)';

  // ---- To use Anthropic Claude instead, replace the block above with: -----
  // const resp = await fetch('https://api.anthropic.com/v1/messages', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     'x-api-key': process.env.ANTHROPIC_API_KEY,
  //     'anthropic-version': '2023-06-01',
  //   },
  //   body: JSON.stringify({
  //     model: 'claude-haiku-4-5-20251001',
  //     max_tokens: 650,
  //     system: systemPrompt,
  //     messages: messages
  //       .filter(m => m.role === 'user' || m.role === 'assistant')
  //       .map(m => ({ role: m.role, content: m.content })),
  //   }),
  // });
  // const data = await resp.json();
  // const textBlock = (data.content || []).find(b => b.type === 'text');
  // return textBlock ? textBlock.text : '(No text returned by the model.)';

  // ---- To use OpenAI instead, replace the block above with: ---------------
  // const resp = await fetch('https://api.openai.com/v1/chat/completions', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
  //   body: JSON.stringify({
  //     model: 'gpt-4o-mini',
  //     max_tokens: 650,
  //     messages: [
  //       { role: 'system', content: systemPrompt },
  //       ...messages.filter(m => m.role === 'user' || m.role === 'assistant'),
  //     ],
  //   }),
  // });
  // const data = await resp.json();
  // return data.choices[0].message.content;
}
