export async function parseJsonResponse<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  if (!text) {
    return {} as T;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
    throw new Error(
      `Server abhi wake-up ya restart ho raha hai (HTTP ${resp.status}). 5–10 second ruk kar dubara try karen.`
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`Invalid server response (HTTP ${resp.status}). Please retry.`);
  }
}
