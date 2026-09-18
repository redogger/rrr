/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v10.4 — AJAX + 10s Early Detection (hardened)
 *  ---------------------------------------------------------------------------
 *  v10.4 changelog:
 *   ✅ FIX #1: State saved BEFORE any network op → survives login failure
 *   ✅ FIX #2: TG notification on fatal crash with error text
 *   ✅ FIX #3: Login failure dumps page text + auto-classifies cause
 *   ✅ FIX #4: watcher.yml dumps state on failure (see workflow)
 *   ✅ NEW:   Auto-resume if paused from previous run
 *   ✅ NEW:   Multi-selector login (4 attempts, backoff+jitter)
 *   ✅ NEW:   Login failure taxonomy (captcha/creds/locked/maintenance)
 *   ✅ NEW:   counters.loginFailures + state.lastError diagnostics
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  USER CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const USER_CONFIG = {
  targetCourse:         'GEN 101',
  targetCourseId:       null,
  targetIsLectureOnly:  true,
  expectedCourses:      ['MEC151', 'BAS111', 'CIV111', 'CIV121', 'CIV131'],
  preferredGroups:      [],

  earlyDetectionIntervalMs: 10 * 1000,
  sniperIntervalMs:         10 * 1000,
  securityIntervalMs:       10 * 60 * 1000,
  telegramPollMs:           3  * 1000,
  heartbeatMs:              500,

  earlyDetectionEnabled:    true,
  notifyWithSound:          true,
  maxTelegramPerMin:        20,
  startupBriefHours:        12,
  sessionRenewEveryMs:      12 * 60 * 1000,

  loginMaxAttempts:         4,
  loginBaseDelayMs:         2_000,
};

// ═══════════════════════════════════════════════════════════════════════════
//  RUNTIME CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  baseUrl:        'https://dulms.deltauniv.edu.eg',
  loginUrl:       'https://dulms.deltauniv.edu.eg/Login.aspx',
  coursesPageUrl: 'https://dulms.deltauniv.edu.eg/Registered/CoursesRegisteration',

  API: {
    coursesList:    '/Registered/GetStudentResiterationCourses',
    courseSchedule: '/Registered/GetCourseSchedual',
    regInfo:        '/Registered/GetStudentResiterationInfo',
  },

  username:    process.env.DULMS_USERNAME || '',
  password:    process.env.DULMS_PASSWORD || '',
  tgToken:     process.env.TG_TOKEN       || '',
  tgChatId:    String(process.env.TG_CHAT_ID || ''),
  durationMin: parseFloat(process.env.DURATION_MIN || '50'),

  cookieMaxAgeMin: 15,
  netTimeoutMs:    15_000,
  pageTimeoutMs:   60_000,
  memWarnMb:       700,
  memRestartMb:    900,

  stateFile:       path.join(process.cwd(), '.dulms-state.json'),
  sessionFile:     path.join(process.cwd(), '.dulms-session.json'),
  sessionMetaFile: path.join(process.cwd(), '.dulms-session-meta.json'),
  auditFile:       path.join(process.cwd(), '.dulms-audit.log'),
  auditMaxBytes:   1 * 1024 * 1024,

  tgMessageMaxChars: 3800,

  timezone:     'Africa/Cairo',
  stateVersion: 104,
  versionLabel: 'v10.4.0',
};

const RESULT = Object.freeze({ COMPLETED: 'completed', REBUILD: 'rebuild', FATAL: 'fatal' });

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════════════════
const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  ok:   (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  warn: (...a) => console.warn (`[${ts()}] [WARN]`, ...a),
  err:  (...a) => console.error(`[${ts()}] [FAIL]`, ...a),
  step: (...a) => console.log (`\n[${ts()}] ━━━`, ...a, '━━━'),
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
));

const normalizeCode = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/-/g, '');

function truncateForTelegram(s, max = CONFIG.tgMessageMaxChars) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, max - 20) + '\n… (truncated)';
}

function statusLabel(s) {
  const m = { 0:'❌ Failed', 1:'✅ Passed', 2:'↩️ Withdrawn', 3:'⏳ Pending', 4:'📝 Registered', 5:'🆕 Never' };
  return s == null ? '❓' : (m[Number(s)] || `❓ (${s})`);
}
const isRegisterable = (s) => [0, 2, 5].includes(Number(s));

async function withTimeout(p, ms, label = 'op') {
  let t;
  const to = new Promise((_, rej) => t = setTimeout(() => rej(new Error(`${label} timeout`)), ms));
  try { return await Promise.race([p, to]); } finally { clearTimeout(t); }
}

async function retry(fn, { attempts = 3, baseMs = 800, label = 'op' } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = String(e?.message || e);
      const retryable = /timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|Target closed|net::|aborted/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      const b = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
      log.warn(`[retry ${label}] ${i+1}/${attempts}: ${msg} — retry ${b}ms`);
      await sleep(b);
    }
  }
  throw last;
}

const rssMb = () => { try { return Math.round(process.memoryUsage().rss / 1024 / 1024); } catch { return 0; } };

function rotateAuditIfNeeded() {
  try {
    if (!fs.existsSync(CONFIG.auditFile)) return;
    if (fs.statSync(CONFIG.auditFile).size > CONFIG.auditMaxBytes) {
      const b = CONFIG.auditFile + '.old';
      try { if (fs.existsSync(b)) fs.unlinkSync(b); } catch {}
      fs.renameSync(CONFIG.auditFile, b);
    }
  } catch (e) { log.warn('audit rotate failed:', e.message); }
}

