#!/usr/bin/env node
/**
 * Feiyu Hub — 零依赖的服务聚合看板 + 反代
 *
 * 设计要点：
 *   1. 所有服务清单、端口、密钥、token 来源都放在 config.json，代码里零硬编码。
 *   2. 单进程多端口：主面板 + 每个需要注入凭据的反代各占一个端口。
 *      （不能用 /sub/ 子路径反代：上游常带 X-Frame-Options: DENY 与绝对路径资源）
 *   3. 凭据在服务端注入，浏览器地址栏永远干净，也不会出现 302 死循环。
 *   4. 缺失配置时降级运行并给出警告，不崩溃。
 *
 * 启动：node server.mjs
 * 配置：默认读同目录 config.json，可用环境变量 FEIYU_CONFIG 指定其他路径
 */

import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const CONFIG_PATH = path.resolve(process.env.FEIYU_CONFIG || path.join(ROOT, 'config.json'));
const VERSION = '1.0.0';
const LOCAL = '127.0.0.1';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), '[warn]', ...a);

/* ------------------------------------------------------------------ 配置 */

const DEFAULT_CONFIG = {
  site: {
    name: '肥鱼控制中心',
    shortName: '肥鱼',
    subtitle: 'feiyu hub',
    footer: 'feiyu hub',
  },
  bind: '0.0.0.0',
  port: 18765,
  auth: null,
  tokens: {},
  services: [],
};

/** 把字符串里的 ${ENV_NAME} 换成环境变量，方便用环境变量放密码而不落盘 */
function expandEnv(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) =>
    process.env[k] !== undefined ? process.env[k] : '');
}

function expandDeep(v) {
  if (Array.isArray(v)) return v.map(expandDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = expandDeep(x);
    return out;
  }
  return expandEnv(v);
}

function intOr(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : dflt;
}

/**
 * 校验并规范化配置。任何非法项只记 warning 并跳过，不抛异常——
 * 朋友的机器上配错一个字段，不应该导致整个面板起不来。
 */
