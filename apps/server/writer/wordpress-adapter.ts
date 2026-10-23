import type { PublicReadback, WordPressAdapter, WordPressPostSnapshot } from './types.js';
import { UnknownWordPressWriteError } from './types.js';
import { extractCanonicalHref, normalizeHtmlText, normalizePublicPageText } from '../security/html.js';

const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;

export interface HttpWordPressAdapterOptions {
  siteOrigin: string;
  username: string;
  applicationPassword: string;
  fetch?: typeof globalThis.fetch;
}

interface ApiPost {
  id?: unknown;
  link?: unknown;
  status?: unknown;
  modified_gmt?: unknown;
  modified?: unknown;
  content?: { raw?: unknown };
  slug?: unknown;
  title?: { raw?: unknown };
  excerpt?: { raw?: unknown };
  categories?: unknown;
  tags?: unknown;
  featured_media?: unknown;
  meta?: unknown;
}

function exactHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WordPress siteOrigin must be an exact HTTPS origin');
  }
  return url;
}

export class HttpWordPressAdapter implements WordPressAdapter {
  private readonly origin: URL;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpWordPressAdapterOptions) {
    this.origin = exactHttpsOrigin(options.siteOrigin);
    if (!options.username || !options.applicationPassword) throw new Error('WordPress credentials are required');
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.applicationPassword}`, 'utf8').toString('base64')}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async getPostForEdit(postId: number): Promise<WordPressPostSnapshot> {
    const url = this.apiUrl(postId, 'edit');
    const response = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    this.assertNoRedirect(response);
    if (!response.ok) throw new Error(`WordPress edit read failed with HTTP ${response.status}`);
    const data = await response.json() as ApiPost;
    if (data.id !== postId || typeof data.link !== 'string' || typeof data.status !== 'string' || typeof data.content?.raw !== 'string'
      || typeof data.slug !== 'string' || typeof data.title?.raw !== 'string' || typeof data.excerpt?.raw !== 'string'
      || !Array.isArray(data.categories) || !data.categories.every(Number.isInteger)
      || !Array.isArray(data.tags) || !data.tags.every(Number.isInteger)
      || !Number.isInteger(data.featured_media) || data.meta === null || typeof data.meta !== 'object' || Array.isArray(data.meta)) {
      throw new Error('WordPress edit response did not match the required schema');
    }
    const link = this.sameOriginUrl(data.link);
    return {
      postId,
      url: link.href,
      bodyHtml: data.content.raw,
      status: data.status,
      modified: typeof data.modified_gmt === 'string' ? data.modified_gmt : String(data.modified ?? ''),
      protectedFields: {
        slug: data.slug,
        title: data.title.raw,
        excerpt: data.excerpt.raw,
        categories: data.categories as number[],
        tags: data.tags as number[],
        featured_media: data.featured_media as number,
        meta: data.meta as Record<string, unknown>,
      },
    };
  }

  async updateBody(postId: number, bodyHtml: string): Promise<void> {
    const url = this.apiUrl(postId, 'edit');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: this.authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: bodyHtml }),
        redirect: 'manual',
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
    } catch {
      throw new UnknownWordPressWriteError('WordPress update transport failed; write outcome is unknown');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UnknownWordPressWriteError('WordPress update redirected; write outcome is unknown');
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new UnknownWordPressWriteError(`WordPress update returned HTTP ${response.status}; write outcome is unknown`);
      }
      throw new Error(`WordPress update was rejected with HTTP ${response.status}`);
    }
  }

  async checkPublicReadback(post: WordPressPostSnapshot): Promise<PublicReadback> {
    const publicPostUrl = this.sameOriginUrl(post.url);
    const url = this.apiUrl(post.postId, 'view');
    const response = await this.fetchImpl(url, {
      method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    this.assertNoRedirect(response);
    if (response.status === 200) {
      const data = await response.json() as { id?: unknown; content?: { rendered?: unknown } };
      if (data.id !== post.postId || typeof data.content?.rendered !== 'string') {
        throw new Error('WordPress public response did not match the required schema');
      }
      const expectedText = normalizeHtmlText(post.bodyHtml);
      const renderedText = normalizeHtmlText(data.content.rendered);
      if (renderedText !== expectedText) throw new Error('WordPress public REST text did not match the authenticated body');

      const pageResponse = await this.fetchImpl(publicPostUrl, {
        method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      this.assertNoRedirect(pageResponse);
      if (pageResponse.status !== 200) throw new Error(`WordPress public page read failed with HTTP ${pageResponse.status}`);
      const pageHtml = await pageResponse.text();
      const canonicalHref = extractCanonicalHref(pageHtml);
      if (!canonicalHref || this.sameOriginUrl(canonicalHref).href !== publicPostUrl.href) {
        throw new Error('WordPress public page canonical did not match the authenticated post URL');
      }
      if (!normalizePublicPageText(post.bodyHtml, pageHtml).includes(expectedText)) {
        throw new Error('WordPress public page did not contain the approved visible body text');
      }
      return {
        visibility: 'public',
        statusCode: 200,
        url: publicPostUrl.href,
        normalizedText: renderedText,
      };
    }
    if (![401, 404].includes(response.status)) {
      throw new Error(`WordPress public read failed with HTTP ${response.status}`);
    }
    return {
      visibility: 'isolated',
      statusCode: response.status,
      url: publicPostUrl.href,
    };
  }

  private apiUrl(postId: number, context: 'edit' | 'view'): URL {
    if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('postId must be a positive integer');
    const url = new URL(`/wp-json/wp/v2/posts/${postId}`, this.origin);
    url.searchParams.set('context', context);
    url.searchParams.set('_fields', context === 'edit'
      ? 'id,link,status,modified,modified_gmt,content,slug,title,excerpt,categories,tags,featured_media,meta'
      : 'id,content');
    return url;
  }

  private sameOriginUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== this.origin.origin || url.username || url.password) {
      throw new Error('WordPress returned a URL outside the configured HTTPS site origin');
    }
    return url;
  }

  private assertNoRedirect(response: Response): void {
    if (response.status >= 300 && response.status < 400) throw new Error('WordPress redirects are not allowed');
    if (response.url) this.sameOriginUrl(response.url);
  }
}