function timeSince(t) {
  if (!t) return 'never';
  const d = Math.floor((Date.now() - t) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════════════
function defaultState() {
  return {
    version:              CONFIG.stateVersion,
    registeredCourses:    [],
    targetCourseId:       USER_CONFIG.targetCourseId,
    targetCourseCode:     null,
    targetCourseName:     null,
    targetCourseStatus:   null,
    openGroupsState:      {},
    pendingCallbacks:     {},
    _cbCounter:           0,
    lastTgUpdateId:       0,
    tgChatId:             null,
    watchedGroups:        [...USER_CONFIG.preferredGroups],
    startupBriefedAt:     0,
    paused:               false,
    lastError:            null,
    earlyDetection: {
      enabled:    USER_CONFIG.earlyDetectionEnabled,
      checks:     0, hits: 0,
      lastCheck:  0, lastFound: 0, notifiedAt: 0,
    },
    audit:    [],
    counters: {
      opens: 0, closes: 0, drops: 0, adds: 0,
      relogins: 0, errors: 0, alertsSent: 0,
      loginFailures: 0, scans: 0,
    },
  };
}

function migrateState(s) {
  if (!s || typeof s !== 'object') return defaultState();
  const base = defaultState();
  const merged = {
    ...base, ...s,
    counters: { ...base.counters, ...(s.counters || {}) },
    earlyDetection: { ...base.earlyDetection, ...(s.earlyDetection || {}) },
  };
  merged.audit = Array.isArray(merged.audit) ? merged.audit.slice(-500) : [];
  if (!Array.isArray(merged.watchedGroups)) merged.watchedGroups = [];
  if (!merged.openGroupsState || typeof merged.openGroupsState !== 'object') merged.openGroupsState = {};
  if (!merged.pendingCallbacks || typeof merged.pendingCallbacks !== 'object') merged.pendingCallbacks = {};
  if (typeof merged._cbCounter !== 'number') merged._cbCounter = 0;
  merged.version = CONFIG.stateVersion;
  return merged;
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) return migrateState(JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')));
  } catch (e) { log.warn('State load failed:', e.message); }
  return defaultState();
}

function saveState(state) {
  try { atomicWrite(CONFIG.stateFile, state); } catch (e) { log.warn('State save failed:', e.message); }
}

function audit(state, event, details = {}) {
  const entry = { t: Date.now(), event, ...details };
  state.audit.push(entry);
  if (state.audit.length > 500) state.audit = state.audit.slice(-500);
  try { rotateAuditIfNeeded(); fs.appendFileSync(CONFIG.auditFile, JSON.stringify(entry) + '\n'); } catch (e) {
    log.warn('audit append failed:', e.message);
  }
}

let _currentState = null;
function setCurrentState(s) { _currentState = s; }
// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM — sending
// ═══════════════════════════════════════════════════════════════════════════
const tgQueue = [];
let tgSending = false;
const tgTimestamps = [];

async function tgSend(html, { silent = false, replyMarkup = null } = {}) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId || !html) return;
  tgQueue.push({ html: truncateForTelegram(html), silent, replyMarkup });
  if (tgSending) return;
  tgSending = true;
  try {
    while (tgQueue.length > 0) {
      const now = Date.now();
      while (tgTimestamps.length && now - tgTimestamps[0] > 60_000) tgTimestamps.shift();
      if (tgTimestamps.length >= USER_CONFIG.maxTelegramPerMin) {
        await sleep(60_000 - (now - tgTimestamps[0]) + 100);
      }
      tgTimestamps.push(Date.now());
      const { html: msg, silent: sil, replyMarkup: rm } = tgQueue.shift();
      const payload = {
        chat_id: CONFIG.tgChatId, text: msg, parse_mode: 'HTML',
        disable_web_page_preview: true, disable_notification: sil,
      };
      if (rm) payload.reply_markup = rm;
      try {
        const res = await withTimeout(
          fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }), CONFIG.netTimeoutMs, 'tg-send'
        );
        const body = await res.json().catch(() => ({}));
        if (!body.ok) {
          if (body.error_code === 429) {
            const r = (body.parameters && body.parameters.retry_after) || 5;
            tgQueue.unshift({ html: msg, silent: sil, replyMarkup: rm });
            await sleep(r * 1000);
          } else {
            log.warn(`TG send rejected (${body.error_code || '?'}): ${body.description || 'unknown'}`);
          }
        }
      } catch (e) { log.warn('TG send failed:', e.message); }
      await sleep(1_100);
    }
  } finally { tgSending = false; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM — keyboards + commands
// ═══════════════════════════════════════════════════════════════════════════
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Status' }, { text: '🎯 Groups' }],
    [{ text: '🔥 Open' },   { text: '🔍 Find' }],
    [{ text: '🕐 Early' },  { text: '👁️ Watch' }],
    [{ text: '⏸️ Pause' },  { text: '▶️ Resume' }],
    [{ text: '🔄 Reset' },  { text: '❓ Help' }],
  ],
  resize_keyboard: true, is_persistent: true,
};

const BUTTON_MAP = {
  '📊 Status':'/status', '🎯 Groups':'/groups', '🔥 Open':'/open', '🔍 Find':'/find',
  '🕐 Early':'/early', '👁️ Watch':'/watch', '⏸️ Pause':'/pause', '▶️ Resume':'/resume',
  '🔄 Reset':'/reset', '❓ Help':'/help',
};

const BOT_COMMANDS = [
  { command: 'start',    description: '🟢 Bot alive' },
  { command: 'status',   description: '📊 Status report' },
  { command: 'early',    description: '🕐 Early detection' },
  { command: 'baseline', description: '🛡️ Registered courses' },
  { command: 'find',     description: '🔍 Search courses' },
  { command: 'diag',     description: '🩺 Diagnostic dump' },
  { command: 'groups',   description: '🎯 Target course groups' },
  { command: 'open',     description: '🔥 Open groups' },
  { command: 'info',     description: 'ℹ️ Registration info' },
  { command: 'target',   description: '🎯 Set target' },
  { command: 'watch',    description: '👁️ Watch a group' },
  { command: 'unwatch',  description: '🚫 Stop watching' },
  { command: 'reset',    description: '🔄 Reset' },
  { command: 'audit',    description: '📜 Last 10 events' },
  { command: 'pause',    description: '⏸️ Pause' },
  { command: 'resume',   description: '▶️ Resume' },
  { command: 'help',     description: '❓ Commands' },
];

async function registerBotCommands() {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
  try {
    const chatIdNum = Number(CONFIG.tgChatId);
    const scope = Number.isFinite(chatIdNum)
      ? { type: 'chat', chat_id: chatIdNum }
      : { type: 'default' };
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS, scope }),
    });
    log.ok(`Registered ${BOT_COMMANDS.length} commands`);
  } catch (e) { log.warn('Command registration failed:', e.message); }
}