function normalizeConfig(raw) {
  const warnings = [];
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (!raw || typeof raw !== 'object') {
    // loadConfig 对「文件不存在/解析失败」已经提示过了，这里不再重复告警
    if (raw !== null && raw !== undefined) warnings.push('config 不是对象，使用内置默认值');
    return { cfg, warnings };
  }

  const site = raw.site && typeof raw.site === 'object' ? raw.site : {};
  cfg.site = {
    name: String(site.name || DEFAULT_CONFIG.site.name),
    shortName: String(site.shortName || site.name || DEFAULT_CONFIG.site.shortName),
    subtitle: String(site.subtitle || DEFAULT_CONFIG.site.subtitle),
    footer: String(site.footer || DEFAULT_CONFIG.site.footer),
  };

  cfg.bind = typeof raw.bind === 'string' && raw.bind ? raw.bind : '0.0.0.0';
  cfg.port = intOr(raw.port, 18765);

  if (raw.auth && raw.auth.user) {
    const pw = String(raw.auth.password || '');
    if (!pw) {
      // 配了用户名却没配密码：直接不启用，免得 /api/config 里显示 enabled:true 骗人
      warnings.push('auth.user 已配置但 auth.password 为空，鉴权不会生效');
    } else {
      cfg.auth = {
        user: String(raw.auth.user),
        password: pw,
        realm: String(raw.auth.realm || 'Feiyu Hub'),
      };
    }
  }

  if (raw.tokens && typeof raw.tokens === 'object') {
    for (const [id, spec] of Object.entries(raw.tokens)) {
      if (id.startsWith('_')) continue;  // 配置里的说明性键
      if (!spec || typeof spec !== 'object') { warnings.push(`tokens.${id} 不是对象，已跳过`); continue; }
      if (spec.type === 'file' && spec.path) {
        cfg.tokens[id] = { type: 'file', path: String(spec.path) };
      } else if (spec.type === 'command' && (spec.cmd || spec.args)) {
        cfg.tokens[id] = {
          type: 'command',
          cmd: String(spec.cmd || 'sudo'),
          args: Array.isArray(spec.args) ? spec.args.map(String) : [],
          regex: String(spec.regex || '([A-Za-z0-9_-]{20,})'),
          pick: spec.pick === 'first' ? 'first' : 'last',
          ttlSec: intOr(spec.ttlSec, 300),
          timeoutMs: intOr(spec.timeoutMs, 12000),
        };
      } else {
        warnings.push(`tokens.${id} 缺少 type/path 或 cmd，已跳过`);
      }
    }
  }

  const seen = new Set();
  const usedProxyPorts = new Set();
  const list = Array.isArray(raw.services) ? raw.services : [];
  if (!list.length) warnings.push('services 为空，面板会显示为空白（编辑 config.json 添加服务）');

  for (const [i, s] of list.entries()) {
    if (!s || typeof s !== 'object') { warnings.push(`services[${i}] 不是对象，已跳过`); continue; }
    const id = String(s.id || '').trim();
    const name = String(s.name || '').trim();
    if (!id || !name) { warnings.push(`services[${i}] 缺少 id 或 name，已跳过`); continue; }
    if (seen.has(id)) { warnings.push(`services 里 id 重复: ${id}，已跳过后者`); continue; }
    if (s.enabled === false) continue;

    const type = s.type === 'proxy' ? 'proxy' : 'direct';
    const svc = {
      id,
      name,
      desc: String(s.desc || ''),
      group: String(s.group || '服务'),
      accent: String(s.accent || 'blue'),
      badge: String(s.badge || ''),
      icon: String(s.icon || id),
      type,
      path: String(s.path || '/'),
      probePath: String(s.probePath || s.path || '/'),
      probeTimeoutMs: intOr(s.probeTimeoutMs, 2500),
      probeWithToken: !!s.probeWithToken,
      secret: expandEnv(String(s.secret || '')),
      secretLabel: String(s.secretLabel || '密钥'),
      autocopy: !!s.autocopy,
      openInNewTab: s.openInNewTab !== false,
      url: s.url ? String(s.url) : '',
    };

    if (type === 'proxy') {
      const up = s.upstream || {};
      const upPort = intOr(up.port, 0);
      const proxyPort = intOr(s.proxyPort, 0);
      if (!upPort) { warnings.push(`services[${i}] (${id}) proxy 类型缺少 upstream.port，已跳过`); continue; }
      if (!proxyPort) { warnings.push(`services[${i}] (${id}) proxy 类型缺少 proxyPort，已跳过`); continue; }
      if (usedProxyPorts.has(proxyPort) || proxyPort === cfg.port) {
        warnings.push(`services[${i}] (${id}) proxyPort ${proxyPort} 与已有端口冲突，已跳过`);
        continue;
      }
      usedProxyPorts.add(proxyPort);
      svc.proxyPort = proxyPort;
      svc.upstream = {
        host: String(up.host || LOCAL),
        port: upPort,
        probePath: String(up.probePath || '/'),
      };
      svc.inject = s.inject && typeof s.inject === 'object'
        ? { kind: String(s.inject.kind || 'none'), tokenId: String(s.inject.tokenId || '') }
        : { kind: 'none', tokenId: '' };
      if (svc.inject.kind === 'query-token' && !cfg.tokens[svc.inject.tokenId]) {
        warnings.push(`services.${id}.inject.tokenId="${svc.inject.tokenId}" 在 tokens 里不存在，该代理不会注入凭据`);
      }
    } else {
      svc.port = intOr(s.port, 0);
      if (!svc.port && !svc.url) { warnings.push(`services[${i}] (${id}) direct 类型缺少 port，已跳过`); continue; }
    }

    seen.add(id);
    cfg.services.push(svc);
  }

  return { cfg, warnings };
}

let cfg = DEFAULT_CONFIG;
let warnings = [];
let proxyServers = [];       // [{id, proxyPort, server}]
let lastProxySignature = '';

