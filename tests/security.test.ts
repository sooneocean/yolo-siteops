import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeProposalHtml,
  createSafePreview,
  normalizeHtmlText,
  normalizePublicPageText,
  UnsafeHtmlError,
} from '../apps/server/security/html.js';
import { createSessionSecurity } from '../apps/server/security/session.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function sessionApp() {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const security = createSessionSecurity({ appOrigin: origin, bootstrapCode: 'test-bootstrap-secret' });
  app.use('/api/session', security.sessionRouter);
  app.use('/api', security.requireApiSession);
  app.get('/api/private', (req, res) => res.json({ sessionId: req.session?.id }));
  app.post('/api/mutate', (_req, res) => res.json({ ok: true }));
  return { origin, security };
}

describe('session security', () => {
  it('exchanges a one-time bootstrap for an HttpOnly cookie and session-bound CSRF', async () => {
    const { origin, security } = await sessionApp();
    expect(security.launchUrl('/').startsWith(`${origin}/#token=`)).toBe(true);

    const badOrigin = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:9999' },
      body: JSON.stringify({ bootstrap: 'test-bootstrap-secret' }),
    });
    expect(badOrigin.status).toBe(403);

    const exchange = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ bootstrap: 'test-bootstrap-secret' }),
    });
    expect(exchange.status).toBe(201);
    const cookie = exchange.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const cookiePair = cookie?.split(';')[0] ?? '';
    const { csrf } = await exchange.json() as { csrf: string };

    const getSession = await fetch(`${origin}/api/session`, { headers: { cookie: cookiePair } });
    expect(getSession.status).toBe(200);
    expect((await getSession.json() as { csrf: string }).csrf).toBe(csrf);

    expect((await fetch(`${origin}/api/mutate`, { method: 'POST', headers: { cookie: cookiePair, origin } })).status).toBe(403);
    expect((await fetch(`${origin}/api/mutate`, {
      method: 'POST', headers: { cookie: cookiePair, origin, 'x-csrf-token': csrf },
    })).status).toBe(200);

    const replay = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ bootstrap: 'test-bootstrap-secret' }),
    });
    expect(replay.status).toBe(410);
  });

  it('does not accept a fixed header as authentication and requires browser Origin', async () => {
    const { origin } = await sessionApp();
    expect((await fetch(`${origin}/api/private`, { headers: { 'x-api-key': 'test-bootstrap-secret' } })).status).toBe(401);
    const noOrigin = await fetch(`${origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap: 'test-bootstrap-secret' }),
    });
    expect(noOrigin.status).toBe(403);
  });
});

describe('proposal HTML validation', () => {
  it('preserves normal Gutenberg comments and hashes the exact approved bytes', () => {
    const html = '<!-- wp:paragraph {"className":"lead"} --><p class="lead">安全內容</p><!-- /wp:paragraph -->';
    expect(assertSafeProposalHtml(html)).toBe(html);
    const preview = createSafePreview('<p>before</p>', html);
    expect(preview.afterHtml).toBe(html);
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript&#x3a;alert(1)">x</a>',
    '<embed src="https://evil.invalid/x">',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  ])('rejects active content: %s', (html) => {
    expect(() => assertSafeProposalHtml(html)).toThrow(UnsafeHtmlError);
  });
});

describe('HTML text normalization', () => {
  it('matches raw table cells with rendered whitespace-separated cells', () => {
    const raw = '<figure><table><tbody><tr><td>指標</td><td>數值</td></tr><tr><td>點擊</td><td>7</td></tr></tbody></table></figure>';
    const rendered = '<figure class="wp-block-table"><table><tbody>\n<tr>\n<td>指標</td>\n<td>數值</td>\n</tr>\n<tr>\n<td>點擊</td>\n<td>7</td>\n</tr>\n</tbody></table></figure>';
    expect(normalizeHtmlText(raw)).toBe(normalizeHtmlText(rendered));
  });

  it('treats block and break elements as semantic text boundaries', () => {
    expect(normalizeHtmlText('<h2>標題</h2><p>內文</p>')).toBe(normalizeHtmlText('<h2>標題</h2>\n\n<p>內文</p>'));
    expect(normalizeHtmlText('<p>A<br>B<hr>C<wbr>D</p>')).toBe('A B C D');
    expect(normalizeHtmlText('<p>AB</p>')).not.toBe(normalizeHtmlText('<p>A</p><p>B</p>'));
  });

  it('preserves adjacency across inline elements', () => {
    expect(normalizeHtmlText('<p>A<span>B</span><strong>C</strong><em>D</em><a href="#">E</a><code>F</code></p>'))
      .toBe('ABCDEF');
  });

  it('canonicalizes entities and collapses whitespace', () => {
    expect(normalizeHtmlText('<p>A&amp;B&nbsp; C</p>')).toBe(normalizeHtmlText('<p>A&#38;B&#160;\nC</p>'));
  });

  it('drops non-body executable and inert container text', () => {
    const html = '<head>head only</head><script>script only</script><style>style only</style><textarea>textarea only</textarea><option>option only</option><xmp>xmp only</xmp><template>template only</template><p>Body</p>';
    expect(normalizeHtmlText(html)).toBe('Body');
  });
});

describe('public page TOC normalization', () => {
  const body = '<p>導言</p><h2>第一節</h2><h3>第二節</h3><p>結尾</p>';
  const validToc = [
    '<div id="toc_container" role="navigation" data-nosnippet class="toc_wrap">',
    '<p class="toc_title">文章目錄</p>',
    '<ul class="toc_list">',
    '<li><a href="#first"><span class="toc_number">1.</span>第一節</a>',
    '<ul><li><a href="#second"><span class="toc_number">1.1.</span>第二節</a></li></ul></li>',
    '</ul></div>',
  ].join('');
  const pageWith = (insertion: string) => `<html><head><title>Theme</title></head><body><h1>Site title</h1><article class="wp-block-post-content"><p>導言</p>${insertion}<h2><span id="first">第一節</span></h2><h3><span id="second">第二節</span></h3><p>結尾</p></article></body></html>`;

  it('removes one fully validated same-page TOC before page-only comparison', () => {
    expect(normalizePublicPageText(body, pageWith(validToc))).toContain(normalizeHtmlText(body));
  });

  it('matches the observed raw headings without ids to public descendant span ids', () => {
    const observedPage = `<main><div class="wp-block-post-content"><p>導言</p>${validToc}<h2><span id="first">第一節</span></h2><h3><span id="second">第二節</span></h3><p>結尾</p><h3>主題元件標題</h3></div></main>`;
    const normalized = normalizePublicPageText(body, observedPage);
    expect(normalized).toContain(normalizeHtmlText(body));
    expect(normalized).not.toContain('文章目錄');
  });

  it.each([
    ['generic navigation', '<nav role="navigation">導覽垃圾</nav>'],
    ['role spam', '<div role="navigation" data-nosnippet>導覽垃圾</div>'],
    ['wrong id', validToc.replace('id="toc_container"', 'id="other_toc"')],
    ['missing data-nosnippet', validToc.replace(' data-nosnippet', '')],
    ['class only', validToc.replace('id="toc_container"', 'class="toc_container"')],
    ['external href', validToc.replace('href="#first"', 'href="https://evil.invalid/#first"')],
    ['duplicate TOC', `${validToc}${validToc}`],
    ['wrong heading label', validToc.replace('>第一節</a>', '>錯誤標題</a>')],
    ['extra text', validToc.replace('</ul></div>', '</ul>未核准文字</div>')],
  ])('does not discard %s', (_name, insertion) => {
    const normalized = normalizePublicPageText(body, pageWith(insertion));
    expect(normalized).not.toContain(normalizeHtmlText(body));
  });

  it('does not discard authored navigation from the approved body', () => {
    const authored = '<nav role="navigation"><p>作者導覽</p></nav><h2>第一節</h2>';
    expect(normalizePublicPageText(authored, `<main>${authored}</main>`)).toContain('作者導覽 第一節');
  });
});