function registerPendingGroup(state, name) {
  state._cbCounter = (state._cbCounter || 0) + 1;
  const id = 'g' + state._cbCounter;
  state.pendingCallbacks = state.pendingCallbacks || {};
  state.pendingCallbacks[id] = name;
  const keys = Object.keys(state.pendingCallbacks);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 150)) delete state.pendingCallbacks[k];
  }
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM — polling
// ═══════════════════════════════════════════════════════════════════════════
async function handleTelegramCommands(state, api) {
  if (!CONFIG.tgToken) return;
  try {
    const offset = state.lastTgUpdateId ? state.lastTgUpdateId + 1 : -1;
    const res = await withTimeout(
      fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${offset}&timeout=0`),
      CONFIG.netTimeoutMs, 'tg-poll');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const upd of data.result) {
      state.lastTgUpdateId = Math.max(state.lastTgUpdateId || 0, upd.update_id);
      if (upd.callback_query) {
        const cb = upd.callback_query;
        if (String(cb.message?.chat?.id || cb.from?.id) !== CONFIG.tgChatId) continue;
        await handleCallback(cb, state);
        continue;
      }
      const msg = upd.message;
      if (!msg?.text) continue;
      if (String(msg.chat.id) !== CONFIG.tgChatId) continue;

      const text = msg.text.trim();
      let cmd, args;
      if (BUTTON_MAP[text]) { cmd = BUTTON_MAP[text]; args = []; }
      else { const p = text.split(/\s+/); cmd = p[0].toLowerCase().replace(/@\w+$/, ''); args = p.slice(1); }
      await dispatchCommand(cmd, args, state, api);
    }
    saveState(state);
  } catch (e) { log.warn('TG poll failed:', e.message); }
}

async function answerCallback(id, text = '') {
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch (e) { log.warn('answerCallback failed:', e.message); }
}

async function handleCallback(cb, state) {
  const [action, ...rest] = (cb.data || '').split(':');
  const shortId = rest.join(':').trim();
  await answerCallback(cb.id);
  if (!shortId) return;

  const groupName = state.pendingCallbacks?.[shortId];
  if (!groupName) {
    await tgSend('⚠️ انتهت صلاحية الزر، استخدم /groups من جديد.');
    return;
  }

  if (action === 'watch') {
    if (!state.watchedGroups.includes(groupName)) {
      state.watchedGroups.push(groupName);
      audit(state, 'watch_add', { group: groupName });
      saveState(state);
    }
    await tgSend(`👁️ Added: <b>${escapeHtml(groupName)}</b>`);
  } else if (action === 'unwatch') {
    state.watchedGroups = state.watchedGroups.filter(g => g !== groupName);
    audit(state, 'watch_remove', { group: groupName });
    saveState(state);
    await tgSend(`🚫 Removed: <b>${escapeHtml(groupName)}</b>`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM — command dispatch
// ═══════════════════════════════════════════════════════════════════════════
async function dispatchCommand(cmd, args, state, api) {
  const uptimeMin = Math.floor((Date.now() - (state.startedAt || Date.now())) / 60_000);
  const targetCode = state.targetCourseCode || USER_CONFIG.targetCourse;

  switch (cmd) {
    case '/start': {
      await tgSend(`🎛️ <b>لوحة التحكم</b>`, { replyMarkup: MAIN_KEYBOARD });
      await dispatchCommand('/status', [], state, api);
      break;
    }

    case '/status': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code>`).join(' ')
        : '—';
      const target = state.targetCourseId ? `<code>${escapeHtml(state.targetCourseId)}</code>` : '⏳ waiting';
      const ed = state.earlyDetection || {};
      const openCount = Object.values(state.openGroupsState).filter(g => g.open).length;
      const errLine = state.lastError
        ? `\n⚠️ Last error: <code>${escapeHtml(String(state.lastError.message || '').slice(0, 120))}</code>`
        : '';
      await tgSend(
        `🟢 <b>Watcher ${CONFIG.versionLabel}</b>\n` +
        `⏱ <b>${uptimeMin} min</b> | 💾 <b>${rssMb()} MB</b> | ${state.paused ? '⏸ PAUSED' : '▶️ Running'}\n\n` +
        `🎯 Target: <b>${escapeHtml(targetCode)}</b> (${target})\n` +
        `📋 Status: ${state.targetCourseStatus != null ? statusLabel(state.targetCourseStatus) : '—'}\n` +
        `🕐 Early: <b>${ed.enabled ? '🟢 ON (10s)' : '🔴 OFF'}</b> | checks: <b>${ed.checks || 0}</b> | hits: <b>${ed.hits || 0}</b>\n` +
        `👁️ Watching: ${state.watchedGroups.length ? state.watchedGroups.map(escapeHtml).join(', ') : '<i>all</i>'}\n` +
        `🔥 Open now: <b>${openCount}</b>${errLine}\n\n` +
        `🛡️ Baseline (${state.registeredCourses.length}): ${regs}\n\n` +
        `📊 opens=<b>${state.counters.opens}</b> drops=<b>${state.counters.drops}</b> adds=<b>${state.counters.adds}</b> ` +
        `alerts=<b>${state.counters.alertsSent}</b> relogins=<b>${state.counters.relogins}</b> ` +
        `errors=<b>${state.counters.errors}</b> loginFails=<b>${state.counters.loginFailures || 0}</b>`
      );
      break;
    }

    case '/early': {
      const sub = (args[0] || '').toLowerCase();
      const ed = state.earlyDetection = state.earlyDetection || {};
      if (sub === 'on') {
        ed.enabled = true; saveState(state);
        await tgSend(`🕐 <b>Early Detection: ON</b>\n\nChecking every <b>10 seconds</b>.`);
      } else if (sub === 'off') {
        ed.enabled = false; saveState(state);
        await tgSend(`🕐 <b>Early Detection: OFF</b>`);
      } else if (sub === 'reset') {
        ed.checks = ed.hits = 0; ed.lastFound = ed.notifiedAt = 0;
        saveState(state);
        await tgSend(`🕐 Counters reset.`);
      } else {
        await tgSend(
          `🕐 <b>Early Detection</b>\n\n` +
          `Status: <b>${ed.enabled ? '🟢 ON' : '🔴 OFF'}</b>\n` +
          `Interval: <b>10s</b>\n` +
          `Checks: <b>${ed.checks || 0}</b>\n` +
          `Hits: <b>${ed.hits || 0}</b>\n` +
          `Target: <b>${escapeHtml(targetCode)}</b>\n` +
          `Resolved: <b>${state.targetCourseId ? '✅' : '❌'}</b>\n` +
          `Last check: ${timeSince(ed.lastCheck)}\n` +
          (ed.lastFound ? `Last found: ${timeSince(ed.lastFound)}\n` : '') +
          `\n<i>/early on | /early off | /early reset</i>`
        );
      }
      break;
    }

    case '/baseline': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.name)}`).join('\n')
        : '—';
      const missing = USER_CONFIG.expectedCourses.filter(exp =>
        !state.registeredCourses.some(c => normalizeCode(c.code).includes(normalizeCode(exp))));
      await tgSend(`🛡️ <b>Baseline</b>\n${regs}` +
        (missing.length ? `\n\n⚠️ Missing: ${missing.map(escapeHtml).join(', ')}` : `\n\n✅ Complete`));
      break;
    }

    case '/find': {
      const q = args.join(' ').trim();
      if (!q) { await tgSend(`Usage: /find &lt;code or name&gt;`); break; }
      const r = await api.getCourses({ forceRefresh: true });
      if (r.kind !== 'ok') { await tgSend(`❌ API: ${r.kind}`); break; }
      const qUp = q.toUpperCase(), qNorm = qUp.replace(/\s+/g, '');
      const matches = r.courses.filter(c =>
        String(c.code).toUpperCase().includes(qUp) ||
        String(c.name).toUpperCase().includes(qUp) ||
        String(c.code).toUpperCase().replace(/\s+/g, '').includes(qNorm));
      if (!matches.length) { await tgSend(`🔍 No matches. Total: ${r.courses.length}`); break; }
      let msg = `🔍 <b>${matches.length} matches:</b>\n\n`;
      matches.slice(0, 20).forEach((c, i) => {
        msg += `${i+1}. <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.name)}\n   ${statusLabel(c.status)} | ID: <code>${escapeHtml(c.id)}</code>\n\n`;
      });
      await tgSend(msg);
      break;
    }

    case '/diag': {
      const r = await api.getCourses({ forceRefresh: true });
      if (r.kind !== 'ok') { await tgSend(`❌ API: ${r.kind}`); break; }
      const by = { 0:[], 1:[], 2:[], 3:[], 4:[], 5:[] };
      for (const c of r.courses) { const s = Number(c.status); if (by[s]) by[s].push(c.code); }
      let msg = `🩺 <b>Diagnostic</b>\n\n📊 Total: <b>${r.courses.length}</b>\n\n`;
      for (const [s, codes] of Object.entries(by)) {
        if (!codes.length) continue;
        msg += `${statusLabel(Number(s))} (${codes.length}):\n<code>${codes.slice(0,15).map(escapeHtml).join(', ')}</code>\n\n`;
      }
      await tgSend(msg);
      break;
    }

    case '/groups': {
      if (!state.targetCourseId) {
        await tgSend(`⏳ Target "<b>${escapeHtml(targetCode)}</b>" not available yet.\n\n🕐 Early Detection (10s) watching…`);
        break;
      }
      const r = await api.getCourseSchedule(state.targetCourseId);
      if (r.kind !== 'ok' || !r.groups?.length) { await tgSend(`❌ No groups yet.`); break; }
      const sorted = [...r.groups].sort((a, b) => (a.available !== b.available) ? (a.available ? -1 : 1) : a.name.localeCompare(b.name));
      let msg = `🎯 <b>${escapeHtml(targetCode)} — ${r.groups.length} groups</b>\n\n`;
      sorted.slice(0, 20).forEach((g) => {
        const w = state.watchedGroups.some(x => g.name.toUpperCase().includes(x.toUpperCase()));
        msg += `${w ? '👁️ ' : ''}${g.available ? '🔥' : '❄️'} <b>${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
        if (g.slots[0]) msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
      });
      const avail = sorted.filter(g => g.available).slice(0, 8);
      const rows = avail.map(g => {
        const id = registerPendingGroup(state, g.name);
        return [{ text: `👁️ Watch ${g.name} (${g.seats})`, callback_data: `watch:${id}` }];
      });
      saveState(state);
      await tgSend(msg, { replyMarkup: rows.length ? { inline_keyboard: rows } : undefined });
      break;
    }

    case '/open': {
      const openGroups = Object.entries(state.openGroupsState).filter(([_, v]) => v.open).map(([n, v]) => ({ name: n, ...v }));
      if (!openGroups.length) { await tgSend(`❄️ No groups open.`); break; }
      let msg = `🔥 <b>Open (${openGroups.length}):</b>\n\n`;
      openGroups.forEach((g, i) => { msg += `${i+1}. <b>${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`; });
      await tgSend(msg);
      break;
    }

    case '/info': {
      const r = await api.getRegInfo();
      if (r.kind !== 'ok' || !r.data?.[0]) { await tgSend(`❌ API: ${r.kind}`); break; }
      const info = r.data[0];
      const status = info.RegAvailabilty === 1 ? '✅ OPEN' : (info.RegAvailabilty === -1 ? '⏳ NOT STARTED' : '🚫 BLOCKED');
      await tgSend(
        `ℹ️ <b>Registration</b>\n\nStatus: <b>${status}</b>\n` +
        (info.RegAvailabiltyReason ? `<i>${escapeHtml(info.RegAvailabiltyReason)}</i>\n` : '') +
        `\n📅 Ends: <b>${escapeHtml(String(info.RegEndDate || '—'))}</b>\n` +
        `💰 Balance: <b>${escapeHtml(String(info.StudentCredit || '—'))} ${escapeHtml(String(info.Currency || ''))}</b>\n` +
        `⏱ Permitted: <b>${escapeHtml(String(info.AcademicAllowedHours || '—'))}</b> hrs\n` +
        `📚 Registered: <b>${escapeHtml(String(info.RegisteredHours || '—'))}</b> hrs`
      );
      break;
    }

    case '/target': {
      const code = args.join(' ').trim();
      if (!code) { await tgSend(`Usage: /target &lt;code&gt;`); break; }
      const resolved = await api.resolveTargetId(code, { onlyRegisterable: true });
      if (resolved) {
        state.targetCourseId     = resolved.id;
        state.targetCourseCode   = resolved.code;
        state.targetCourseName   = resolved.name;
        state.targetCourseStatus = resolved.status;
        state.watchedGroups      = [];
        state.openGroupsState    = {};
        state.pendingCallbacks   = {};
        audit(state, 'target_set_manual', { code, id: resolved.id });
        saveState(state);
        await tgSend(`🎯 <b>Target</b>\n\n<code>${escapeHtml(resolved.code)}</code> — ${escapeHtml(resolved.name)}\nID: <code>${escapeHtml(resolved.id)}</code>\n${statusLabel(resolved.status)}`);
      } else {
        await tgSend(`❌ Not found or not registerable.`);
      }
      break;
    }

    case '/watch': {
      if (!args.length) {
        await tgSend(state.watchedGroups.length
          ? `👁️ Watching: ${state.watchedGroups.map(g => `<code>${escapeHtml(g)}</code>`).join(', ')}`
          : `👁️ Empty — will alert on ANY group.`);
        break;
      }
      const grp = args.join(' ').trim();
      if (!state.watchedGroups.includes(grp)) {
        state.watchedGroups.push(grp);
        saveState(state);
      }
      await tgSend(`👁️ Watching: <b>${escapeHtml(grp)}</b>`);
      break;
    }

    case '/unwatch': {
      if (!args.length) { await tgSend(`Usage: /unwatch &lt;group&gt; | /unwatch all`); break; }
      const t = args.join(' ').trim();
      if (t.toLowerCase() === 'all') state.watchedGroups = [];
      else state.watchedGroups = state.watchedGroups.filter(g => g !== t);
      saveState(state);
      await tgSend(`🚫 Cleared/removed.`);
      break;
    }

    case '/reset': {
      state.targetCourseId     = null;
      state.targetCourseCode   = null;
      state.targetCourseName   = null;
      state.targetCourseStatus = null;
      state.watchedGroups      = [];
      state.openGroupsState    = {};
      state.pendingCallbacks   = {};
      const ed = state.earlyDetection = state.earlyDetection || {};
      ed.checks = 0; ed.hits = 0; ed.lastFound = 0; ed.notifiedAt = 0; ed.lastCheck = 0;
      audit(state, 'reset');
      saveState(state);
      await tgSend(`🔄 Reset complete.`);
      break;
    }

    case '/audit': {
      const last = state.audit.slice(-10).map(e =>
        `• <code>${new Date(e.t).toISOString().slice(11,19)}</code> ${escapeHtml(e.event)}`).join('\n');
      await tgSend(`📜 <b>Last 10</b>\n${last || '—'}`);
      break;
    }

    case '/pause':  state.paused = true;  saveState(state); await tgSend('⏸️ Paused');  break;
    case '/resume': state.paused = false; saveState(state); await tgSend('▶️ Resumed'); break;

    case '/help': {
      await tgSend(`🤖 <b>Commands</b>\n\n` + BOT_COMMANDS.map(c => `/<b>${c.command}</b> — ${c.description}`).join('\n'), { replyMarkup: MAIN_KEYBOARD });
      break;
    }
  }
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SESSION
// ═══════════════════════════════════════════════════════════════════════════
function sessionAgeMinutes() {
  try {
    if (fs.existsSync(CONFIG.sessionMetaFile)) {
      const m = JSON.parse(fs.readFileSync(CONFIG.sessionMetaFile, 'utf8'));
      return m.savedAt ? (Date.now() - m.savedAt) / 60000 : Infinity;
    }
  } catch (e) { log.warn('session meta read failed:', e.message); }
  return Infinity;
}
function cleanupSession() {
  try { if (fs.existsSync(CONFIG.sessionFile)) fs.unlinkSync(CONFIG.sessionFile); } catch (e) {
    log.warn('session cleanup failed:', e.message);
  }
}
async function saveSession(ctx) {
  try {
    await ctx.storageState({ path: CONFIG.sessionFile });
    atomicWrite(CONFIG.sessionMetaFile, { savedAt: Date.now() });
  } catch (e) { log.warn('Session save failed:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BROWSER
// ═══════════════════════════════════════════════════════════════════════════
async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--no-zygote',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--js-flags=--max-old-space-size=512',
    ],
  });
}