function proxySignature(c) {
  return (c.services || [])
    .filter((s) => s.type === 'proxy')
    .map((s) => `${s.id}:${s.proxyPort}:${s.upstream.host}:${s.upstream.port}`)
    .join('|');
}

async function loadConfig() {
  let raw = null;
  try {
    const txt = await fsp.readFile(CONFIG_PATH, 'utf8');
    raw = JSON.parse(txt);
    // 全字段支持 ${ENV_NAME}，密码/token 路径可以不落盘
    raw = expandDeep(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      warn(`没有找到 ${CONFIG_PATH}，使用内置默认配置（面板为空）`);
      warn('提示：把 config.example.json 复制成 config.json 再填服务清单');
    } else if (e instanceof SyntaxError) {
      warn(`config.json 不是合法 JSON: ${e.message}`);
      warn('面板会以空白状态启动，修好配置后访问 /api/reload 生效');
    } else {
      warn(`读取配置失败: ${e.message}`);
    }
  }
  const norm = normalizeConfig(raw);
  cfg = norm.cfg;
  warnings = norm.warnings;
  for (const w of warnings) warn(w);
  lastProxySignature = proxySignature(cfg);
  return cfg;
}

/* ---------------------------------------------------------------- tokens */

const tokenState = new Map(); // id -> {value, at, inflight}

function tokenEntry(id) {
  if (!tokenState.has(id)) tokenState.set(id, { value: '', at: 0, inflight: null });
  return tokenState.get(id);
}

async function readToken(id, force = false) {
  const spec = cfg.tokens[id];
  if (!spec) return '';
  const st = tokenEntry(id);

  if (spec.type === 'file') {
    try {
      const t = (await fsp.readFile(spec.path, 'utf8')).trim();
      if (t && t !== st.value) log(`token[${id}] 已加载 len=${t.length}`);
      st.value = t;
      st.at = Date.now();
    } catch (e) {
      if (st.value === '') warn(`token[${id}] 读取失败 ${spec.path}: ${e.message}`);
    }
    return st.value;
  }

  // command 型：带 TTL 缓存 + 并发去重
  const fresh = st.value && Date.now() - st.at < spec.ttlSec * 1000;
  if (!force && fresh) return st.value;
  if (st.inflight) return st.inflight;

  st.inflight = new Promise((resolve) => {
    execFile(spec.cmd, spec.args, { maxBuffer: 32 * 1024 * 1024, timeout: spec.timeoutMs }, (err, stdout) => {
      st.inflight = null;
      if (err) {
        warn(`token[${id}] 命令执行失败: ${err.message}`);
        return resolve(st.value);
      }
      let hits = [];
      try {
        const re = new RegExp(spec.regex, 'g');
        hits = [...String(stdout).matchAll(re)].map((m) => m[1]).filter(Boolean);
      } catch (e) {
        warn(`token[${id}] 正则非法: ${e.message}`);
      }
      if (hits.length) {
        const picked = spec.pick === 'first' ? hits[0] : hits[hits.length - 1];
        if (picked !== st.value) log(`token[${id}] 已刷新 len=${picked.length}`);
        st.value = picked;
        st.at = Date.now();
      } else {
        warn(`token[${id}] 命令输出里没有匹配到凭据（regex=${spec.regex}）`);
      }
      resolve(st.value);
    });
  });
  return st.inflight;
}

async function refreshAllTokens(force = false) {
  await Promise.all(Object.keys(cfg.tokens).map((id) => readToken(id, force).catch(() => '')));
}

/* ---------------------------------------------------------------- 探活 */

function probe(target, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      host: target.host || LOCAL,
      port: target.port,
      path: target.path || '/',
      method: 'GET',
      timeout: timeoutMs || 2500,
      headers: Object.assign({ 'user-agent': `feiyu-hub/${VERSION}` }, target.headers || {}),
    }, (res) => {
      res.resume();
      res.on('end', () => finish({
        alive: res.statusCode > 0 && res.statusCode < 500,
        code: res.statusCode,
        ms: Date.now() - t0,
      }));
    });
    req.on('timeout', () => { req.destroy(); finish({ alive: false, code: 0, ms: Date.now() - t0, err: 'timeout' }); });
    req.on('error', (e) => finish({ alive: false, code: 0, ms: Date.now() - t0, err: e.code || e.message }));
    req.end();
  });
}

