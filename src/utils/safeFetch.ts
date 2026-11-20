export async function parseJsonResponse<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  if (!text) {
    return {} as T;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
    throw new Error(
      'Server abhi taiyaar ho raha hai — kripya 5–10 second ruk kar dubara try karen.'
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error('Server se sahi jawaab nahi mil paya — kripya ek baar dubara try karen.');
  }
}

export function toFriendlyUserMessage(
  err: unknown,
  fallback = 'Kuch samasya aa gayi — kripya ek baar dubara koshish karen.'
): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const isTechnicalOrBrandLeak =
    /gemini|groq|hydrogen|flash[\s_-]?lite|gpt-oss|llama|openai|api[\s_-]?key|secret|smtp|http\s*\d{3}|permission[_-]denied|quota|resource_exhausted|deadline_exceeded|aborterror|timeout|json|econnreset|etimedout|stack|trace|^\s*\{/i.test(
      trimmed
    );

  if (isTechnicalOrBrandLeak) {
    if (/timeout|timed out|abort/i.test(trimmed)) {
      return 'Network slow hone ke kaaran samay zyada lag raha hai. Kripya dubara koshish karen.';
    }
    if (/quota|resource_exhausted|429|limit/i.test(trimmed)) {
      return 'Abhi server par zyada load hai. Kripya kuch der baad dubara koshish karen.';
    }
    return fallback;
  }

  return trimmed;
}