async function createAuthContext(browser, useCookies = true) {
  const opts = {
    baseURL: CONFIG.baseUrl, timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (useCookies && fs.existsSync(CONFIG.sessionFile)) opts.storageState = CONFIG.sessionFile;
  return browser.newContext(opts);
}

// ─── Login helpers (multi-selector + classification) ────────────────────────
const LOGIN_SELECTORS = {
  user: [
    'input[name="txtUserName"]',
    'input[name="txtUsername"]',
    'input[name="username"]',
    'input[id*="UserName"]',
    'input[id*="Username"]',
    'input[type="text"]',
  ],
  pass: [
    'input[name="txtPassword"]',
    'input[name="password"]',
    'input[id*="Password"]',
    'input[type="password"]',
  ],
  submit: [
    'input[name="btnLogin"]',
    'input[name="btnSignIn"]',
    'input[type="submit"]',
    'button[type="submit"]',
  ],
};

async function firstMatch(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0) return loc;
    } catch {}
  }
  return null;
}

function classifyLoginFailure({ url = '', title = '', body = '' }) {
  const all = (url + ' ' + title + ' ' + body).toLowerCase();
  if (/captcha|recaptcha|robot|are you human|verify you are/i.test(all)) return 'captcha_required';
  if (/locked|disabled|blocked|suspended/i.test(all))                    return 'account_locked';
  if (/invalid|incorrect|wrong password|bad credentials|كلمة المرور|خطأ/i.test(all)) return 'invalid_credentials';
  if (/maintenance|temporarily unavailable|under construction/i.test(all)) return 'site_maintenance';
  if (/login\.aspx/i.test(url) && body.trim().length === 0)              return 'blank_login_page';
  return 'unknown';
}