/* --------------------------------------------------------------- 地址解析 */

function clientHost(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return raw.replace(/:\d+$/, '') || LOCAL;
}

function clientProto(req) {
  const p = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (p === 'https' || p === 'http') return p;
  return 'http';
}

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function resolveUrl(svc, req) {
  const host = clientHost(req);
  const proto = clientProto(req);
  const vars = {
    host,
    proto,
    port: svc.type === 'proxy' ? svc.proxyPort : svc.port,
    path: svc.path || '/',
  };
  if (svc.url) return fillTemplate(svc.url, vars);
  if (svc.type === 'proxy') return `${proto}://${host}:${svc.proxyPort}${svc.path || '/'}`;
  return `${proto}://${host}:${svc.port}${svc.path || '/'}`;
}

/* --------------------------------------------------------------- 服务列表 */

let cache = { at: 0, forHost: '', payload: null };
const CACHE_MS = 1200;

async function buildServices(req) {
  const host = clientHost(req);
  if (cache.payload && Date.now() - cache.at < CACHE_MS && cache.forHost === host) return cache.payload;

  const list = await Promise.all(cfg.services.map(async (s) => {
    let st;
    try {
      if (s.type === 'proxy') {
        const reqPath = s.upstream.probePath || '/';
        let p = reqPath;
        if (s.probeWithToken && s.inject && s.inject.kind === 'query-token' && s.inject.tokenId) {
          const t = await readToken(s.inject.tokenId);
          if (t) p += (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
        }
        st = await probe({ host: s.upstream.host, port: s.upstream.port, path: p }, s.probeTimeoutMs);
      } else {
        let p = s.probePath || '/';
        st = await probe({ host: LOCAL, port: s.port, path: p }, s.probeTimeoutMs);
      }
    } catch (e) {
      st = { alive: false, code: 0, ms: 0, err: e.message };
    }
    return {
      id: s.id, name: s.name, desc: s.desc, group: s.group,
      accent: s.accent, badge: s.badge, icon: s.icon,
      url: resolveUrl(s, req),
      type: s.type,
      alive: st.alive, code: st.code, ms: st.ms, err: st.err || '',
      secret: s.secret || '', secretLabel: s.secretLabel || '', autocopy: !!s.autocopy,
      openInNewTab: s.openInNewTab,
    };
  }));

  const payload = { site: cfg.site, host, port: cfg.port, version: VERSION, services: list, at: Date.now() };
  cache = { at: Date.now(), forHost: host, payload };
  return payload;
}

/* ------------------------------------------------------------------ 反代 */

function upstreamHeaders(inHeaders, target) {
  const out = {};
  const host = target.host + ':' + target.port;
  for (const [k, v] of Object.entries(inHeaders)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'connection' || lk === 'upgrade') continue;
    out[k] = v;
  }
  out.host = host;
  out.origin = 'http://' + host;
  if (inHeaders.referer) {
    try {
      const u = new URL(inHeaders.referer);
      out.referer = 'http://' + host + u.pathname + u.search;
    } catch { out.referer = 'http://' + host + '/'; }
  }
  out['x-forwarded-host'] = String(inHeaders.host || '');
  out['x-forwarded-proto'] = 'http';
  return out;
}

/** 抹掉 Set-Cookie 的 Domain，让 cookie 跟随浏览器实际访问的主机名 */
function rewriteCookie(raw) {
  return String(raw)
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.replace(/;\s*domain=[^;]*/gi, ''))
    .join(',');
}

function hasAuthCookie(cookie, id) {
  return new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-auth-[^=]+=').test(cookie);
}

