/** Retry rate limits without exposing request headers, keys or story text. */
export async function fetchTTSAPI(url: string, init: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (attempt >= 2 || (response.status !== 429 && response.status < 500))
      return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
