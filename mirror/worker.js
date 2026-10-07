// Cloudflare Worker - Chronos Seal GitHub 镜像源
// 绑定域名: mirror.crclare.top

const ALLOWED_REPO = 'CrCLARE/Chronos-Seal-GUI';
const UPSTREAM = 'raw.githubusercontent.com';
const CACHE_TTL = 300; // 5 分钟

const ALLOWED_EXTENSIONS = ['.js', '.html', '.tmpl', '.json', '.sig'];
const ALLOWED_SPECIAL = ['manifest.json', 'manifest.sig'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 路径解析: /CrCLARE/Chronos-Seal-GUI/main/Tools/V2.2/MV/xxx.js
    const path = url.pathname.replace(/^\//, '');
    const parts = path.split('/');

    if (parts.length < 3) {
      return new Response('Bad Request: path too short', { status: 400 });
    }

    const repo = parts[0] + '/' + parts[1];
    const rest = parts.slice(2).join('/');

    // 白名单仓库校验
    if (repo !== ALLOWED_REPO) {
      return new Response('Forbidden: repository not allowed', { status: 403 });
    }

    // 防路径遍历
    if (rest.includes('..') || rest.includes('//')) {
      return new Response('Bad Request: invalid path', { status: 400 });
    }

    // 扩展名白名单（防止被当作通用代理滥用）
    const lowerRest = rest.toLowerCase();
    const fileName = lowerRest.split('/').pop();
    const isAllowed =
      ALLOWED_SPECIAL.some(s => fileName === s) ||
      ALLOWED_EXTENSIONS.some(ext => fileName.endsWith(ext));

    if (!isAllowed) {
      return new Response('Forbidden: file type not allowed', { status: 403 });
    }

    // 构造上游 URL
    const upstreamUrl = `https://${UPSTREAM}/${repo}/${rest}`;

    // 查缓存
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    let response = await cache.match(cacheKey);

    if (response) {
      const clone = new Response(response.body, response);
      clone.headers.set('X-Cache', 'HIT');
      clone.headers.set('Access-Control-Allow-Origin', '*');
      return clone;
    }

    // 未命中：回源
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: {
          'User-Agent': 'Chronos-Seal-Mirror/1.0'
        }
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502 });
    }

    if (!upstreamResponse.ok) {
      return new Response('Upstream returned ' + upstreamResponse.status, {
        status: upstreamResponse.status,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 构造响应
    const headers = new Headers(upstreamResponse.headers);
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Cache', 'MISS');

    const finalResponse = new Response(upstreamResponse.body, {
      status: 200,
      headers
    });

    // 异步写缓存
    ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));

    return finalResponse;
  }
};