function makeProxyServer(svc) {
  const target = svc.upstream;
  const label = svc.id;

  const server = http.createServer(async (req, res) => {
    try {
      let upPath = req.url;
      const cookie = String(req.headers.cookie || '');

      if (svc.inject.kind === 'query-token' && svc.inject.tokenId) {
        // 服务端注入：浏览器地址栏永远不含 token，也就不会出现「无 cookie 就无限 302」
        if (!req.url.includes('token=') && !hasAuthCookie(cookie, svc.inject.tokenId)) {
          const t = await readToken(svc.inject.tokenId);
          if (t) upPath += (req.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
        }
      }

      const headers = upstreamHeaders(req.headers, target);
      const up = http.request({
        host: target.host, port: target.port, method: req.method, path: upPath, headers,
      }, (r2) => {
        const h = Object.assign({}, r2.headers);
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map(rewriteCookie);
        res.writeHead(r2.statusCode || 502, h);
        r2.pipe(res);
      });
      up.on('error', (e) => {
        log(`${label} 上游错误: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('upstream unreachable: ' + e.message);
      });
      req.pipe(up);
    } catch (e) {
      log(`${label} 处理异常: ${e.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proxy error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const headers = upstreamHeaders(req.headers, target);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    let wsPath = req.url;
    const wsCookie = String(req.headers.cookie || '');
    if (svc.inject.kind === 'query-token' && svc.inject.tokenId
      && !req.url.includes('token=') && !hasAuthCookie(wsCookie, svc.inject.tokenId)) {
      const t = tokenEntry(svc.inject.tokenId).value;
      if (t) wsPath += (req.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
    }
    const up = http.request({
      host: target.host, port: target.port, method: 'GET', path: wsPath, headers,
    });
    up.on('upgrade', (r2, upSocket, upHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [k, v] of Object.entries(r2.headers)) {
        if (Array.isArray(v)) v.forEach((x) => lines.push(k + ': ' + x));
        else lines.push(k + ': ' + v);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    up.on('error', (e) => { log(`${label} ws 错误: ${e.message}`); socket.destroy(); });
    up.end();
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function listen(server, port, bind, label) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`${label} 端口 ${port} 已被占用（换一个端口，或先停掉占用的进程）`));
      } else reject(e);
    };
    server.once('error', onErr);
    server.listen(port, bind, () => {
      server.removeListener('error', onErr);
      log(`${label} 监听 ${bind}:${port}`);
      resolve();
    });
  });
}

/**
 * Windows 允许多个进程「同时监听」同一端口而不报 EADDRINUSE，
 * 后启动的那个会像个黑洞：能起来，但请求全被先启动的进程吃掉。
 * 所以启动前主动连一下，能连上就说明已经有人在那了，直接报错退出更诚实。
 */
function portAlreadyServing(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: LOCAL, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.setTimeout(600, () => finish(false));
  });
}

async function assertPortsFree(ports) {
  for (const [port, label] of ports) {
    if (await portAlreadyServing(port)) {
      throw new Error(`${label} 端口 ${port} 已经有服务在监听——`
        + '不是本程序就是别的程序占用。改 config.json 里的端口，或先把占用者停掉。');
    }
  }
}

/* ------------------------------------------------------------------ 静态 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function serveStatic(res, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUB, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

/* -------------------------------------------------------------------- 鉴权 */

function checkAuth(req, res) {
  if (!cfg.auth || !cfg.auth.password) return true;
  const got = String(req.headers.authorization || '');
  const want = 'Basic ' + Buffer.from(`${cfg.auth.user}:${cfg.auth.password}`).toString('base64');
  if (got === want) return true;
  res.writeHead(401, {
    'www-authenticate': `Basic realm="${cfg.auth.realm}", charset="UTF-8"`,
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('需要登录');
  return false;
}

/* --------------------------------------------------------------- 主应用 */

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (!checkAuth(req, res)) return;

    if (p === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: VERSION, ts: Date.now() }));
    }

    if (p === '/api/services') {
      await refreshAllTokens(false);
      const data = await buildServices(req);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(data));
    }

    if (p === '/api/refresh') {
      await refreshAllTokens(true);
      cache.at = 0;
      const lens = {};
      for (const id of Object.keys(cfg.tokens)) lens[id] = tokenEntry(id).value.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tokens: lens }));
    }

    if (p === '/api/config') {
      // 脱敏摘要：绝不返回 secret / password / token 内容
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        path: CONFIG_PATH,
        loaded: cfg !== DEFAULT_CONFIG,
        site: cfg.site,
        bind: cfg.bind,
        port: cfg.port,
        auth: cfg.auth ? { user: cfg.auth.user, enabled: true } : { enabled: false },
        tokens: Object.keys(cfg.tokens),
        services: cfg.services.map((s) => ({
          id: s.id, name: s.name, type: s.type,
          target: s.type === 'proxy' ? `${s.upstream.host}:${s.upstream.port}` : `127.0.0.1:${s.port}`,
          proxyPort: s.proxyPort || null,
          hasSecret: !!s.secret,
        })),
        warnings,
      }, null, 2));
    }

    if (p === '/api/reload') {
      await loadConfig();
      await refreshAllTokens(true);
      cache.at = 0;
      const sigChanged = proxySignature(cfg) !== lastProxySignature;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        services: cfg.services.length,
        warnings,
        restartRequired: sigChanged,
        note: sigChanged ? '反代端口/上游有变化，需要重启进程才能生效' : '已热加载',
      }));
    }

    if (p === '/api/diag') {
      const tokens = {};
      for (const id of Object.keys(cfg.tokens)) {
        const st = tokenEntry(id);
        tokens[id] = {
          len: st.value.length,
          ageSec: st.at ? Math.round((Date.now() - st.at) / 1000) : null,
        };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        version: VERSION,
        node: process.version,
        port: cfg.port,
        bind: cfg.bind,
        uptimeSec: Math.round(process.uptime()),
        configPath: CONFIG_PATH,
        configLoaded: cfg !== DEFAULT_CONFIG,
        services: cfg.services.length,
        proxy: proxyServers.map((x) => ({ id: x.id, port: x.proxyPort })),
        tokens,
        warnings,
      }, null, 2));
    }

    // PWA manifest 由配置动态生成，改 config.site 就能换品牌，不用改静态文件
    if (p === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({
        name: cfg.site.name,
        short_name: cfg.site.shortName,
        description: cfg.site.subtitle || '自托管服务统一入口',
        start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
        background_color: '#0a0d13', theme_color: '#0a0d13', lang: 'zh-CN',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }, null, 2));
    }

    if (p === '/') return serveStatic(res, 'index.html');
    return serveStatic(res, p.replace(/^\//, ''));
  } catch (e) {
    log('app 异常: ' + e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal error');
  }
});

