/**
 * galaxy-data.mjs —— 记忆银河数据适配层
 *
 * 源库 dsh-Memory-Galaxy 的 lib/data.js 假设的数据路径在飞牛 NAS 上并不存在：
 *   它找 qq-bridge/state/memory/index.json 与 qq-bridge/state/memory/archive/*.jsonl，
 *   而实际布局是 qq-bridge/state/mind_graph.json（节点+边）与 qq-bridge/state/diary/*.md。
 *
 * 所以这里做一件事：把真实数据翻译成源库前端要的星体结构（stars / messages / meta）。
 * 排位算法（螺旋臂、分层、遗忘曲线）逐字沿用源库 lib/data.js 的 layout()，
 * 这样星图的「模样」与源库完全一致——只是数据换成了真实来源。
 *
 * 数据来源：
 *   1. qq-bridge/state/mind_graph.json  —— 主记忆库（memory.py 算出，含 level/weight/hits/evidence）
 *   2. qq-bridge/state/diary/*.md        —— 每日日记，按 ## 小节切条
 *   3. qq-bridge/state/qq-activity.log   —— 近期聊天消息（星尘）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const R = 1000;        // 银河半径
const ARMS = 4;        // 四条主旋臂（与源库一致）

// 各类型的遗忘半衰期 τ（天）。与源库 TAU 同表。
const TAU = {
  soul: 36500, user: 36500, person: 400, preference: 300, fact: 300, plan: 240,
  lesson: 400, topic: 300, event: 45, misc: 60, feeling: 150,
  digest_day: 999, digest_week: 999, digest_month: 999, impression: 300,
  rules: 240, project: 300,
};

// 原始类型 → 前端配色用的 kind（与源库 KIND 一致）
const KIND = {
  soul: 'identity', user: 'identity', rules: 'plan',
  person: 'fact', preference: 'fact', fact: 'fact', project: 'fact',
  plan: 'plan', lesson: 'conclusion', topic: 'conclusion',
  digest_day: 'conclusion', digest_week: 'conclusion', digest_month: 'conclusion',
  impression: 'conclusion', event: 'event', misc: 'event', feeling: 'feeling', diary: 'diary',
};

const now = () => Date.now();
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest();
const u01 = (b, i) => b[i % b.length] / 255;
const gauss = (b, i) => {
  const a = u01(b, i) || 0.5;
  const c = u01(b, i + 7) || 0.5;
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * c) * 0.5;
};

/* ---------------- 来源 1：主记忆库 mind_graph.json ---------------- */

// mind_graph.json 的 level（core/important/normal）→ 源库的 rawKind
// core 是身份类长期记忆（沉在核心球），important/normal 是事实类。
const LEVEL_KIND = {
  core: { rawKind: 'soul', kind: 'identity', weight: 4, pin: true },
  important: { rawKind: 'fact', kind: 'fact', weight: 3, pin: false },
  normal: { rawKind: 'event', kind: 'event', weight: 1, pin: false },
};