async function loginAndCaptureCookies(browser, state) {
  log.info('Logging in…');
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => {
    const t = r.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') return r.abort();
    return r.continue();
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  let lastErr = null;
  const MAX = USER_CONFIG.loginMaxAttempts;

  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      log.info(`Login attempt ${attempt}/${MAX}…`);
      await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeoutMs });

      const userEl   = await firstMatch(page, LOGIN_SELECTORS.user);
      const passEl   = await firstMatch(page, LOGIN_SELECTORS.pass);
      const submitEl = await firstMatch(page, LOGIN_SELECTORS.submit);

      if (!userEl || !passEl || !submitEl) {
        throw new Error(
          `Login form not found (user=${!!userEl} pass=${!!passEl} submit=${!!submitEl})`
        );
      }

      await userEl.fill(CONFIG.username);
      await passEl.fill(CONFIG.password);
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
        submitEl.click(),
      ]);
      await sleep(800);

      const finalUrl = page.url();
      const stillOnLogin =
        finalUrl.includes('/Login.aspx') ||
        /\/login(\?|$)/i.test(finalUrl);

      if (stillOnLogin) {
        // ✅ FIX #3: capture page text for diagnosis
        const title = await page.title().catch(() => '');
        const body  = await page.locator('body').innerText().catch(() => '');
        const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 400);
        const cause = classifyLoginFailure({ url: finalUrl, title, body });

        const detail = `cause=${cause} url="${finalUrl}" title="${title}" body="${snippet}"`;
        log.warn(`Login failed: ${detail}`);

        // Attach detail to the thrown error so the caller can persist it
        const err = new Error(`Login failed [${cause}]: ${detail}`);
        err.loginCause = cause;
        err.loginUrl   = finalUrl;
        err.loginTitle = title;
        err.loginBody  = snippet;
        throw err;
      }

      // Success
      await saveSession(ctx);
      await ctx.close();
      log.ok(`Logged in (attempt ${attempt})`);
      return;
    } catch (e) {
      lastErr = e;
      log.warn(`Attempt ${attempt}/${MAX} failed: ${String(e.message || e).slice(0, 200)}`);

      if (attempt >= MAX) break;

      const wait = USER_CONFIG.loginBaseDelayMs * attempt + Math.floor(Math.random() * 1500);
      log.info(`Waiting ${wait}ms before retry…`);
      await sleep(wait);

      try { await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }); } catch {}
    }
  }

  try { await ctx.close(); } catch {}
  throw lastErr || new Error('Login failed after all attempts');
}// ═══════════════════════════════════════════════════════════════════════════
//  AJAX INTERCEPTION
// ═══════════════════════════════════════════════════════════════════════════
async function setupAJAXInterception(ctx, pageRef) {
  if (pageRef.page && !pageRef.page.isClosed()) {
    try { await pageRef.page.close(); } catch (e) { log.warn('close old page failed:', e.message); }
  }

  pageRef.page = await ctx.newPage();
  pageRef.lastAJAX = null;
  pageRef.ajaxTime = 0;

  pageRef.page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/Registered/GetStudentResiterationCourses')) {
      try {
        const json = await response.json();
        if (Array.isArray(json) && json.length > 0) {
          const prev = pageRef.lastAJAX?.length || 0;
          pageRef.lastAJAX = json;
          pageRef.ajaxTime = Date.now();
          if (json.length !== prev) log.ok(`Intercepted AJAX: ${json.length} courses (was ${prev})`);
        }
      } catch (e) { log.warn('AJAX parse failed:', e.message); }
    }
  });

  await pageRef.page.goto(CONFIG.coursesPageUrl, {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  }).catch((e) => log.warn('Page nav failed:', e.message));

  for (let i = 0; i < 20 && !pageRef.lastAJAX; i++) await sleep(500);

  if (pageRef.lastAJAX) log.ok(`AJAX ready: ${pageRef.lastAJAX.length} courses`);
  else log.warn('No AJAX captured yet');
}

