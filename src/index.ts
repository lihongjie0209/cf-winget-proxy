/**
 * Winget Source Proxy Worker
 *
 * Proxies cdn.winget.microsoft.com to accelerate Windows Package Manager
 * source index downloads from China. Fully self-contained — does not depend
 * on any external proxy service.
 *
 * Supported scenarios:
 *   /cache/**            → cdn.winget.microsoft.com (winget source index + manifests)
 *   /<hostname>/**       → https://<hostname>/... (generic installer download proxy)
 *
 * URL rewriting in manifest YAML:
 *   ALL InstallerUrl values rewritten to go through this worker:
 *   https://some.host/path → proxyBase/some.host/path
 *
 * Usage as a winget custom source:
 *   winget source add --name winget-cn \
 *     --arg https://winget.cn.lihongjie.cn/cache \
 *     --type Microsoft.PreIndexed.Package
 */

const UPSTREAM_BASE = "https://cdn.winget.microsoft.com";

// Regex: matches a path segment that looks like a hostname (contains at least one dot)
const DOMAIN_PREFIX_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+)(\/.*)?$/;

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "proxy-connection",
]);

function buildRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of incoming) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function buildResponseHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of incoming) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/**
 * Rewrite ALL InstallerUrl values in manifest YAML to route through this worker.
 * Matches any https:// URL on an InstallerUrl line and rewrites it to
 * proxyBase/<host>/<path>, regardless of the download host.
 */
function rewriteManifestUrls(yaml: string, proxyBase: string): string {
  return yaml.replace(
    /^(\s*InstallerUrl:\s+)https?:\/\/([^/\s]+)(\/\S*)/gm,
    (_, prefix, host, path) => `${prefix}${proxyBase}/${host}${path}`
  );
}

/**
 * If the path starts with a domain-like prefix (e.g. /download.sublimetext.com/...),
 * return the upstream URL to proxy to. Otherwise return null.
 * A domain must contain at least one dot; plain words like /cache never match.
 */
function getProxyUpstream(pathname: string): string | null {
  const m = DOMAIN_PREFIX_RE.exec(pathname);
  if (!m) return null;
  const host = m[1];
  const rest = m[2] ?? "/";
  return `https://${host}${rest}`;
}

/**
 * Determine if a path is a V1 manifest file (the merged YAML served per package version).
 * Pattern: /cache/manifests/{letter}/{Publisher}/{Package}/{Version}/{4char_hash}
 * These are small text files (few KB) safe to buffer and rewrite.
 */
function isManifestPath(pathname: string): boolean {
  return pathname.includes("/manifests/");
}

