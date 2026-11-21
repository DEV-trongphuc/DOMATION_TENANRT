export type LeadAiScreenerFetcherFn = (
  url: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

let customLeadAiScreenerFetcher: LeadAiScreenerFetcherFn | null = null;

export function setLeadAiScreenerFetcherForTesting(fn: LeadAiScreenerFetcherFn | null): void {
  customLeadAiScreenerFetcher = fn;
}

export function hasLeadAiScreenerTestFetcher(): boolean {
  return customLeadAiScreenerFetcher !== null;
}

export type LeadGatekeeperEvalResult =
  | {
      ok: true;
      decision: 'pass' | 'hold' | 'reject';
      score: number;
      reason: string;
      promptTokens: number;
      completionTokens: number;
    }
  | {
      ok: false;
      fallback: true;
      reason: string;
    };

function normalizeGeminiLeadModel(preferredModel?: string | null): string {
  const clean = String(preferredModel || '').trim();
  if (!clean || clean === 'gemini-3.5-flash-lite') {
    return 'gemini-2.5-flash';
  }
  return clean;
}

function stripJsonCodeFences(rawText: string): string {
  const trimmed = String(rawText || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export async function evaluateLeadGatekeeperWithGemini(params: {
  apiKey: string;
  model?: string | null;
  promptRules?: string | null;
  lead: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<LeadGatekeeperEvalResult> {
  const apiKey = String(params.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, fallback: true, reason: 'Chưa cấu hình Gemini API Key' };
  }

  const modelName = normalizeGeminiLeadModel(params.model);
  const timeoutMs = Math.min(4_000, Math.max(300, Math.round(Number(params.timeoutMs ?? 2_500))));
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent`;

  const leadSummary = {
    name: params.lead.name || null,
    phone: params.lead.phone || null,
    email: params.lead.email || null,
    source: params.lead.source || null,
    campaign: params.lead.campaign || null,
    product_interest: params.lead.product_interest || null,
    budget_range: params.lead.budget_range || null,
    note: params.lead.note || null,
    custom_fields: params.lead.custom_fields || {},
  };

  const rulesText = String(params.promptRules || '').trim();
  const prompt = [
    'Bạn là AI Gatekeeper sàng lọc Lead CRM thực chiến tại Việt Nam.',
    rulesText
      ? `Tiêu chí sàng lọc của doanh nghiệp:\n${rulesText.slice(0, 1500)}`
      : 'Tiêu chí mặc định: phát hiện số rác/spam/test/không có nhu cầu rõ ràng -> "hold" hoặc "reject"; lead hợp lệ -> "pass".',
    'Chỉ trả về JSON hợp lệ theo schema: {"decision":"pass"|"hold"|"reject","score":0-100,"reason":"Giải thích ngắn bằng tiếng Việt"}',
    `Dữ liệu Lead:\n${JSON.stringify(leadSummary).slice(0, 4000)}`,
  ].join('\n\n');

  const fetcher = customLeadAiScreenerFetcher || fetch;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`Gemini request timed out after ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    const fetchPromise = Promise.resolve().then(() =>
      fetcher(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 256,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      })
    );
    // Prevent late unhandledRejection if timeoutPromise wins the race first
    fetchPromise.catch(() => {});

    const resp = await Promise.race([fetchPromise, timeoutPromise]);

    if (!resp.ok) {
      return {
        ok: false,
        fallback: true,
        reason: `Gemini API HTTP ${resp.status} (fallback thủ công)`,
      };
    }

    const json = (await resp.json().catch(() => null)) as Record<string, any> | null;
    const rawText = json?.candidates?.[0]?.content?.parts
      ?.map((p: any) => String(p?.text || ''))
      .join('\n')
      .trim();

    if (!rawText) {
      return {
        ok: false,
        fallback: true,
        reason: 'Gemini phản hồi rỗng (fallback thủ công)',
      };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(stripJsonCodeFences(rawText));
    } catch {
      return {
        ok: false,
        fallback: true,
        reason: 'Gemini trả về JSON không hợp lệ (fallback thủ công)',
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        fallback: true,
        reason: 'Gemini payload không đúng định dạng (fallback thủ công)',
      };
    }

    const rawDecision = String(parsed.decision || '').trim().toLowerCase();
    if (rawDecision !== 'pass' && rawDecision !== 'hold' && rawDecision !== 'reject') {
      return {
        ok: false,
        fallback: true,
        reason: 'Gemini decision không hợp lệ (fallback thủ công)',
      };
    }

    const rawScore = Number(parsed.score);
    const score = Number.isFinite(rawScore) ? Math.min(100, Math.max(0, Math.round(rawScore))) : 50;
    const reason = String(parsed.reason || 'AI Gatekeeper đã đánh giá Lead').trim().slice(0, 500);
    const promptTokens = Math.max(0, Number(json?.usageMetadata?.promptTokenCount || 0));
    const completionTokens = Math.max(0, Number(json?.usageMetadata?.candidatesTokenCount || 0));

    return {
      ok: true,
      decision: rawDecision,
      score,
      reason,
      promptTokens,
      completionTokens,
    };
  } catch (err: any) {
    return {
      ok: false,
      fallback: true,
      reason: `Gemini timeout/lỗi mạng: ${err?.message || 'unknown'} (fallback thủ công)`,
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