// ═══════════════════════════════════════════════════════════════════════════
//  API CLIENT
// ═══════════════════════════════════════════════════════════════════════════
function makeApi(ctx, pageRef) {
  let courseCache = { ts: 0, data: null };
  const CACHE_TTL = 8 * 1000;

  async function fetchInPage(path, options = {}) {
    const result = await pageRef.page.evaluate(async ({ path, options }) => {
      try {
        const res = await fetch(path, {
          method: options.method || 'GET',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' },
        });
        if (!res.ok) return { ok: false, status: res.status, text: '' };
        const text = await res.text();
        return { ok: true, status: res.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: '', error: e.message };
      }
    }, { path, options });

    if (!result.ok) {
      if (result.status === 302 || result.status === 401) return { kind: 'session_dead' };
      if (result.status >= 500) return { kind: 'soft_server' };
      return { kind: 'net', error: result.error };
    }
    const s = String(result.text || '').trim();
    if (s === '' || s === 'null' || s === '-1') return { kind: 'session_dead' };
    if (s[0] === '<') {
      if (/login|signin|Login\.aspx/i.test(s)) return { kind: 'session_dead' };
      return { kind: 'soft_server' };
    }
    let data;
    try { data = JSON.parse(s); } catch { return { kind: 'structural' }; }
    return { kind: 'ok', data };
  }

  async function call(method, url, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return fetchInPage(url + qs, { method });
  }

  async function triggerAjax() {
    try {
      if (!pageRef.page || pageRef.page.isClosed()) {
        await setupAJAXInterception(ctx, pageRef);
        return;
      }
      pageRef.lastAJAX = null;
      await pageRef.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      for (let i = 0; i < 20 && !pageRef.lastAJAX; i++) await sleep(500);
    } catch (e) { log.warn('triggerAjax failed:', e.message); }
  }

  function mapCourses(arr) {
    return arr.map(c => ({
      id: String(c.CourseId),
      code: c.Code || '',
      name: c.Name || '',
      status: c.GradeStatusId,
      group: c.GrpName,
    }));
  }

  return {
    async getCourseSchedule(courseId) {
      const r = await retry(() => call('GET', CONFIG.API.courseSchedule, { CourseId: courseId }),
        { label: 'getCourseSchedule', attempts: 2 });
      if (r.kind !== 'ok') return r;
      if (!Array.isArray(r.data)) return { kind: 'structural' };

      const groups = {};
      for (const item of r.data) {
        if (!item || item.Type !== 'Group') continue;
        const gid = item.GroupId;
        if (gid == null) continue;
        if (!groups[gid]) {
          const rawName   = String(item.GroupName || '').trim();
          const shortName = String(item.ShortName || '').trim();
          const isUni     = !!item.IsUniversity;
          let displayName;
          if (isUni && shortName && rawName) displayName = `${shortName}-${rawName}`;
          else if (rawName)  displayName = rawName;
          else if (shortName) displayName = `${shortName}-${gid}`;
          else displayName = `Group-${gid}`;
          groups[gid] = {
            id: gid, name: displayName, rawName, shortName,
            isUniversity: isUni, blocked: !!item.IsBlocked,
            total: parseInt(item.StudentsCount) || 0,
            registered: parseInt(item.RegisteredCount) || 0,
            slots: [],
          };
        }
        groups[gid].slots.push({ day: item.DayWeekName, time: item.Time, hall: item.ClassRoomName, staff: item.Staff });
      }
      const list = Object.values(groups).map(g => ({
        ...g,
        seats: g.total - g.registered,
        available: !g.blocked && (g.total - g.registered) > 0,
      }));
      return { kind: 'ok', groups: list };
    },

    async getCourses({ forceRefresh = false } = {}) {
      if (!forceRefresh && courseCache.data && Date.now() - courseCache.ts < CACHE_TTL) {
        return { kind: 'ok', courses: courseCache.data };
      }

      if (pageRef.lastAJAX && pageRef.lastAJAX.length > 0 &&
          Date.now() - pageRef.ajaxTime < 60_000) {
        const list = mapCourses(pageRef.lastAJAX);
        courseCache = { ts: Date.now(), data: list };
        return { kind: 'ok', courses: list };
      }

      await triggerAjax();

      if (pageRef.lastAJAX && pageRef.lastAJAX.length > 0) {
        const list = mapCourses(pageRef.lastAJAX);
        courseCache = { ts: Date.now(), data: list };
        return { kind: 'ok', courses: list };
      }

      log.warn('getCourses: AJAX failed, using direct fetch');
      const r = await fetchInPage(
        CONFIG.API.coursesList +
        '?GradeStatusIds=0,1,2,3,4,5&GroupsIds=-1&IsVirtualRegisteration=false'
      );
      if (r.kind !== 'ok') return r;
      const data = Array.isArray(r.data) ? r.data : [];
      const list = mapCourses(data);
      courseCache = { ts: Date.now(), data: list };
      return { kind: 'ok', courses: list };
    },

    async getRegInfo() {
      return retry(() => call('POST', CONFIG.API.regInfo), { label: 'getRegInfo', attempts: 2 });
    },

    async resolveTargetId(query, { onlyRegisterable = true } = {}) {
      const r = await this.getCourses({ forceRefresh: true });
      if (r.kind !== 'ok') return null;
      const pool = onlyRegisterable ? r.courses.filter(c => isRegisterable(c.status)) : r.courses;
      const qNorm = normalizeCode(query);
      const qRaw  = String(query).toUpperCase().trim();
      const qNoSp = qRaw.replace(/\s+/g, '');
      return (
        pool.find(c => normalizeCode(c.code) === qNorm) ||
        pool.find(c => String(c.code).toUpperCase().trim() === qRaw) ||
        pool.find(c => normalizeCode(c.code).includes(qNorm)) ||
        pool.find(c => String(c.name).toUpperCase().includes(qRaw)) ||
        pool.find(c => String(c.name).toUpperCase().replace(/\s+/g, '').includes(qNoSp)) ||
        null
      );
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  EARLY DETECTION
// ═══════════════════════════════════════════════════════════════════════════
async function earlyDetectionCheck(api, state) {
  if (!state.earlyDetection?.enabled) return { found: false };
  if (state.targetCourseId) return { found: false, alreadyResolved: true };

  state.earlyDetection.checks++;
  state.earlyDetection.lastCheck = Date.now();

  const query = state.targetCourseCode || USER_CONFIG.targetCourse;
  const r = await api.getCourses({ forceRefresh: true });
  if (r.kind !== 'ok') {
    log.warn(`Early detection: ${r.kind}`);
    return { found: false, error: r.kind };
  }

  const qNorm = normalizeCode(query);
  const qRaw  = String(query).toUpperCase().trim();
  const qNoSp = qRaw.replace(/\s+/g, '');

  const found = r.courses.find(c =>
    normalizeCode(c.code) === qNorm ||
    String(c.code).toUpperCase().trim() === qRaw ||
    normalizeCode(c.code).includes(qNorm) ||
    String(c.name).toUpperCase().includes(qRaw) ||
    String(c.name).toUpperCase().replace(/\s+/g, '').includes(qNoSp)
  );

  if (!found) {
    if (state.earlyDetection.checks % 6 === 0) {
      log.info(`Early: not yet (checked ${r.courses.length} courses, #${state.earlyDetection.checks})`);
    }
    return { found: false, checked: r.courses.length };
  }

  state.earlyDetection.hits++;
  state.earlyDetection.lastFound = Date.now();
  state.earlyDetection.notifiedAt = Date.now();

  state.targetCourseId     = found.id;
  state.targetCourseCode   = found.code;
  state.targetCourseName   = found.name;
  state.targetCourseStatus = found.status;
  state.watchedGroups      = [];
  state.openGroupsState    = {};

  log.ok(`🎉🎉🎉 EARLY DETECTION: ${found.code} (${found.name}) id=${found.id}`);
  audit(state, 'early_hit', { code: found.code, id: found.id });

  const msg =
    `🎉🎉 <b>${escapeHtml(query)} ظهرت!</b> 🎉🎉\n\n` +
    `📋 Code: <code>${escapeHtml(found.code)}</code>\n` +
    `📚 Name: ${escapeHtml(found.name)}\n` +
    `🆔 ID: <code>${escapeHtml(found.id)}</code>\n` +
    `📊 Status: ${statusLabel(found.status)}\n\n` +
    `⚡ Sniping started automatically!\n` +
    `📋 Use /groups to see groups\n` +
    `🔗 Open DULMS to register`;
  await tgSend(msg, { silent: false });

  return { found: true, course: found };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY — baseline guard
// ═══════════════════════════════════════════════════════════════════════════
function sameCourse(a, b) {
  if (a.id && b.id) return String(a.id) === String(b.id);
  return a.code && b.code && normalizeCode(a.code) === normalizeCode(b.code);
}

async function verifyRegistrationStability(api, state) {
  const r = await api.getCourses();
  if (r.kind !== 'ok') return { kind: r.kind };

  const currentReg = r.courses
    .filter(c => Number(c.status) === 3 || Number(c.status) === 4)
    .map(c => ({ id: c.id, code: c.code, name: c.name }));

  if (!state.registeredCourses.length) {
    state.registeredCourses = currentReg;
    log.ok(`Baseline set: ${currentReg.length} courses → ${currentReg.map(c => c.code).join(', ')}`);
    audit(state, 'baseline_set', { codes: currentReg.map(c => c.code) });
    return { kind: 'ok' };
  }

  for (const saved of state.registeredCourses) {
    if (!currentReg.some(c => sameCourse(c, saved))) {
      state.counters.drops++;
      audit(state, 'course_dropped', { code: saved.code });
      await tgSend(`🚨 <b>Dropped!</b>\n❌ ${escapeHtml(saved.code)} — ${escapeHtml(saved.name)}`);
    }
  }
  for (const curr of currentReg) {
    if (!state.registeredCourses.some(s => sameCourse(s, curr))) {
      state.counters.adds++;
      audit(state, 'course_added', { code: curr.code });
      await tgSend(`✅ <b>New course!</b>\n➕ ${escapeHtml(curr.code)}`);
    }
  }
  state.registeredCourses = currentReg;
  return { kind: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNIPER
// ═══════════════════════════════════════════════════════════════════════════
function filterMatchingGroups(groups, watched) {
  if (!Array.isArray(groups)) return [];
  const avail = groups.filter(g => g?.available && typeof g.name === 'string' && g.name.length > 0);
  if (!watched?.length) return avail;
  const w = watched.filter(x => typeof x === 'string').map(x => x.toUpperCase());
  if (!w.length) return avail;
  return avail.filter(g => w.some(p => String(g.name || '').toUpperCase().includes(p)));
}

async function sniperCheck(api, state) {
  if (!state.targetCourseId) return { kind: 'no_target' };
  const r = await api.getCourseSchedule(state.targetCourseId);
  if (r.kind !== 'ok') return r;

  const openGroups = filterMatchingGroups(r.groups, state.watchedGroups);
  const currentlyOpen = new Set(openGroups.map(g => g.name));
  if (!state.openGroupsState) state.openGroupsState = {};

  const newlyOpened = openGroups.filter(g => !state.openGroupsState[g.name]?.open);
  const closed = Object.entries(state.openGroupsState)
    .filter(([n, v]) => v.open && !currentlyOpen.has(n)).map(([n]) => n);

  for (const g of openGroups) {
    state.openGroupsState[g.name] = { open: true, lastSeen: Date.now(), seats: g.seats, total: g.total };
  }
  for (const name of closed) {
    if (state.openGroupsState[name]) {
      state.openGroupsState[name].open = false;
      state.openGroupsState[name].seats = 0;
    }
  }

  if (newlyOpened.length > 0) {
    state.counters.opens += newlyOpened.length;
    state.counters.alertsSent++;
    audit(state, 'target_open', { groups: newlyOpened.map(g => g.name) });

    const targetLabel = state.targetCourseCode || USER_CONFIG.targetCourse;
    let msg = `🎉 <b>${escapeHtml(targetLabel)} — ${newlyOpened.length} opened!</b>\n\n`;
    newlyOpened.slice(0, 8).forEach((g, i) => {
      msg += `<b>${i+1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      if (g.slots[0]) {
        msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
        if (g.slots[0].hall) msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
      }
      msg += `\n`;
    });
    msg += `🔗 <b>Open DULMS NOW!</b>`;
    await tgSend(msg, { silent: !USER_CONFIG.notifyWithSound });
    saveState(state);
  }

  if (closed.length > 0) {
    state.counters.closes += closed.length;
    audit(state, 'target_close', { groups: closed });
    saveState(state);
  }

  return { kind: 'open', groups: openGroups };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser, deadline) {
  // ✅ FIX #1: save state BEFORE any network op
  const state = loadState();
  state.startedAt = Date.now();
  state.counters.scans = (state.counters.scans || 0) + 1;
  if (!state.earlyDetection) state.earlyDetection = defaultState().earlyDetection;

  // Auto-resume if paused from a previous run
  if (state.paused) {
    log.warn('Was PAUSED from a previous run — auto-resuming');
    state.paused = false;
    audit(state, 'auto_resume');
  }

  setCurrentState(state);
  saveState(state);
  log.ok(`State initialized at ${CONFIG.stateFile}`);

  // Login (guarded)
  if (!fs.existsSync(CONFIG.sessionFile) || sessionAgeMinutes() > CONFIG.cookieMaxAgeMin) {
    cleanupSession();
    try {
      await loginAndCaptureCookies(browser, state);
      state.lastError = null;
      saveState(state);
    } catch (e) {
      state.counters.loginFailures = (state.counters.loginFailures || 0) + 1;
      state.counters.errors = (state.counters.errors || 0) + 1;
      state.lastError = {
        t: Date.now(),
        phase: 'login',
        cause: e.loginCause || 'unknown',
        message: String(e.message || e).slice(0, 500),
        url: e.loginUrl || null,
        title: e.loginTitle || null,
        body: e.loginBody || null,
      };
      audit(state, 'login_failed', {
        cause: e.loginCause || 'unknown',
        msg: String(e.message || e).slice(0, 200),
      });
      saveState(state);
      throw e;
    }
  }

  let ctx = await createAuthContext(browser, true);
  const pageRef = { page: null, lastAJAX: null, ajaxTime: 0 };
  await setupAJAXInterception(ctx, pageRef);
  let api = makeApi(ctx, pageRef);

  // Chat migration
  if (!state.tgChatId) state.tgChatId = CONFIG.tgChatId;
  else if (state.tgChatId !== CONFIG.tgChatId) {
    state.tgChatId = CONFIG.tgChatId;
    await tgSend(`🔄 <b>Chat migrated</b>`, { replyMarkup: MAIN_KEYBOARD });
  }
  saveState(state);

  // Startup brief (throttled)
  const startupGapMs = USER_CONFIG.startupBriefHours * 60 * 60_000;
  if (Date.now() - state.startupBriefedAt > startupGapMs) {
    state.startupBriefedAt = Date.now();
    const targetLabel = state.targetCourseCode || USER_CONFIG.targetCourse;
    await tgSend(
      `🚀 <b>Watcher ${CONFIG.versionLabel}</b>\n\n` +
      `🎯 Sniping <b>${escapeHtml(targetLabel)}</b>\n` +
      `🕐 Early Detection: <b>ON — every 10s</b>\n` +
      `🛡️ Guarding <b>${state.registeredCourses.length}</b> courses\n\n` +
      `Send /help or use the buttons.`,
      { replyMarkup: MAIN_KEYBOARD }
    );
    saveState(state);
  }

  log.step(`STARTED — Target: ${state.targetCourseCode || USER_CONFIG.targetCourse} | Early every 10s`);

  const timers = {
    sniper:         Date.now() + 500,
    security:       Date.now() + 1_500,
    earlyDetection: Date.now() + 3_000,
    telegram:       Date.now() + 1_000,
    memory:         Date.now() + 60_000,
    pageHealth:     Date.now() + 30_000,
    sessionRenew:   Date.now() + USER_CONFIG.sessionRenewEveryMs,
  };

  while (Date.now() < deadline) {
    const now = Date.now();

    // Telegram (always runs, even when paused)
    if (now >= timers.telegram) {
      await handleTelegramCommands(state, api);
      timers.telegram = Date.now() + USER_CONFIG.telegramPollMs;
    }

    if (state.paused) { await sleep(1000); continue; }

    // Memory watchdog
    if (now >= timers.memory) {
      const mb = rssMb();
      if (mb >= CONFIG.memRestartMb) {
        log.err(`Memory critical (${mb} MB) — rebuild`);
        saveState(state);
        try { await ctx.close(); } catch {}
        return RESULT.REBUILD;
      } else if (mb >= CONFIG.memWarnMb) {
        log.warn(`Memory high: ${mb} MB`);
      }
      timers.memory = Date.now() + 60_000;
    }

    // Page health
    if (now >= timers.pageHealth) {
      try {
        if (!pageRef.page || pageRef.page.isClosed()) {
          log.warn('Page closed — reopening…');
          await setupAJAXInterception(ctx, pageRef);
          api = makeApi(ctx, pageRef);
        }
      } catch (e) { log.warn('Page health check failed:', e.message); }
      timers.pageHealth = Date.now() + 30_000;
    }

    // Session renewal
    if (now >= timers.sessionRenew) {
      try {
        await saveSession(ctx);
        timers.sessionRenew = Date.now() + USER_CONFIG.sessionRenewEveryMs;
      } catch (e) {
        log.warn('Session renewal failed:', e.message);
        timers.sessionRenew = Date.now() + 60_000;
      }
    }

    // Early Detection
    if (!state.targetCourseId && state.earlyDetection.enabled && now >= timers.earlyDetection) {
      try {
        const ed = await earlyDetectionCheck(api, state);
        if (ed.found) log.ok('🎉 Early detection HIT!');
      } catch (e) { log.warn('Early detection error:', e.message); }
      timers.earlyDetection += USER_CONFIG.earlyDetectionIntervalMs;
      if (timers.earlyDetection < Date.now()) timers.earlyDetection = Date.now() + USER_CONFIG.earlyDetectionIntervalMs;
      saveState(state);
    }

    // Security baseline
    if (now >= timers.security) {
      try {
        const sr = await verifyRegistrationStability(api, state);
        if (sr.kind === 'session_dead') {
          log.warn('Session dead — relogin');
          state.counters.relogins++;
          try { await ctx.close(); } catch {}
          cleanupSession();
          await loginAndCaptureCookies(browser, state);
          ctx = await createAuthContext(browser, true);
          await setupAJAXInterception(ctx, pageRef);
          api = makeApi(ctx, pageRef);
          timers.security = Date.now() + 5_000;
        } else if (sr.kind === 'ok') {
          timers.security = Date.now() + USER_CONFIG.securityIntervalMs;
        } else {
          state.counters.errors++;
          timers.security = Date.now() + 60_000;
        }
        saveState(state);
      } catch (e) {
        log.warn('Security error:', e.message);
        timers.security = Date.now() + 60_000;
      }
    }

    // Sniper
    if (state.targetCourseId && now >= timers.sniper) {
      try {
        const sr = await sniperCheck(api, state);
        if (sr.kind === 'session_dead') {
          log.warn('Sniper: session dead — relogin');
          state.counters.relogins++;
          try { await ctx.close(); } catch {}
          cleanupSession();
          await loginAndCaptureCookies(browser, state);
          ctx = await createAuthContext(browser, true);
          await setupAJAXInterception(ctx, pageRef);
          api = makeApi(ctx, pageRef);
          timers.sniper = Date.now() + 5_000;
        } else if (sr.kind === 'soft_server' || sr.kind === 'http') {
          state.counters.errors++;
          timers.sniper = Date.now() + 30_000;
        } else {
          timers.sniper += USER_CONFIG.sniperIntervalMs;
          if (timers.sniper < Date.now()) timers.sniper = Date.now() + USER_CONFIG.sniperIntervalMs;
        }
      } catch (e) {
        log.warn('Sniper error:', e.message);
        timers.sniper = Date.now() + USER_CONFIG.sniperIntervalMs;
      }
    }

    await sleep(USER_CONFIG.heartbeatMs);
  }

  try { await ctx.close(); } catch {}
  return RESULT.COMPLETED;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════
let shuttingDown = false;
function setupShutdownHandlers() {
  const h = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${sig} — saving state`);
    if (_currentState) { try { saveState(_currentState); } catch {} }
    process.exit(0);
  };
  process.on('SIGTERM', () => h('SIGTERM'));
  process.on('SIGINT',  () => h('SIGINT'));
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  if (!CONFIG.username || !CONFIG.password) {
    log.err('Missing DULMS_USERNAME / DULMS_PASSWORD');
    process.exit(1);
  }
  setupShutdownHandlers();

  const startTs = Date.now();
  const deadline = startTs + CONFIG.durationMin * 60_000;

  log.info(`Watcher ${CONFIG.versionLabel} — PID ${process.pid}, RSS ${rssMb()} MB, ${CONFIG.durationMin} min`);

  await registerBotCommands();

  let iter = 0;
  const maxIter = 10;

  while (Date.now() < deadline && iter < maxIter) {
    iter++;

    let browser;
    try {
      browser = await createBrowser();
    } catch (e) {
      log.err('Browser launch failed:', e.message);
      await sleep(3_000);
      continue;
    }

    let result;
    try {
      result = await runScan(browser, deadline);
    } catch (e) {
      log.err('Fatal:', e.message);
      if (e.stack) console.error(e.stack);
      result = RESULT.FATAL;

      // ✅ FIX #2: notify user + persist lastError
      try {
        const state = _currentState || loadState();
        state.counters.errors = (state.counters.errors || 0) + 1;
        state.lastError = {
          t: Date.now(),
          phase: 'fatal',
          message: String(e.message || e).slice(0, 500),
        };
        audit(state, 'fatal', { message: String(e.message || e).slice(0, 200) });
        saveState(state);

        const errSummary = String(e.message || e).slice(0, 400);
        await tgSend(
          `💥 <b>Watcher crashed</b>\n\n` +
          `<code>${escapeHtml(errSummary)}</code>\n\n` +
          `🕐 ${new Date().toISOString().slice(11, 19)} UTC\n` +
          `🔁 Iteration ${iter}/${maxIter}`,
          { silent: false }
        );
      } catch (notifyErr) {
        log.warn('Failed to notify about crash:', notifyErr.message);
      }
    } finally {
      try { await browser.close(); } catch {}
    }

    if (result === RESULT.COMPLETED) { log.ok('Run completed'); break; }
    if (result === RESULT.REBUILD)   { log.info('Rebuilding…'); await sleep(2_000); continue; }
    if (result === RESULT.FATAL)     { log.err('Fatal — aborting'); break; }
  }

  try {
    if (_currentState) saveState(_currentState);
    else saveState(loadState());
  } catch {}

  log.info(`Exiting — RSS ${rssMb()} MB`);
})();