async function proxyRequest(request: Request, targetUrl: string, proxyBase: string): Promise<Response> {
  const reqHeaders = buildRequestHeaders(request.headers);

  // For manifest paths we follow redirects (small text files, need body).
  // For all other requests (binary downloads) we use manual redirect so we can
  // rewrite the Location header and let the client re-follow through the proxy —
  // this avoids the worker having to stream large files twice.
  const isManifest = isManifestPath(new URL(targetUrl).pathname);

  const upstreamReq = new Request(targetUrl, {
    method: request.method,
    headers: reqHeaders,
    body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
    redirect: isManifest ? "follow" : "manual",
    // @ts-ignore — Workers-specific duplex hint for streaming bodies
    duplex: "half",
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamReq);
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const respHeaders = buildResponseHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  const pathname = new URL(targetUrl).pathname;

  // Intercept 3xx redirects: rewrite Location to stay within the proxy
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (location) {
      try {
        const loc = new URL(location, targetUrl); // resolve relative URLs
        if (loc.protocol === "https:" || loc.protocol === "http:") {
          respHeaders.set("location", `${proxyBase}/${loc.host}${loc.pathname}${loc.search}${loc.hash}`);
        }
      } catch {
        // unparseable location — leave as-is
      }
    }
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  }

  // For manifest YAML files: buffer and rewrite installer URLs to go through this worker
  if (
    upstream.ok &&
    request.method === "GET" &&
    isManifestPath(pathname) &&
    (contentType.includes("text") || contentType.includes("yaml") || contentType === "application/octet-stream" || contentType === "")
  ) {
    const text = await upstream.text();
    // Only rewrite if it looks like a winget manifest YAML
    if (text.includes("InstallerUrl:") || text.includes("ManifestType:")) {
      const rewritten = rewriteManifestUrls(text, proxyBase);
      // Update content-length since rewriting changes size
      respHeaders.set("content-length", String(new TextEncoder().encode(rewritten).byteLength));
      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function landingPage(): Response {
  const intlHost = "winget.lihongjie.cn";
  const cnHost = "winget.cn.lihongjie.cn";

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Winget 镜像代理</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --card: #21262d; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #e3b341; --radius: 8px;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 800px; margin: 0 auto; }
  header { text-align: center; padding: 2rem 0 2.5rem; }
  header h1 { font-size: 2rem; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: .6rem; }
  header p { color: var(--muted); margin-top: .6rem; font-size: .95rem; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: var(--accent); }

  .btn { background: var(--accent); color: #000; border: none; border-radius: 6px; padding: .6rem 1.1rem; font-size: .875rem; font-weight: 600; cursor: pointer; transition: opacity .15s; white-space: nowrap; }
  .btn:hover { opacity: .85; }
  .btn.sm { padding: .35rem .75rem; font-size: .8rem; }
  .btn.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .btn.ghost:hover { color: var(--accent); border-color: var(--accent); opacity: 1; }

  .steps { display: flex; flex-direction: column; gap: .75rem; }
  .step { display: flex; gap: .75rem; }
  .step-num { width: 22px; height: 22px; border-radius: 50%; background: rgba(88,166,255,.2); color: var(--accent); font-size: .75rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; }
  .step-body { flex: 1; }
  .step-body p { font-size: .875rem; color: var(--muted); margin-bottom: .4rem; }
  .code-block { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: .65rem .9rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .82rem; color: var(--text); display: flex; gap: .5rem; align-items: flex-start; }
  .code-block pre { flex: 1; margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--green); }
  .note { font-size: .78rem; color: var(--muted); margin-top: .4rem; }

  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
  td { padding: .55rem .75rem; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(110,118,129,.15); border-radius: 4px; padding: .15em .45em; font-family: "SFMono-Regular", Consolas, monospace; font-size: .85em; }

  footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 2rem 0 1rem; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>📦 Winget 镜像代理</h1>
    <p>基于 Cloudflare Workers &nbsp;·&nbsp; 加速 Windows Package Manager 软件源下载</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center;margin-top:.75rem;font-size:.85rem;">
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🌐 国际线路：<code>${intlHost}</code></span>
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🇨🇳 国内优选：<code>${cnHost}</code></span>
    </div>
  </header>

  <!-- Quick Start -->
  <div class="card">
    <h2>🚀 快速开始</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>添加镜像源（国内优选推荐）：</p>
          <div class="code-block">
            <pre>winget source add --name winget-cn --arg https://${cnHost}/cache --type Microsoft.PreIndexed.Package</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>更新源索引：</p>
          <div class="code-block">
            <pre>winget source update --name winget-cn</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <p>从镜像源安装软件（安装器下载也经过代理加速）：</p>
          <div class="code-block">
            <pre>winget install Git.Git --source winget-cn
winget install Mozilla.Firefox --source winget-cn</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Remove/Reset -->
  <div class="card">
    <h2>🔄 重置/移除镜像源</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>移除镜像源：</p>
          <div class="code-block">
            <pre>winget source remove --name winget-cn</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Set as default -->
  <div class="card">
    <h2>⭐ 设为默认源（替换官方源）</h2>
    <p style="color:var(--muted);font-size:.875rem;margin-bottom:1rem;">将官方 <code>winget</code> 源替换为镜像源后，无需加 <code>--source</code> 参数即可走代理加速。</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>移除官方默认源：</p>
          <div class="code-block">
            <pre>winget source remove --name winget</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>以相同名称添加镜像源：</p>
          <div class="code-block">
            <pre>winget source add --name winget --arg https://${cnHost}/cache --type Microsoft.PreIndexed.Package</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <p>之后所有安装命令无需指定 <code>--source</code>：</p>
          <div class="code-block">
            <pre>winget install Git.Git
winget install Mozilla.Firefox
winget upgrade --all</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
          <p class="note">⚠️ 恢复官方源：<code>winget source reset --force</code></p>
        </div>
      </div>
    </div>
  </div>

  <!-- Route table -->
  <div class="card">
    <h2>📡 代理路径</h2>
    <table>
      <thead><tr><th>路径</th><th>目标</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td><code>/cache/source.msix</code></td><td><code>cdn.winget.microsoft.com</code></td><td>完整包索引下载（透明代理）</td></tr>
        <tr><td><code>/cache/source2.msix</code></td><td><code>cdn.winget.microsoft.com</code></td><td>增量包索引下载（透明代理）</td></tr>
        <tr><td><code>/cache/manifests/**</code></td><td><code>cdn.winget.microsoft.com</code></td><td>包清单 YAML（所有 InstallerUrl 重写加速）</td></tr>
        <tr><td><code>/&lt;hostname&gt;/**</code></td><td><code>https://&lt;hostname&gt;</code></td><td>通用安装器下载代理（任意域名）</td></tr>
      </tbody>
    </table>
  </div>

  <footer>Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a></footer>
</div>

<script>
function copyBlock(btn) {
  const pre = btn.closest('.code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, search } = url;

    // Landing page
    if (pathname === "/" || pathname === "") {
      return landingPage();
    }

    const proxyBase = `${url.protocol}//${url.host}`;

    // Generic download proxy: /<hostname>/path → https://<hostname>/path
    const proxyTarget = getProxyUpstream(pathname);
    if (proxyTarget) {
      return proxyRequest(request, `${proxyTarget}${search}`, proxyBase);
    }

    // Everything else: proxy to upstream winget CDN
    const targetUrl = `${UPSTREAM_BASE}${pathname}${search}`;
    return proxyRequest(request, targetUrl, proxyBase);
  },
};
