/**
 * Winget Source Proxy Worker — Microsoft.Rest mode
 *
 * Implements a Microsoft.Rest winget source backed by the microsoft/winget-pkgs
 * GitHub repository. Rewrites InstallerUrl values to proxy through this worker
 * so all installer downloads are accelerated (no manifest hash issue — REST
 * sources do not SHA256-verify manifest content).
 *
 * REST API endpoints (for Microsoft.Rest source type):
 *   GET  /information             → source metadata
 *   POST /manifestSearch          → package search (exact ID + keyword)
 *   GET  /packageManifests/{id}   → package manifest with rewritten InstallerUrl
 *
 * Generic installer download proxy:
 *   GET  /<hostname>/path         → https://<hostname>/path  (transparent proxy)
 *
 * Legacy PreIndexed proxy (transparent, no manifest rewriting):
 *   GET  /cache/**                → cdn.winget.microsoft.com
 *
 * Usage:
 *   winget source add --name winget-cn \
 *     --arg https://winget.cn.lihongjie.cn \
 *     --type Microsoft.Rest
 */
import * as jsyaml from "js-yaml";

// ─── Constants ───────────────────────────────────────────────────────────────

const UPSTREAM_CDN = "https://cdn.winget.microsoft.com";
const WINGET_PKGS_API = "https://api.github.com/repos/microsoft/winget-pkgs";
// YAML manifest files: raw.githubusercontent.com (not subject to api.github.com rate limits)
const WINGET_PKGS_MANIFEST_BASE = "https://raw.githubusercontent.com/microsoft/winget-pkgs/master";

// Domain-like path prefix: /download.example.com/path  (requires at least one dot)
const DOMAIN_PREFIX_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+)(\/.*)?$/;

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "proxy-connection",
]);

// ─── Environment ─────────────────────────────────────────────────────────────

interface Env {
  GITHUB_TOKEN?: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function rewriteInstallerUrl(url: string, proxyBase: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") {
      return `${proxyBase}/${u.host}${u.pathname}${u.search}`;
    }
  } catch { /* leave as-is */ }
  return url;
}

// ─── Generic transparent proxy ───────────────────────────────────────────────

async function proxyRequest(
  request: Request,
  targetUrl: string,
  proxyBase: string
): Promise<Response> {
  const reqHeaders = stripHopByHop(request.headers);

  const upstreamReq = new Request(targetUrl, {
    method: request.method,
    headers: reqHeaders,
    body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
    redirect: "manual",
    // @ts-ignore — Workers-specific streaming hint
    duplex: "half",
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamReq);
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const respHeaders = stripHopByHop(upstream.headers);

  // Rewrite 3xx Location to keep client inside the proxy
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) {
      try {
        const resolved = new URL(loc, targetUrl);
        if (resolved.protocol === "https:" || resolved.protocol === "http:") {
          respHeaders.set(
            "location",
            `${proxyBase}/${resolved.host}${resolved.pathname}${resolved.search}${resolved.hash}`
          );
        }
      } catch { /* leave as-is */ }
    }
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

// ─── GitHub helper ────────────────────────────────────────────────────────────
// Only used for directory listing (version enumeration). Responses are cached
// at the CF edge for 30 minutes to stay well within the 60 req/hr rate limit.

async function ghFetch(url: string, env: Env): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": "winget-cn-proxy/2.0",
    Accept: "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
  return fetch(url, {
    headers,
    // @ts-ignore: CF Workers cf option for edge-level caching
    cf: { cacheEverything: true, cacheTtl: 1800 },
  });
}

// ─── Package ID helpers ───────────────────────────────────────────────────────

interface PkgPath {
  firstLetter: string;
  publisher: string;
  packageRest: string;
  basePath: string; // e.g. "manifests/s/SublimeHQ/SublimeText.4"
}

