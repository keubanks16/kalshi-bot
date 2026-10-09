// AI forecaster: asks Claude (with web search) for the probability that a
// Kalshi market resolves YES. Claude is NOT shown the market's price, so its
// estimate is independent; the engine blends it with the price afterwards.

export interface ForecastQuestion {
  eventTitle: string;
  marketTitle: string;
  rules: string;
  closeTime: string; // ISO
  now: string; // ISO
}

export interface Forecast {
  probability: number; // P(YES), 0..1
  confidence: "low" | "medium" | "high";
  summary: string;
  cost: number; // dollars spent on this forecast
  searches: number;
}

export interface AiConfig {
  apiKey: string;
  model: string;
  maxSearches: number;
  inputPricePerM: number; // dollars per million input tokens
  outputPricePerM: number;
  timeoutMs?: number;
}

export const SEARCH_PRICE = 0.01; // $10 per 1,000 web searches

export const SYSTEM_PROMPT = `You are a careful, well-calibrated forecaster estimating the probability that a prediction market question resolves YES.

Method:
- Read the resolution rules exactly; the question resolves on those words, not on the headline.
- Search for the most recent, authoritative information (official sources, schedules, data releases, reputable news). Note dates.
- Start from a base rate for this kind of event, then adjust for the specific evidence.
- Account for how much time is left before the deadline and how often things like this change.
- Be calibrated: say 50% when you genuinely can't tell, and avoid extreme numbers unless the outcome is nearly settled.

Finish with ONE line of JSON and nothing after it:
{"probability": 0.37, "confidence": "low" | "medium" | "high", "summary": "1-2 sentences on the key evidence"}`;

export function buildPrompt(q: ForecastQuestion): string {
  return [
    `Current time: ${q.now}`,
    `Event: ${q.eventTitle}`,
    `Market: ${q.marketTitle}`,
    `Trading closes: ${q.closeTime}`,
    "",
    "Resolution rules:",
    q.rules.slice(0, 4000),
    "",
    "What is the probability this market resolves YES?",
  ].join("\n");
}

/** Pull the final {"probability": …} JSON out of Claude's answer. */
export function parseForecast(text: string): Pick<Forecast, "probability" | "confidence" | "summary"> | null {
  const matches = [...text.matchAll(/\{[^{}]*"probability"[^{}]*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(matches[i][0]);
      const p = Number(j.probability);
      if (!(p >= 0 && p <= 1)) continue;
      const confidence = ["low", "medium", "high"].includes(j.confidence) ? j.confidence : "low";
      return { probability: p, confidence, summary: String(j.summary ?? "").slice(0, 500) };
    } catch {
      /* try an earlier match */
    }
  }
  return null;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

export function costOf(u: Usage, cfg: Pick<AiConfig, "inputPricePerM" | "outputPricePerM">): { cost: number; searches: number } {
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const cost = (input * cfg.inputPricePerM) / 1e6 + ((u.output_tokens ?? 0) * cfg.outputPricePerM) / 1e6 + searches * SEARCH_PRICE;
  return { cost, searches };
}

export class AiError extends Error {
  cost: number;
  constructor(message: string, cost: number) {
    super(message);
    this.cost = cost;
  }
}

/** One forecast. Throws AiError (carrying what was spent) if no usable answer came back. */
export async function forecast(q: ForecastQuestion, cfg: AiConfig, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<Forecast> {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: buildPrompt(q) }];
  let cost = 0;
  let searches = 0;
  let text = "";

  // Long searches can pause mid-turn; continue up to twice.
  for (let turn = 0; turn < 3; turn++) {
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: cfg.maxSearches }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 150_000),
    });
    const body = await resp.text();
    if (!resp.ok) throw new AiError(`Claude API ${resp.status}: ${body.slice(0, 200)}`, cost);
    const data = JSON.parse(body);
    const c = costOf(data.usage ?? {}, cfg);
    cost += c.cost;
    searches += c.searches;
    text += (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }

  const parsed = parseForecast(text);
  if (!parsed) throw new AiError("Claude didn't return a probability", cost);
  return { ...parsed, cost, searches };
}