export function readMindGraph(file) {
  const out = [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  const nodes = Array.isArray(raw) ? raw : (raw.nodes ?? []);
  for (const n of nodes) {
    const text = String(n.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const spec = LEVEL_KIND[n.level] || LEVEL_KIND.normal;
    // hits 越高说明这条越常被想起 → 视为「最近被回忆过」，effAge 会被压小
    const hits = Number(n.hits) || 0;
    const updated = Number(n.updated) || Number(n.created) || now();
    const lastHitAt = hits > 0 ? updated * 1000 : 0;
    out.push({
      id: String(n.id ?? `mind-${out.length}`),
      rawKind: spec.rawKind,
      kind: spec.kind,
      weight: spec.weight,
      at: (Number(n.created) || now()) * 1000,
      lastHitAt,
      pin: spec.pin,
      title: text.slice(0, 60),
      text: text.slice(0, 420),
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 6) : [],
      source: 'qq-bridge',
    });
  }
  return out;
}

/* ---------------- 来源 2：日记 ---------------- */

export function readDiaries(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const day = f.replace(/\.md$/, '');
    let body;
    try {
      body = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    // 按 "## 小节" 切；没有 ## 的整篇当作一条
    const chunks = body.split(/\n(?=## )/);
    for (const chunk of chunks) {
      const head = (chunk.match(/^## (.+)$/m) || [])[1] || day;
      const text = chunk.replace(/^## .+$/m, '').replace(/^# .+$/m, '').trim();
      if (text.length < 8) continue;
      out.push({
        id: `diary-${day}-${hash(head).toString('hex').slice(0, 6)}`,
        rawKind: 'diary', kind: 'diary', weight: 2,
        at: new Date(`${day}T20:00:00+08:00`).getTime() || now(),
        lastHitAt: 0, pin: false,
        title: head.slice(0, 60),
        text: text.slice(0, 420),
        tags: [], source: 'qq-bridge',
      });
    }
  }
  return out;
}

/* ---------------- 来源 3：聊天消息（星尘） ---------------- */

// qq-activity.log 形如：[HH:MM:SS] private:991396812 [reserved2] 消息已入未读：正文
// 没有日期，只有时间。所以用文件 mtime 的日期补上——日志按天轮转（.log / .log.1），
// 每份文件用自己 mtime 的那一天，跨天的大致对得上。
export function readActivityLog(files) {
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let body;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let day = '';
    try {
      const mtime = fs.statSync(file).mtime;
      day = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}`;
    } catch {
      day = '';
    }
    for (const line of body.split('\n')) {
      const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const at = day ? new Date(`${day}T${m[1]}:${m[2]}:${m[3]}+08:00`).getTime() : now();
      const key = m[4];
      const rest = m[5];
      // 只收两种：收到的消息正文、机器人发出的消息
      let self = false;
      let text = '';
      const unread = rest.match(/消息已入未读：(.*)$/);
      if (unread) {
        text = unread[1];
      } else {
        const sent = rest.match(/发送语音\s+\S+/);
        if (sent) { self = true; text = '（语音）'; }
      }
      if (!text) continue;
      if (text.length > 60) text = text.slice(0, 60);
      out.push({ id: `msg-${out.length}`, key, at, self, text, source: 'qq-bridge' });
    }
  }
  return out;
}

/* ---------------- 排位：把星体摆成银河 ---------------- */
// 逐字沿用源库 lib/data.js 的 layout()，保证形态一致。
export function layout(input) {
  const t = now();
  const stars = input.stars.map((s) => {
    const tau = TAU[s.rawKind] ?? 240;
    const ageDays = Math.max(0, (t - s.at) / 86400000);
    const hitDays = s.lastHitAt ? Math.max(0, (t - s.lastHitAt) / 86400000) : null;
    const effAge = hitDays === null ? ageDays : Math.min(ageDays, hitDays * 0.55);
    const strength = Math.pow(s.weight, 1.5) * Math.exp(-effAge / tau);
    return { ...s, tau, ageDays: +ageDays.toFixed(2), hitDays: hitDays === null ? null : +hitDays.toFixed(2), strength };
  });

  // 分层：钉住/身份 → 核心；其余按强度排名 55/15/15
  const core = stars.filter((s) => s.pin || s.kind === 'identity');
  const rest = stars.filter((s) => !(s.pin || s.kind === 'identity')).sort((a, b) => b.strength - a.strength);
  for (const s of core) s.shell = 0;
  rest.forEach((s, i) => {
    const f = i / Math.max(1, rest.length - 1);
    s.shell = f < 0.55 ? 1 : f < 0.85 ? 2 : 3;
  });

  const SHELL_R = [[0.02, 0.11], [0.14, 0.44], [0.44, 0.72], [0.72, 1.0]];
  const all = [...core, ...rest];
  all.forEach((s, i) => {
    const h = hash(s.id + '|' + i);
    const [r0, r1] = SHELL_R[s.shell];
    const frac = 0.5 + 0.5 * u01(h, 3) + (s.shell === 0 ? 0 : 0.25 * (1 - Math.min(1, s.strength / 4)));
    const rr = Math.min(r1, r0 + (r1 - r0) * Math.min(1, frac * 0.85));
    const arm = Math.floor(u01(h, 5) * ARMS) % ARMS;
    const theta = (arm / ARMS) * Math.PI * 2 - 2.6 * Math.log(rr * 6 + 1) + (u01(h, 9) - 0.5) * 1.30;
    const radius = R * rr * (1 + (u01(h, 11) - 0.5) * (s.shell === 0 ? 0.12 : 0.26));
    const yScale = s.shell === 0 ? 0.20 : 0.055;
    s.arm = arm;
    s.r = +(radius / R).toFixed(4);
    s.x = +(Math.cos(theta) * radius).toFixed(2);
    s.z = +(Math.sin(theta) * radius).toFixed(2);
    s.y = +(gauss(h, 13) * R * yScale * Math.exp(-rr * 1.1) + (s.shell === 0 ? gauss(h, 17) * R * 0.05 : 0)).toFixed(2);
  });

  const messages = input.messages.map((m, i) => {
    const h = hash(`${m.key}:${m.at}:${i}`);
    const rr = 0.30 + Math.pow(u01(h, 2), 0.55) * 0.76;
    const arm = Math.floor(u01(h, 5) * ARMS) % ARMS;
    const theta = (arm / ARMS) * Math.PI * 2 - 2.6 * Math.log(rr * 6 + 1) + (u01(h, 9) - 0.5) * 1.35;
    const radius = R * rr;
    const ageDays = Math.max(0, (t - m.at) / 86400000);
    return {
      ...m, x: +(Math.cos(theta) * radius).toFixed(1),
      y: +(gauss(h, 13) * R * 0.075).toFixed(1),
      z: +(Math.sin(theta) * radius).toFixed(1),
      tau: +(24 + u01(h, 15) * 12).toFixed(1),
      ageDays: +ageDays.toFixed(2),
    };
  });

  const counts = {};
  for (const s of stars) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const bySource = {};
  for (const s of [...stars, ...messages]) bySource[s.source] = (bySource[s.source] || 0) + 1;
  const sources = {
    memory: stars.filter((s) => s.kind !== 'diary').length,
    diary: stars.filter((s) => s.kind === 'diary').length,
    message: messages.length,
    bySource,
  };

  return {
    meta: {
      generatedAt: t, radius: R, arms: ARMS,
      total: stars.length, pinned: stars.filter((s) => s.pin).length,
      messages: messages.length, counts, sources,
      avgStrength: +(stars.reduce((a, s) => a + s.strength, 0) / Math.max(1, stars.length)).toFixed(3),
    },
    stars, messages,
  };
}

/* ---------------- 统一入口 ---------------- */

export function buildGalaxy(cfg = {}) {
  const stars = [];
  const messages = [];

  if (cfg.mindGraph) stars.push(...readMindGraph(cfg.mindGraph));
  if (cfg.diaryDir) stars.push(...readDiaries(cfg.diaryDir));
  if (cfg.activityLogs) messages.push(...readActivityLog(cfg.activityLogs));

  return layout({ stars, messages });
}