function parsePackageId(id: string): PkgPath {
  const firstLetter = id[0].toLowerCase();
  const dot = id.indexOf(".");
  const publisher = dot >= 0 ? id.slice(0, dot) : id;
  const packageRest = dot >= 0 ? id.slice(dot + 1) : "";
  // Directory path: all dots in the package portion become slashes
  // e.g. SublimeHQ.SublimeText.4 → manifests/s/SublimeHQ/SublimeText/4
  const packageDirPath = packageRest.replace(/\./g, "/");
  return {
    firstLetter,
    publisher,
    packageRest,
    basePath: `manifests/${firstLetter}/${publisher}/${packageDirPath}`,
  };
}

function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v.split(".").map((x) => parseInt(x.replace(/\D/g, "")) || 0);
  const ap = norm(a);
  const bp = norm(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ─── REST API: GET /information ───────────────────────────────────────────────

function handleInformation(): Response {
  return Response.json({
    Data: {
      SourceIdentifier: "winget-cn",
      ServerSupportedVersions: ["1.0.0", "1.1.0", "1.6.0"],
    },
  });
}

// ─── REST API: POST /manifestSearch ──────────────────────────────────────────

async function handleManifestSearch(
  request: Request,
  env: Env
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ Data: [] });
  }

  // Debug: log exact request body from winget
  console.log("manifestSearch body:", JSON.stringify(body));

  const filters: any[] = body?.Filters ?? [];
  const inclusions: any[] = body?.Inclusions ?? [];
  const query = body?.Query;
  const maxResults: number = body?.MaximumResults ?? 20;

  // ── Helper: look up a package ID in winget-pkgs and return a Data entry ────
  async function lookupPackageId(id: string): Promise<object | null> {
    const { basePath, publisher, packageRest } = parsePackageId(id);
    const resp = await ghFetch(`${WINGET_PKGS_API}/contents/${basePath}`, env);
    if (!resp.ok) return null;
    const entries = (await resp.json()) as any[];
    const versions = entries
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      .sort((a, b) => compareVersions(b, a));
    if (versions.length === 0) return null;
    return {
      PackageIdentifier: id,
      PackageName: packageRest.replace(/\./g, " "),
      Publisher: publisher,
      Versions: versions.slice(0, 10).map((v) => ({ PackageVersion: v })),
    };
  }

  // ── Case 1: PackageIdentifier filter/inclusion (winget install sends Filters+CaseInsensitive)
  const allCriteria = [...filters, ...inclusions];
  const idFilter = allCriteria.find(
    (f) =>
      f.PackageMatchField === "PackageIdentifier" &&
      (f.RequestMatch?.MatchType === "Exact" ||
        f.RequestMatch?.MatchType === "CaseInsensitive")
  );
  if (idFilter) {
    const id: string = idFilter.RequestMatch.KeyWord;
    console.log("manifestSearch: looking up package id:", id);
    const entry = await lookupPackageId(id);
    if (entry) {
      const result = { Data: [entry] };
      console.log("manifestSearch response:", JSON.stringify(result));
      return Response.json(result);
    }
    console.log("manifestSearch: package not found for id:", id);
    return Response.json({ Data: [] });
  }

  // ── Case 2: keyword search via Query ─────────────────────────────────────
  const keyword: string | undefined = query?.KeyWord;
  if (keyword) {
    // If keyword looks like a PackageIdentifier (Publisher.Package), try direct lookup first
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(keyword)) {
      const entry = await lookupPackageId(keyword);
      if (entry) {
        return Response.json({ Data: [entry] });
      }
    }

    // Fall back to GitHub code search (rate-limited: 10/min unauthenticated)
    const searchUrl =
      `https://api.github.com/search/code` +
      `?q=${encodeURIComponent(keyword)}+repo:microsoft/winget-pkgs+path:manifests` +
      `&per_page=${Math.min(maxResults, 10)}`;
    const resp = await ghFetch(searchUrl, env);
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const seen = new Map<string, string>();
      for (const item of data.items ?? []) {
        // path: manifests/{l}/{Publisher}/{Package}/{version}/...
        const m = item.path?.match(
          /^manifests\/[a-z]\/([^/]+)\/([^/]+)\/([^/]+)\//
        );
        if (m) {
          const id = `${m[1]}.${m[2]}`;
          if (!seen.has(id)) seen.set(id, m[3]);
        }
      }
      const results = [...seen.entries()]
        .slice(0, maxResults)
        .map(([id, version]) => ({
          PackageIdentifier: id,
          PackageName: id.split(".").slice(1).join(" "),
          Publisher: id.split(".")[0],
          Versions: [{ PackageVersion: version }],
        }));
      return Response.json({ Data: results });
    }
  }

  return Response.json({ Data: [] });
}

