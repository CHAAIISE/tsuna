import { readFile } from "node:fs/promises";

/** A page handed to `fetch_market_news`: where it came from and its text. */
export interface NewsPage {
  source: string;
  content: string;
}

/** Largest page passed to the model, in characters. */
export const MAX_NEWS_CHARS = 20_000;
export const UNTRUSTED_OPEN = "<untrusted_content>";
export const UNTRUSTED_CLOSE = "</untrusted_content>";

/** Reads an http(s) URL or a local file as text. */
export async function loadNewsPage(source: string, fetcher: typeof fetch = fetch): Promise<NewsPage> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetcher(source, { headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5" } });
    if (!response.ok) throw new Error(`GET ${source} returned ${response.status}`);
    return { source, content: await response.text() };
  }
  return { source, content: await readFile(source, "utf8") };
}

/**
 * Wraps third-party content as data for the model. The text is passed as is
 * (only truncated to {@link MAX_NEWS_CHARS}): nothing is filtered out, so a
 * poisoned page reaches the model exactly as written and any harm it causes has
 * to get past the vault contract.
 */
export function delimitNews(page: NewsPage): { source: string; truncated: boolean; content: string } {
  const truncated = page.content.length > MAX_NEWS_CHARS;
  const text = truncated ? page.content.slice(0, MAX_NEWS_CHARS) : page.content;
  return {
    source: page.source,
    truncated,
    content: `${UNTRUSTED_OPEN}\n${text}\n${UNTRUSTED_CLOSE}`,
  };
}