/* ------------------------------------------------------------------ 启动 */

async function startProxies() {
  proxyServers = [];
  for (const s of cfg.services.filter((x) => x.type === 'proxy')) {
    const srv = makeProxyServer(s);
    await listen(srv, s.proxyPort, cfg.bind, `反代 ${s.id} -> ${s.upstream.host}:${s.upstream.port}`);
    proxyServers.push({ id: s.id, proxyPort: s.proxyPort, server: srv });
  }
}

async function main() {
  log(`Feiyu Hub v${VERSION} · node ${process.version}`);
  log(`配置: ${CONFIG_PATH}`);
  await loadConfig();
  await refreshAllTokens(true).catch(() => {});
  await assertPortsFree([
    [cfg.port, '面板'],
    ...cfg.services.filter((s) => s.type === 'proxy').map((s) => [s.proxyPort, `反代 ${s.id}`]),
  ]);
  await listen(app, cfg.port, cfg.bind, '面板');
  await startProxies();

  setInterval(() => { refreshAllTokens(false).catch(() => {}); }, 60 * 1000);
  log('就绪');
}

process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + e));
process.on('SIGTERM', () => { log('SIGTERM，退出'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT，退出'); process.exit(0); });

main().catch((e) => { log('启动失败: ' + (e && e.stack || e)); process.exit(1); });