// ─── REST API: GET /packageManifests/{id}[/{version}] ────────────────────────

async function handlePackageManifest(
  id: string,
  requestedVersion: string | null,
  proxyBase: string,
  env: Env
): Promise<Response> {
  const { publisher, packageRest, basePath } = parsePackageId(id);

  let version: string;
  if (requestedVersion) {
    version = requestedVersion;
  } else {
    const resp = await ghFetch(`${WINGET_PKGS_API}/contents/${basePath}`, env);
    if (!resp.ok) {
      return Response.json(
        { ErrorCode: 404, ErrorMessage: `Package not found: ${id}` },
        { status: 404 }
      );
    }
    const entries = (await resp.json()) as any[];
    const versions = entries
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      .sort((a, b) => compareVersions(b, a));
    if (versions.length === 0) {
      return Response.json(
        { ErrorCode: 404, ErrorMessage: `No versions found: ${id}` },
        { status: 404 }
      );
    }
    version = versions[0];
  }

  const versionPath = `${basePath}/${version}`;
  const cdnBase = `${WINGET_PKGS_MANIFEST_BASE}/${versionPath}`;

  // Fetch installer YAML from Microsoft CDN (same path as GitHub, no API rate limits)
  const installerUrl = `${cdnBase}/${id}.installer.yaml`;
  let installerResp = await fetch(installerUrl, {
    headers: { "User-Agent": "winget-cn-proxy/2.0" },
    // @ts-ignore
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  let installerYaml: string;

  if (installerResp.ok) {
    installerYaml = await installerResp.text();
  } else {
    const singleResp = await fetch(`${cdnBase}/${id}.yaml`, {
      headers: { "User-Agent": "winget-cn-proxy/2.0" },
      // @ts-ignore
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (!singleResp.ok) {
      return Response.json(
        { ErrorCode: 404, ErrorMessage: `Manifest not found: ${id}@${version}` },
        { status: 404 }
      );
    }
    installerYaml = await singleResp.text();
  }

  // Fetch locale YAML for display metadata
  const localeResp = await fetch(`${cdnBase}/${id}.locale.en-US.yaml`, {
    headers: { "User-Agent": "winget-cn-proxy/2.0" },
    // @ts-ignore
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  const localeYaml = localeResp.ok ? await localeResp.text() : null;

  // Parse YAMLs
  let installerDoc: any = {};
  let localeDoc: any = {};
  try {
    installerDoc = (jsyaml.load(installerYaml) as any) ?? {};
  } catch { /* ignore parse errors */ }
  try {
    if (localeYaml) localeDoc = (jsyaml.load(localeYaml) as any) ?? {};
  } catch { /* ignore */ }

  // Build installers list with rewritten InstallerUrl
  const rawInstallers: any[] = Array.isArray(installerDoc.Installers)
    ? installerDoc.Installers
    : [];

  const installers = rawInstallers.map((inst) => ({
    ...inst,
    InstallerUrl: inst.InstallerUrl
      ? rewriteInstallerUrl(inst.InstallerUrl, proxyBase)
      : inst.InstallerUrl,
  }));

  return Response.json({
    Data: {
      PackageIdentifier: id,
      Versions: [
        {
          PackageVersion: version,
          DefaultLocale: {
            PackageLocale: "en-US",
            Publisher: localeDoc?.Publisher ?? installerDoc?.Publisher ?? publisher,
            PublisherUrl: localeDoc?.PublisherUrl ?? "",
            PackageName:
              localeDoc?.PackageName ??
              installerDoc?.PackageName ??
              `${publisher} ${packageRest}`,
            ShortDescription:
              localeDoc?.ShortDescription ?? localeDoc?.Description ?? "",
            License: localeDoc?.License ?? "",
            LicenseUrl: localeDoc?.LicenseUrl ?? "",
            Copyright: localeDoc?.Copyright ?? "",
          },
          Installers: installers,
          Locales: [],
        },
      ],
    },
  });
}

// ─── Landing page ─────────────────────────────────────────────────────────────

function landingPage(intlHost: string, cnHost: string): Response {
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
  .container { max-width: 860px; margin: 0 auto; }
  header { text-align: center; padding: 2rem 0 2.5rem; }
  header h1 { font-size: 2rem; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: .6rem; }
  header p { color: var(--muted); margin-top: .6rem; font-size: .95rem; }
  .badge-row { display: flex; gap: .75rem; flex-wrap: wrap; justify-content: center; margin-top: .75rem; font-size: .85rem; }
  .badge { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: .3rem .75rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: var(--accent); }
  .steps { display: flex; flex-direction: column; gap: .75rem; }
  .step { display: flex; gap: .75rem; }
  .step-num { width: 22px; height: 22px; border-radius: 50%; background: rgba(88,166,255,.2); color: var(--accent); font-size: .75rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; }
  .step-body { flex: 1; }
  .step-body p { font-size: .875rem; color: var(--muted); margin-bottom: .4rem; }
  .code-block { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: .65rem .9rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .82rem; display: flex; gap: .5rem; align-items: flex-start; }
  .code-block pre { flex: 1; margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--green); }
  .btn { background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: .35rem .75rem; font-size: .8rem; cursor: pointer; white-space: nowrap; }
  .btn:hover { color: var(--accent); border-color: var(--accent); }
  .note { font-size: .78rem; color: var(--muted); margin-top: .4rem; }
  .alert { background: rgba(255,166,0,.08); border: 1px solid rgba(255,166,0,.3); border-radius: 6px; padding: .65rem .9rem; font-size: .85rem; color: var(--yellow); margin-bottom: 1rem; }
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
    <p>基于 Cloudflare Workers · 加速 Windows Package Manager 安装器下载</p>
    <div class="badge-row">
      <span class="badge">🌐 国际线路：<code>${intlHost}</code></span>
      <span class="badge">🇨🇳 国内优选：<code>${cnHost}</code></span>
    </div>
  </header>

  <!-- Quick Start -->
  <div class="card">
    <h2>🚀 快速开始（推荐：Microsoft.Rest 模式）</h2>
    <div class="alert">⚡ 新版使用 <code>Microsoft.Rest</code> 源类型，安装器下载地址会通过本代理加速，真正解决国内下载慢的问题。</div>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>添加镜像源（国内优选推荐）：</p>
          <div class="code-block">
            <pre>winget source add --name winget-cn --arg https://${cnHost} --type Microsoft.Rest</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>安装软件（安装器自动走代理加速）：</p>
          <div class="code-block">
            <pre>winget install Git.Git --source winget-cn
winget install Mozilla.Firefox --source winget-cn
winget install SublimeHQ.SublimeText.4 --source winget-cn</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <p>搜索软件包：</p>
          <div class="code-block">
            <pre>winget search vscode --source winget-cn</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Set as default -->
  <div class="card">
    <h2>⭐ 设为默认源（替换官方源）</h2>
    <p style="color:var(--muted);font-size:.875rem;margin-bottom:1rem;">替换后无需加 <code>--source</code> 参数，所有 winget 操作自动走代理。</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>移除官方默认源：</p>
          <div class="code-block">
            <pre>winget source remove --name winget</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>以相同名称添加镜像源：</p>
          <div class="code-block">
            <pre>winget source add --name winget --arg https://${cnHost} --type Microsoft.Rest</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <p>之后直接使用 winget，无需 <code>--source</code>：</p>
          <div class="code-block">
            <pre>winget install Git.Git
winget upgrade --all</pre>
            <button class="btn" onclick="copyBlock(this)">复制</button>
          </div>
          <p class="note">⚠️ 恢复官方源：<code>winget source reset --force</code></p>
        </div>
      </div>
    </div>
  </div>

  <!-- Remove -->
  <div class="card">
    <h2>🔄 移除镜像源</h2>
    <div class="code-block">
      <pre>winget source remove --name winget-cn</pre>
      <button class="btn" onclick="copyBlock(this)">复制</button>
    </div>
  </div>

  <!-- How it works -->
  <div class="card">
    <h2>📡 工作原理</h2>
    <table>
      <thead><tr><th>端点</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td><code>GET /information</code></td><td>源元数据（Microsoft.Rest 协议）</td></tr>
        <tr><td><code>POST /manifestSearch</code></td><td>包搜索，后端为 microsoft/winget-pkgs</td></tr>
        <tr><td><code>GET /packageManifests/{id}</code></td><td>包清单，InstallerUrl 自动重写为代理地址</td></tr>
        <tr><td><code>GET /&lt;hostname&gt;/**</code></td><td>通用安装器透明代理（支持任意域名）</td></tr>
        <tr><td><code>GET /cache/**</code></td><td>CDN 索引透明代理（legacy）</td></tr>
      </tbody>
    </table>
  </div>

  <footer>Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a> &nbsp;·&nbsp; 数据来源：<a href="https://github.com/microsoft/winget-pkgs" target="_blank">microsoft/winget-pkgs</a></footer>
</div>
<script>
function copyBlock(btn) {
  const pre = btn.closest('.code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    const t = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = t, 1500);
  });
}
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, search } = url;
    const proxyBase = `${url.protocol}//${url.host}`;

    // Landing page
    if (pathname === "/" || pathname === "") {
      return landingPage("winget.lihongjie.cn", "winget.cn.lihongjie.cn");
    }

    // ── Microsoft.Rest API endpoints ────────────────────────────────────────
    if (pathname === "/information" && request.method === "GET") {
      return handleInformation();
    }
    // Debug: echo request body back (temporary, for diagnosing winget request format)
    if (pathname === "/debug/echo" && request.method === "POST") {
      const body = await request.text();
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    if (pathname === "/manifestSearch" && request.method === "POST") {
      return handleManifestSearch(request, env);
    }
    // /packageManifests/{id}  or  /packageManifests/{id}/{version}
    const mfMatch = pathname.match(
      /^\/packageManifests\/([^/]+)(?:\/([^/]+))?$/
    );
    if (mfMatch && request.method === "GET") {
      const id = decodeURIComponent(mfMatch[1]);
      const version = mfMatch[2] ? decodeURIComponent(mfMatch[2]) : null;
      return handlePackageManifest(id, version, proxyBase, env);
    }

    // ── Generic installer download proxy ────────────────────────────────────
    // Matches /<hostname>/path  (hostname must contain a dot)
    const domainMatch = DOMAIN_PREFIX_RE.exec(pathname);
    if (domainMatch) {
      const host = domainMatch[1];
      const rest = domainMatch[2] ?? "/";
      return proxyRequest(request, `https://${host}${rest}${search}`, proxyBase);
    }

    // ── Legacy: proxy everything else to winget CDN ──────────────────────────
    return proxyRequest(request, `${UPSTREAM_CDN}${pathname}${search}`, proxyBase);
  },
};
