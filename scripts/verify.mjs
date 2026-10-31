#!/usr/bin/env node
/**
 * Feiyu Hub 自检脚本
 *
 * 用法：
 *   node scripts/verify.mjs                       # 自动读同目录上级的 config.json
 *   node scripts/verify.mjs --url http://1.2.3.4:18765
 *   node scripts/verify.mjs --json                # 机器可读（给 AI / CI 用）
 *
 * 退出码：0 = 全部关键检查通过；1 = 有 FAIL
 * 注意：单个上游服务离线只算 WARN，不算部署失败——上游本来就可能没装。
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.resolve(process.env.FEIYU_CONFIG || path.join(ROOT, 'config.json'));
const VERSION = '1.0.1';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const JSON_OUT = flag('--json');
const TIMEOUT = Number(opt('--timeout', 8000));
const URL_GIVEN = !!opt('--url', '');
let BASE = opt('--url', '');

const checks = [];
function add(name, status, detail) { checks.push({ name, status, detail: String(detail) }); }

function req(urlStr, timeoutMs, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, err: 'bad url', ms: 0 }); }
    const t0 = Date.now();
    const r = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: timeoutMs || TIMEOUT,
      headers: Object.assign({ 'user-agent': `feiyu-hub-verify/${VERSION}` }, headers || {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 400000) body += d; });
      res.on('end', () => resolve({
        ok: true, status: res.statusCode, body, ms: Date.now() - t0, headers: res.headers,
      }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t0 }); });
    r.on('error', (e) => resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
    r.end();
  });
}

async function readConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const raw = await readConfig();

  if (!BASE) {
    const port = (raw && Number(raw.port)) || 18765;
    BASE = `http://127.0.0.1:${port}`;
  }
  BASE = BASE.replace(/\/+$/, '');

  const authHeader = {};
  if (raw && raw.auth && raw.auth.password) {
    authHeader.authorization = 'Basic ' + Buffer.from(`${raw.auth.user || 'admin'}:${raw.auth.password}`).toString('base64');
  }

  if (!JSON_OUT) {
    console.log(`Feiyu Hub verify v${VERSION}`);
    console.log(`配置: ${raw ? CONFIG_PATH : (URL_GIVEN ? '(未读到 config.json，按 --url 探测)' : '(未读到 config.json，按默认端口探测)')}`);
    console.log(`目标: ${BASE}\n`);
  }

  // 1. 面板存活
  const ping = await req(BASE + '/api/ping', TIMEOUT, authHeader);
  if (!ping.ok || ping.status !== 200) {
    add('panel /api/ping', 'fail', ping.err || `HTTP ${ping.status}`);
    return finish();
  }
  let pingBody = {};
  try { pingBody = JSON.parse(ping.body); } catch { /* ignore */ }
  add('panel /api/ping', 'pass', `ok ${ping.ms}ms, version ${pingBody.version || '?'}`);

  // 2. 配置加载情况
  const cfgRes = await req(BASE + '/api/config', TIMEOUT, authHeader);
  let cfg = null;
  if (cfgRes.ok && cfgRes.status === 200) {
    try { cfg = JSON.parse(cfgRes.body); } catch { /* ignore */ }
  }
  if (!cfg) {
    add('config', 'fail', cfgRes.err || `HTTP ${cfgRes.status}`);
  } else if (!cfg.loaded) {
    add('config', 'warn', '使用了内置默认配置（面板为空）——检查 config.json 路径/格式');
  } else {
    const w = Array.isArray(cfg.warnings) ? cfg.warnings.length : 0;
    add('config', w ? 'warn' : 'pass',
      `${cfg.path} · ${cfg.services.length} 个服务 · ${w} 条警告`);
    if (w) for (const x of cfg.warnings.slice(0, 8)) add('  config warning', 'warn', x);
  }

  // 3. 静态资源 / PWA
  for (const [label, p, want] of [
    ['静态首页 /', '/', 200],
    ['PWA manifest', '/manifest.json', 200],
    ['图标 icon-192', '/icon-192.png', 200],
    ['SW sw.js', '/sw.js', 200],
  ]) {
    const r = await req(BASE + p, TIMEOUT, authHeader);
    add(label, r.ok && r.status === want ? 'pass' : 'fail',
      r.ok ? `HTTP ${r.status} ${r.ms}ms ${(r.body || '').length}B` : (r.err || 'error'));
  }

  // 4. 服务清单与上游可达性
  const svcRes = await req(BASE + '/api/services', 30000, authHeader);
  let svc = null;
  if (svcRes.ok && svcRes.status === 200) {
    try { svc = JSON.parse(svcRes.body); } catch { /* ignore */ }
  }
  if (!svc) {
    add('services api', 'fail', svcRes.err || `HTTP ${svcRes.status}`);
  } else if (!svc.services.length) {
    add('services', 'warn', '还没有配置任何服务（编辑 config.json 的 services 数组）');
  } else {
    const up = svc.services.filter((s) => s.alive).length;
    add('services', up === svc.services.length ? 'pass' : 'warn',
      `${up}/${svc.services.length} 在线`);
    for (const s of svc.services) {
      add(`  ${s.id}`, s.alive ? 'pass' : 'warn',
        s.alive ? `${s.code} ${s.ms}ms ${s.url}` : `离线 ${s.err || ''} -> ${s.url}`);
    }
  }

  // 5. 反代端口独立探测（即使上游挂了，代理端口本身必须能连上）
  if (cfg && Array.isArray(cfg.services)) {
    const host = new URL(BASE).hostname;
    for (const s of cfg.services.filter((x) => x.proxyPort)) {
      const r = await req(`http://${host}:${s.proxyPort}/healthz`, 4000, authHeader);
      // 上游可能没有 /healthz，只要不是连接层错误就算端口活着
      const reachable = r.ok || !['ECONNREFUSED', 'timeout', 'EHOSTUNREACH'].includes(r.err);
      add(`反代端口 :${s.proxyPort} (${s.id})`, reachable ? 'pass' : 'fail',
        r.ok ? `HTTP ${r.status}` : (r.err || 'error'));
    }
  }

  return finish();
}

function finish() {
  const pass = checks.filter((c) => c.status === 'pass').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const ok = fail === 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok, target: BASE, version: VERSION, configPath: CONFIG_PATH,
      checks, summary: { pass, warn, fail },
    }, null, 2));
  } else {
    for (const c of checks) {
      const tag = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
      console.log(`[${tag}] ${c.name.padEnd(28)} ${c.detail}`);
    }
    console.log(`\n汇总: ${pass} 通过 / ${warn} 警告 / ${fail} 失败`);
    if (ok) console.log('结论: 部署正常 ✅');
    else console.log('结论: 有检查未通过，按上面 FAIL 行排查 ❌');
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  add('verify 自身', 'fail', e.stack || String(e));
  finish();
});
