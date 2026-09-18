/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v9.3 — Root Solution Edition
 *  ---------------------------------------------------------------------------
 *  Key change:
 *   • AJAX interception via browser page to capture EXACT parameters
 *   • Uses the same params the DULMS page uses → returns ALL courses
 *   • Caches the course list for 5 minutes
 *   • Falls back to direct API if interception fails
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

  sniperIntervalMs:     10 * 1000,
  securityIntervalMs:   10 * 60 * 1000,
  telegramPollMs:       5  * 1000,
  heartbeatMs:          500,

  startupBriefHours:    12,
  notifyWithSound:      true,
  maxTelegramPerMin:    20,
  courseCacheTtlMs:     5 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════════════
//  RUNTIME CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  baseUrl:      'https://dulms.deltauniv.edu.eg',
  loginUrl:     'https://dulms.deltauniv.edu.eg/Login.aspx',
  coursesPageUrl: 'https://dulms.deltauniv.edu.eg/Registered/CoursesRegisteration',

  API: {
    coursesList:    '/Registered/GetStudentResiterationCourses',
    courseSchedule: '/Registered/GetCourseSchedual',
    regInfo:        '/Registered/GetStudentResiterationInfo',
  },

  username:      process.env.DULMS_USERNAME || '',
  password:      process.env.DULMS_PASSWORD || '',
  tgToken:       process.env.TG_TOKEN       || '',
  tgChatId:      String(process.env.TG_CHAT_ID || ''),
  durationMin:   parseFloat(process.env.DURATION_MIN || '50'),

  cookieMaxAgeMin:  15,
  netTimeoutMs:     15_000,
  pageTimeoutMs:    60_000,

  memWarnMb:        700,
  memRestartMb:     900,

  stateFile:        path.join(process.cwd(), '.dulms-state.json'),
  sessionFile:      path.join(process.cwd(), '.dulms-session.json'),
  sessionMetaFile:  path.join(process.cwd(), '.dulms-session-meta.json'),
  auditFile:        path.join(process.cwd(), '.dulms-audit.log'),
  auditMaxBytes:    1 * 1024 * 1024,

  timezone:         'Africa/Cairo',
  stateVersion:     93,
};

const RESULT = Object.freeze({
  COMPLETED: 'completed',
  REBUILD:   'rebuild',
  FATAL:     'fatal',
});

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

const normalizeCode = (s) =>
  String(s || '').toUpperCase().replace(/\s+/g, '').replace(/-/g, '');

function statusLabel(status) {
  const map = {
    0: '❌ Failed', 1: '✅ Passed', 2: '↩️ Withdrawn',
    3: '⏳ Pending', 4: '📝 Registered', 5: '🆕 Never',
  };
  if (status == null) return '❓ Unknown';
  return map[Number(status)] || `❓ Unknown (${status})`;
}

async function withTimeout(promise, ms, label = 'op') {
  let t;
  const timeout = new Promise((_, rej) =>
    t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)
  );
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(t); }
}

async function retry(fn, { attempts = 3, baseMs = 800, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      const retryable = /timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|Target closed|net::|aborted/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      const backoff = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
      log.warn(`[retry ${label}] attempt ${i + 1}/${attempts}: ${msg} — retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

const rssMb = () => {
  try { return Math.round(process.memoryUsage().rss / 1024 / 1024); }
  catch { return 0; }
};

function rotateAuditIfNeeded() {
  try {
    if (!fs.existsSync(CONFIG.auditFile)) return;
    const stat = fs.statSync(CONFIG.auditFile);
    if (stat.size > CONFIG.auditMaxBytes) {
      const backup = CONFIG.auditFile + '.old';
      try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch {}
      fs.renameSync(CONFIG.auditFile, backup);
    }
  } catch {}
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
    targetIsLectureOnly:  USER_CONFIG.targetIsLectureOnly,
    openGroupsState:      {},
    lastTgUpdateId:       0,
    tgChatId:             null,
    watchedGroups:        [...USER_CONFIG.preferredGroups],
    startupBriefedAt:     0,
    paused:               false,
    audit:                [],
    counters: {
      opens: 0, closes: 0, drops: 0, adds: 0,
      relogins: 0, errors: 0, alertsSent: 0,
    },
  };
}

function migrateState(s) {
  if (!s || typeof s !== 'object') return defaultState();
  const base = defaultState();
  const merged = {
    ...base, ...s,
    counters: { ...base.counters, ...(s.counters || {}) },
  };
  merged.audit = Array.isArray(merged.audit) ? merged.audit.slice(-500) : [];
  if (!Array.isArray(merged.watchedGroups)) merged.watchedGroups = [];
  if (!merged.openGroupsState || typeof merged.openGroupsState !== 'object') {
    merged.openGroupsState = {};
  }
  merged.version = CONFIG.stateVersion;
  return merged;
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return migrateState(JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')));
    }
  } catch (e) { log.warn('State load failed:', e.message); }
  return defaultState();
}

function saveState(state) {
  try { atomicWrite(CONFIG.stateFile, state); }
  catch (e) { log.warn('State save failed:', e.message); }
}

function audit(state, event, details = {}) {
  const entry = { t: Date.now(), event, ...details };
  state.audit.push(entry);
  if (state.audit.length > 500) state.audit = state.audit.slice(-500);
  try {
    rotateAuditIfNeeded();
    fs.appendFileSync(CONFIG.auditFile, JSON.stringify(entry) + '\n');
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
const tgQueue = [];
let tgSending = false;
const tgTimestamps = [];

async function tgSend(html, { silent = false, replyMarkup = null } = {}) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId || !html) return;
  tgQueue.push({ html, silent, replyMarkup });
  if (tgSending) return;
  tgSending = true;
  try {
    while (tgQueue.length > 0) {
      const now = Date.now();
      while (tgTimestamps.length && now - tgTimestamps[0] > 60_000) tgTimestamps.shift();
      if (tgTimestamps.length >= USER_CONFIG.maxTelegramPerMin) {
        const wait = 60_000 - (now - tgTimestamps[0]) + 100;
        await sleep(wait);
      }
      tgTimestamps.push(Date.now());

      const { html: msg, silent: sil, replyMarkup: rm } = tgQueue.shift();
      const payload = {
        chat_id: CONFIG.tgChatId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: sil,
      };
      if (rm) payload.reply_markup = rm;

      try {
        const res = await withTimeout(
          fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          CONFIG.netTimeoutMs, 'tg-send'
        );
        const body = await res.json().catch(() => ({}));
        if (!body.ok && body.error_code === 429) {
          const retry = (body.parameters && body.parameters.retry_after) || 5;
          tgQueue.unshift({ html: msg, silent: sil, replyMarkup: rm });
          await sleep(retry * 1000);
        }
      } catch (e) { log.warn('TG send failed:', e.message); }
      await sleep(1_100);
    }
  } finally { tgSending = false; }
}

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Status' }, { text: '🎯 Groups' }],
    [{ text: '🔥 Open' },   { text: '🔍 Find' }],
    [{ text: '👁️ Watch' },  { text: '📋 Audit' }],
    [{ text: '⏸️ Pause' },  { text: '▶️ Resume' }],
    [{ text: '🔄 Reset' },  { text: '❓ Help' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const BUTTON_MAP = {
  '📊 Status': '/status', '🎯 Groups': '/groups', '🔥 Open': '/open',
  '🔍 Find': '/find', '👁️ Watch': '/watch', '📋 Audit': '/audit',
  '⏸️ Pause': '/pause', '▶️ Resume': '/resume', '🔄 Reset': '/reset', '❓ Help': '/help',
};

async function sendMainKeyboard() {
  await tgSend(`🎛️ <b>لوحة التحكم</b>\nاستخدم الأزرار تحت أو اكتب /help`, { replyMarkup: MAIN_KEYBOARD });
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
const BOT_COMMANDS = [
  { command: 'start',    description: '🟢 Bot alive + main keyboard' },
  { command: 'status',   description: '📊 Full status report' },
  { command: 'baseline', description: '🛡️ Registered courses' },
  { command: 'find',     description: '🔍 Search courses by code/name' },
  { command: 'diag',     description: '🩺 Diagnostic dump of all courses' },
  { command: 'groups',   description: '🎯 Target course groups' },
  { command: 'open',     description: '🔥 Currently open groups' },
  { command: 'info',     description: 'ℹ️ Registration period info' },
  { command: 'target',   description: '🎯 Set target (registerable only)' },
  { command: 'watch',    description: '👁️ Watch a group' },
  { command: 'unwatch',  description: '🚫 Stop watching (or "all")' },
  { command: 'reset',    description: '🔄 Reset target + watch list' },
  { command: 'audit',    description: '📜 Last 10 events' },
  { command: 'pause',    description: '⏸️ Pause checks' },
  { command: 'resume',   description: '▶️ Resume checks' },
  { command: 'help',     description: '❓ Command list' },
];

async function registerBotCommands() {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS, scope: { type: 'chat', chat_id: CONFIG.tgChatId } }),
    });
    log.ok(`Registered ${BOT_COMMANDS.length} bot commands`);
  } catch (e) { log.warn('Command registration failed:', e.message); }
}

async function handleTelegramCommands(state, api, timers) {
  if (!CONFIG.tgToken) return;
  try {
    const offset = state.lastTgUpdateId ? state.lastTgUpdateId + 1 : -1;
    const res = await withTimeout(
      fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${offset}&timeout=0`),
      CONFIG.netTimeoutMs, 'tg-poll'
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const upd of data.result) {
      state.lastTgUpdateId = Math.max(state.lastTgUpdateId || 0, upd.update_id);
      if (upd.callback_query) {
        const cb = upd.callback_query;
        const chatId = String(cb.message?.chat?.id || cb.from?.id);
        if (chatId !== CONFIG.tgChatId) continue;
        await handleCallback(cb, state, api);
        continue;
      }
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (chatId !== CONFIG.tgChatId) { log.warn(`Unauthorized: ${chatId}`); continue; }

      const text = msg.text.trim();
      let cmd, args;
      if (BUTTON_MAP[text]) { cmd = BUTTON_MAP[text]; args = []; }
      else { const parts = text.split(/\s+/); cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); args = parts.slice(1); }
      await dispatchCommand(cmd, args, state, api, timers);
    }
    saveState(state);
  } catch { /* silent */ }
}

async function answerCallback(cbId, text = '', showAlert = false) {
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: showAlert }),
    });
  } catch {}
}

async function handleCallback(cb, state, api) {
  const data = cb.data || '';
  await answerCallback(cb.id);
  const [action, ...rest] = data.split(':');
  const target = rest.join(':').trim();
  if (!target) return;

  if (action === 'watch') {
    if (!state.watchedGroups.includes(target)) {
      state.watchedGroups.push(target);
      audit(state, 'watch_add', { group: target });
      saveState(state);
    }
    await tgSend(`👁️ Added: <b>${escapeHtml(target)}</b>`);
  } else if (action === 'unwatch') {
    state.watchedGroups = state.watchedGroups.filter(g => g !== target);
    audit(state, 'watch_remove', { group: target });
    saveState(state);
    await tgSend(`🚫 Removed: <b>${escapeHtml(target)}</b>`);
  }
}

async function dispatchCommand(cmd, args, state, api, timers) {
  const now = Date.now();
  const uptimeMin = Math.floor((now - (state.startedAt || now)) / 60_000);

  switch (cmd) {
    case '/start': {
      await sendMainKeyboard();
      await dispatchCommand('/status', [], state, api, timers);
      break;
    }

    case '/status': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code>`).join(' ')
        : '—';
      const target = state.targetCourseId
        ? `<code>${escapeHtml(state.targetCourseId)}</code>`
        : '⏳ resolving';
      const targetStatus = state.targetCourseStatus != null ? statusLabel(state.targetCourseStatus) : '—';
      const watched = state.watchedGroups.length ? state.watchedGroups.map(escapeHtml).join(', ') : '<i>all</i>';
      const openCount = Object.values(state.openGroupsState).filter(g => g.open).length;

      await tgSend(
        `🟢 <b>Watcher v9.3</b>\n` +
        `⏱ Uptime: <b>${uptimeMin} min</b> | 💾 RSS: <b>${rssMb()} MB</b>\n` +
        `${state.paused ? '⏸ <b>PAUSED</b>' : '▶️ Running'}\n\n` +
        `🎯 Target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> (${target})\n` +
        `📋 Status: ${targetStatus}\n` +
        `📚 Mode: <b>${state.targetIsLectureOnly ? 'lectures only' : 'full'}</b>\n` +
        `👁️ Watching: ${watched}\n` +
        `🔥 Open now: <b>${openCount}</b>\n\n` +
        `🛡️ Baseline (${state.registeredCourses.length}): ${regs}\n\n` +
        `📊 <b>Counters:</b>\n` +
        `opens=<b>${state.counters.opens}</b> closes=<b>${state.counters.closes}</b> ` +
        `drops=<b>${state.counters.drops}</b> adds=<b>${state.counters.adds}</b>\n` +
        `relogins=<b>${state.counters.relogins}</b> errors=<b>${state.counters.errors}</b> ` +
        `alerts=<b>${state.counters.alertsSent}</b>`
      );
      break;
    }

    case '/baseline': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.name)}`).join('\n')
        : '— none —';
      const missing = USER_CONFIG.expectedCourses.filter(exp =>
        !state.registeredCourses.some(c => normalizeCode(c.code).includes(normalizeCode(exp)))
      );
      const missingTxt = missing.length
        ? `\n\n⚠️ <b>Missing (${missing.length}):</b>\n` + missing.map(m => `❌ ${escapeHtml(m)}`).join('\n')
        : `\n\n✅ All expected courses present!`;
      await tgSend(`🛡️ <b>Baseline snapshot</b>\n${regs}${missingTxt}`);
      break;
    }

    case '/find': {
      const q = args.join(' ').trim();
      if (!q) { await tgSend(`Usage: <code>/find &lt;code or name&gt;</code>`); break; }
      const r = await api.getCourses({ statuses: '0,1,2,3,4,5', forceRefresh: true });
      if (r.kind !== 'ok' || !r.courses) { await tgSend(`❌ API error: ${r.kind}`); break; }
      const qUp = q.toUpperCase();
      const qNorm = qUp.replace(/\s+/g, '');
      const matches = r.courses.filter(c =>
        String(c.code).toUpperCase().includes(qUp) ||
        String(c.name).toUpperCase().includes(qUp) ||
        String(c.code).toUpperCase().replace(/\s+/g, '').includes(qNorm)
      );
      if (matches.length === 0) {
        await tgSend(`🔍 <b>No matches for "${escapeHtml(q)}"</b>\nTotal: ${r.courses.length}`);
        break;
      }
      let msg = `🔍 <b>${matches.length} match(es):</b>\n\n`;
      matches.slice(0, 20).forEach((c, i) => {
        msg += `${i + 1}. <code>${escapeHtml(c.code)}</code>\n   ${escapeHtml(c.name)}\n   ${statusLabel(c.status)} | ID: <code>${escapeHtml(c.id)}</code>\n\n`;
      });
      if (matches.length > 20) msg += `…+${matches.length - 20} more`;
      await tgSend(msg);
      break;
    }

    case '/diag': {
      const r = await api.getCourses({ statuses: '0,1,2,3,4,5', forceRefresh: true });
      if (r.kind !== 'ok' || !r.courses) { await tgSend(`❌ API error: ${r.kind}`); break; }
      const byStatus = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
      for (const c of r.courses) { const s = Number(c.status); if (byStatus[s]) byStatus[s].push(c.code); }
      let msg = `🩺 <b>Diagnostic Dump</b>\n\n📊 <b>Total: ${r.courses.length} courses</b>\n\n`;
      for (const [s, codes] of Object.entries(byStatus)) {
        if (codes.length === 0) continue;
        msg += `${statusLabel(Number(s))} (${codes.length}):\n<code>${codes.slice(0, 15).map(escapeHtml).join(', ')}</code>\n`;
        if (codes.length > 15) msg += `…+${codes.length - 15} more\n`;
        msg += `\n`;
      }
      await tgSend(msg);
      break;
    }

    case '/groups': {
      if (!state.targetCourseId) { await tgSend(`⚠️ Target not resolved. Try <code>/target GEN101</code>`); break; }
      const r = await api.getCourseSchedule(state.targetCourseId);
      if (r.kind !== 'ok' || !r.groups || r.groups.length === 0) {
        await tgSend(`❌ No groups for <b>${escapeHtml(USER_CONFIG.targetCourse)}</b>.`);
        break;
      }
      const sorted = [...r.groups].sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      let msg = `🎯 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${r.groups.length} groups</b>\n<i>🔥=open · ❄️=full · 👁️=watched</i>\n\n`;
      sorted.slice(0, 20).forEach((g) => {
        const watched = state.watchedGroups.some(w => g.name.toUpperCase().includes(w.toUpperCase()));
        const mark = watched ? '👁️ ' : '';
        const icon = g.available ? '🔥' : '❄️';
        const blocked = g.blocked ? ' 🚫' : '';
        msg += `${mark}${icon} <b>${escapeHtml(g.name)}</b>${blocked} — 💺 ${g.seats}/${g.total}\n`;
        if (g.slots[0]) msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
      });
      if (sorted.length > 20) msg += `\n…+${sorted.length - 20} more`;
      const availableGroups = sorted.filter(g => g.available).slice(0, 8);
      const inlineRows = availableGroups.map(g => ([{ text: `👁️ Watch ${g.name} (${g.seats})`, callback_data: `watch:${g.name}`.slice(0, 64) }]));
      await tgSend(msg, { replyMarkup: inlineRows.length ? { inline_keyboard: inlineRows } : undefined });
      break;
    }

    case '/open': {
      const openGroups = Object.entries(state.openGroupsState).filter(([_, v]) => v.open).map(([name, v]) => ({ name, ...v }));
      if (openGroups.length === 0) { await tgSend(`❄️ <b>No groups open</b>`); break; }
      let msg = `🔥 <b>Open (${openGroups.length}):</b>\n\n`;
      openGroups.forEach((g, i) => { msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`; });
      await tgSend(msg);
      break;
    }

    case '/info': {
      const r = await api.getRegInfo();
      if (r.kind !== 'ok' || !Array.isArray(r.data) || r.data.length === 0) { await tgSend(`❌ API error: ${r.kind}`); break; }
      const info = r.data[0];
      const avail = info.RegAvailabilty;
      const statusTxt = avail === 1 ? '✅ OPEN' : (avail === -1 ? '⏳ NOT STARTED' : '🚫 BLOCKED');
      await tgSend(
        `ℹ️ <b>Registration Info</b>\n\nStatus: <b>${statusTxt}</b>\n` +
        (info.RegAvailabiltyReason ? `<i>${escapeHtml(info.RegAvailabiltyReason)}</i>\n` : '') +
        `\n📅 Reg ends: <b>${escapeHtml(String(info.RegEndDate || '—'))}</b>\n` +
        `💰 Balance: <b>${escapeHtml(String(info.StudentCredit || '—'))} ${escapeHtml(String(info.Currency || ''))}</b>\n` +
        `⏱ Permitted: <b>${escapeHtml(String(info.AcademicAllowedHours || '—'))}</b> hrs\n` +
        `📚 Registered: <b>${escapeHtml(String(info.RegisteredHours || '—'))}</b> hrs`
      );
      break;
    }

    case '/target': {
      const code = args.join(' ').trim();
      if (!code) {
        await tgSend(
          `🎯 <b>Set Target</b>\n\nUsage: <code>/target &lt;course_code&gt;</code>\n\n` +
          `Current: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> ` +
          `(id: ${state.targetCourseId ? `<code>${escapeHtml(state.targetCourseId)}</code>` : 'not resolved'})`
        );
        break;
      }
      log.info(`/target: resolving "${code}"`);
      const resolved = await api.resolveTargetId(code, { onlyRegisterable: true });
      if (resolved) {
        state.targetCourseId = resolved.id;
        state.targetCourseCode = resolved.code;
        state.targetCourseName = resolved.name;
        state.targetCourseStatus = resolved.status;
        state.watchedGroups = [];
        state.openGroupsState = {};
        audit(state, 'target_set_manual', { code, id: resolved.id });
        saveState(state);
        await tgSend(
          `🎯 <b>Target updated</b>\n\nCode: <code>${escapeHtml(resolved.code)}</code>\n` +
          `Name: ${escapeHtml(resolved.name)}\nID: <code>${escapeHtml(resolved.id)}</code>\n` +
          `Status: ${statusLabel(resolved.status)}\n\n<i>Watch list reset.</i>`
        );
      } else {
        const all = await api.resolveTargetId(code, { onlyRegisterable: false });
        if (all) {
          await tgSend(
            `⚠️ <b>"${escapeHtml(code)}" cannot be sniped</b>\n\nCode: <code>${escapeHtml(all.code)}</code>\n` +
            `Status: <b>${statusLabel(all.status)}</b>\n\n<i>Only registerable courses accepted.</i>`
          );
        } else {
          await tgSend(
            `❌ <b>Could not find "${escapeHtml(code)}"</b>\n\nTry <code>/find ${escapeHtml(code.split(/\s+/)[0])}</code>`
          );
        }
      }
      break;
    }

    case '/watch': {
      if (args.length === 0) {
        if (state.watchedGroups.length === 0) {
          await tgSend(`👁️ <b>Watch list: empty</b>\nYou'll receive alerts for <b>ANY group</b>.\n\nUse <code>/groups</code> to see groups.`);
        } else {
          const rows = state.watchedGroups.map(g => ([{ text: `🚫 Unwatch ${g}`, callback_data: `unwatch:${g}`.slice(0, 64) }]));
          let msg = `👁️ <b>Watch list (${state.watchedGroups.length}):</b>\n\n`;
          state.watchedGroups.forEach((g, i) => { msg += `${i + 1}. <code>${escapeHtml(g)}</code>\n`; });
          await tgSend(msg, { replyMarkup: { inline_keyboard: rows } });
        }
        break;
      }
      const grp = args.join(' ').trim();
      if (!state.watchedGroups.includes(grp)) {
        state.watchedGroups.push(grp);
        audit(state, 'watch_add', { group: grp });
        saveState(state);
      }
      await tgSend(`👁️ Now watching: <b>${escapeHtml(grp)}</b>`);
      break;
    }

    case '/unwatch': {
      if (args.length === 0) { await tgSend(`Usage: <code>/unwatch &lt;group&gt;</code> or <code>/unwatch all</code>`); break; }
      const target = args.join(' ').trim();
      if (target.toLowerCase() === 'all') {
        const count = state.watchedGroups.length;
        state.watchedGroups = [];
        audit(state, 'watch_clear');
        saveState(state);
        await tgSend(`🚫 Cleared (was ${count}).`);
        break;
      }
      state.watchedGroups = state.watchedGroups.filter(g => g !== target);
      audit(state, 'watch_remove', { group: target });
      saveState(state);
      await tgSend(`🚫 Stopped watching: <b>${escapeHtml(target)}</b>`);
      break;
    }

    case '/reset': {
      state.targetCourseId = null;
      state.targetCourseCode = null;
      state.targetCourseName = null;
      state.targetCourseStatus = null;
      state.watchedGroups = [];
      state.openGroupsState = {};
      audit(state, 'reset');
      saveState(state);
      await tgSend(`🔄 <b>Reset complete</b>`);
      break;
    }

    case '/audit': {
      const last = state.audit.slice(-10).map(e =>
        `• <code>${new Date(e.t).toISOString().slice(11,19)}</code> ${escapeHtml(e.event)}`
      ).join('\n');
      await tgSend(`📜 <b>Last 10 events</b>\n${last || '—'}`);
      break;
    }

    case '/pause': {
      state.paused = true; audit(state, 'paused'); saveState(state);
      await tgSend('⏸️ <b>Paused</b>');
      break;
    }

    case '/resume': {
      state.paused = false; audit(state, 'resumed'); saveState(state);
      await tgSend('▶️ <b>Resumed</b>');
      break;
    }

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
  } catch {}
  return Infinity;
}

function cleanupSession() {
  try { if (fs.existsSync(CONFIG.sessionFile)) fs.unlinkSync(CONFIG.sessionFile); } catch {}
}

async function saveSession(context) {
  try {
    await context.storageState({ path: CONFIG.sessionFile });
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

async function createRequestContext(browser, useCookies = true) {
  const opts = {
    baseURL: CONFIG.baseUrl,
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' },
  };
  if (useCookies && fs.existsSync(CONFIG.sessionFile)) opts.storageState = CONFIG.sessionFile;
  return browser.newContext(opts);
}

async function loginAndCaptureCookies(browser) {
  log.info('Logging in via headless page…');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.route('**/*', (r) => {
    const t = r.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') return r.abort();
    return r.continue();
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  await retry(async () => {
    await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeoutMs });
    await page.fill('input[type="text"]', CONFIG.username);
    await page.fill('input[type="password"]', CONFIG.password);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);
    if (page.url().includes('/Login.aspx')) throw new Error('Login failed');
  }, { attempts: 3, baseMs: 1_500, label: 'login' });

  await saveSession(context);
  await context.close();
  log.ok('Logged in — cookies saved');
}

// ═══════════════════════════════════════════════════════════════════════════
//  API CLIENT — with AJAX interception
// ═══════════════════════════════════════════════════════════════════════════
function classifyApiResponse(res, body) {
  if (!res) return { kind: 'net' };
  if (res.status === 302 || res.status === 401) return { kind: 'session_dead' };
  if (res.status >= 500) return { kind: 'soft_server' };
  if (!res.ok) return { kind: 'http', status: res.status };
  const s = String(body || '').trim();
  if (s === '' || s === 'null' || s === '-1') return { kind: 'session_dead' };
  if (s[0] === '<') {
    if (/login|signin|Login\.aspx/i.test(s)) return { kind: 'session_dead' };
    return { kind: 'soft_server' };
  }
  let data;
  try { data = JSON.parse(s); } catch { return { kind: 'structural' }; }
  return { kind: 'ok', data };
}

function makeApi(request, browser) {
  let courseCache = { ts: 0, data: null };

  async function call(method, url, { params, data } = {}) {
    const fullUrl = params ? `${url}?${new URLSearchParams(params).toString()}` : url;
    const opts = { method, timeout: CONFIG.netTimeoutMs };
    if (data) { opts.data = data; opts.headers = { 'Content-Type': 'application/json; charset=utf-8' }; }
    const res = await request.fetch(fullUrl, opts);
    const body = await res.text().catch(() => '');
    return classifyApiResponse(res, body);
  }

  return {
    async getCourseSchedule(courseId) {
      const r = await retry(() => call('GET', CONFIG.API.courseSchedule, { params: { CourseId: courseId } }), { label: 'getCourseSchedule' });
      if (r.kind !== 'ok') return r;
      if (!Array.isArray(r.data)) return { kind: 'structural' };

      const groups = {};
      let hasSubgroups = false;
      for (const item of r.data) {
        if (!item) continue;
        if (item.Type === 'SubGroup') { hasSubgroups = true; continue; }
        if (item.Type !== 'Group') continue;
        const gid = item.GroupId;
        if (gid == null) continue;
        if (!groups[gid]) {
          const rawName = String(item.GroupName || '').trim();
          const shortName = String(item.ShortName || '').trim();
          const isUni = !!item.IsUniversity;
          let displayName;
          if (isUni && shortName && rawName) displayName = `${shortName}-${rawName}`;
          else if (rawName) displayName = rawName;
          else if (shortName) displayName = `${shortName}-${gid}`;
          else displayName = `Group-${gid}`;
          groups[gid] = { id: gid, name: displayName, rawName, shortName, isUniversity: isUni, blocked: !!item.IsBlocked, selected: !!item.IsSelected, total: parseInt(item.StudentsCount) || 0, registered: parseInt(item.RegisteredCount) || 0, slots: [] };
        }
        groups[gid].slots.push({ day: item.DayWeekName, time: item.Time, hall: item.ClassRoomName, staff: item.Staff });
      }
      const list = Object.values(groups).map(g => ({ ...g, seats: g.total - g.registered, available: !g.blocked && (g.total - g.registered) > 0 }));
      return { kind: 'ok', groups: list, hasSubgroups };
    },

    // ⭐⭐⭐ KEY FIX: Intercept AJAX from the real browser page
    async getCourses({ statuses = '3,4', groups = '-1', virtual = false, forceRefresh = false } = {}) {
      if (!forceRefresh && courseCache.data && Date.now() - courseCache.ts < USER_CONFIG.courseCacheTtlMs) {
        return { kind: 'ok', courses: courseCache.data };
      }

      log.info('getCourses: opening CoursesRegisteration page to intercept AJAX…');
      const page = await browser.newPage();
      let interceptedData = null;

      try {
        // Set up response listener BEFORE navigation
        page.on('response', async (response) => {
          const url = response.url();
          if (url.includes('/Registered/GetStudentResiterationCourses')) {
            try {
              const json = await response.json();
              if (Array.isArray(json) && json.length > 0) {
                interceptedData = json;
                log.ok(`Intercepted AJAX: ${json.length} courses`);
              }
            } catch (e) { /* not JSON */ }
          }
        });

        await page.goto(CONFIG.coursesPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // Wait for the AJAX to fire (up to 15 seconds)
        for (let i = 0; i < 30 && !interceptedData; i++) {
          await sleep(500);
        }

        if (!interceptedData) {
          log.warn('Interception failed — falling back to direct API call');
          const params = { GradeStatusIds: statuses, IsVirtualRegisteration: virtual };
          if (groups !== '' && groups != null) params.GroupsIds = groups;
          const r = await call('GET', CONFIG.API.coursesList, { params });
          if (r.kind !== 'ok') return r;
          interceptedData = r.data;
        }

        const data = Array.isArray(interceptedData) ? interceptedData : [];
        const list = data.map(c => ({
          id: String(c.CourseId),
          code: c.Code || '',
          name: c.Name || '',
          status: c.GradeStatusId,
          group: c.GrpName,
        }));

        courseCache = { ts: Date.now(), data: list };
        log.ok(`getCourses: cached ${list.length} courses`);
        return { kind: 'ok', courses: list };
      } finally {
        try { await page.close(); } catch {}
      }
    },

    async getRegInfo() {
      return retry(() => call('POST', CONFIG.API.regInfo), { label: 'getRegInfo' });
    },

    async resolveTargetId(query, { onlyRegisterable = true } = {}) {
      log.info(`resolveTargetId: query="${query}" onlyRegisterable=${onlyRegisterable}`);
      const r = await this.getCourses({ statuses: '0,1,2,3,4,5', forceRefresh: true });
      if (r.kind !== 'ok' || !r.courses) return null;

      const targetNorm = normalizeCode(query);
      const targetRaw = String(query).toUpperCase().trim();

      let found = r.courses.find(c => normalizeCode(c.code) === targetNorm);
      if (found) { log.ok(`L1: ${found.code}`); return found; }
      found = r.courses.find(c => String(c.code).toUpperCase().trim() === targetRaw);
      if (found) { log.ok(`L2: ${found.code}`); return found; }
      found = r.courses.find(c => normalizeCode(c.code).includes(targetNorm));
      if (found) { log.ok(`L3: ${found.code}`); return found; }
      found = r.courses.find(c => String(c.name).toUpperCase().includes(targetRaw));
      if (found) { log.ok(`L4: ${found.code}`); return found; }
      const qNoSp = targetRaw.replace(/\s+/g, '');
      found = r.courses.find(c => String(c.name).toUpperCase().replace(/\s+/g, '').includes(qNoSp));
      if (found) { log.ok(`L5: ${found.code}`); return found; }

      const tokens = targetRaw.split(/\s+/).filter(t => t.length >= 3);
      if (tokens.length > 0) {
        found = r.courses.find(c => {
          const hay = `${c.code} ${c.name}`.toUpperCase();
          return tokens.every(t => hay.includes(t));
        });
        if (found) { log.ok(`L6: ${found.code}`); return found; }
      }

      log.warn(`resolveTargetId: FAILED (${r.courses.length} courses)`);
      return null;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY TASK
// ═══════════════════════════════════════════════════════════════════════════
function sameCourse(a, b) {
  if (a.id && b.id) return String(a.id) === String(b.id);
  return a.code && b.code && normalizeCode(a.code) === normalizeCode(b.code);
}

async function verifyRegistrationStability(api, state) {
  const r = await api.getCourses({ statuses: '3,4' });
  if (r.kind !== 'ok') return { kind: r.kind };

  const currentReg = r.courses.map(c => ({ id: c.id, code: c.code, name: c.name }));

  if (state.registeredCourses.length === 0) {
    state.registeredCourses = currentReg;
    log.ok(`Baseline set: ${currentReg.length} courses`);
    audit(state, 'baseline_set', { count: currentReg.length, codes: currentReg.map(c => c.code) });
    const missing = USER_CONFIG.expectedCourses.filter(exp =>
      !currentReg.some(c => normalizeCode(c.code).includes(normalizeCode(exp)))
    );
    if (missing.length > 0) {
      await tgSend(`⚠️ <b>Baseline note</b>\nNot yet registered:\n${missing.map(m => `• ${escapeHtml(m)}`).join('\n')}\n\nSniper hunting. 🎯`);
    }
    return { kind: 'ok' };
  }

  for (const saved of state.registeredCourses) {
    if (!currentReg.some(c => sameCourse(c, saved))) {
      state.counters.drops++;
      log.err(`COURSE DROPPED: ${saved.code}`);
      audit(state, 'course_dropped', { code: saved.code });
      await tgSend(`🚨 <b>Registration change!</b>\n❌ <b>${escapeHtml(saved.code)}</b> — ${escapeHtml(saved.name)}\n\nOpen DULMS!`);
    }
  }
  for (const curr of currentReg) {
    if (!state.registeredCourses.some(s => sameCourse(s, curr))) {
      state.counters.adds++;
      log.ok(`NEW COURSE: ${curr.code}`);
      audit(state, 'course_added', { code: curr.code });
      await tgSend(`✅ <b>New course!</b>\n➕ <b>${escapeHtml(curr.code)}</b> — ${escapeHtml(curr.name)}`);
    }
  }
  state.registeredCourses = currentReg;
  return { kind: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNIPER TASK
// ═══════════════════════════════════════════════════════════════════════════
function filterMatchingGroups(groups, watched) {
  if (!Array.isArray(groups)) return [];
  const available = groups.filter(g => g && g.available && typeof g.name === 'string' && g.name.length > 0);
  if (!Array.isArray(watched) || watched.length === 0) return available;
  const w = watched.filter(x => typeof x === 'string' && x.length > 0).map(x => x.toUpperCase());
  if (w.length === 0) return available;
  return available.filter(g => w.some(pattern => String(g.name || '').toUpperCase().includes(pattern)));
}

async function sniperCheck(api, state) {
  if (!state.targetCourseId) return { kind: 'no_target' };
  const r = await api.getCourseSchedule(state.targetCourseId);
  if (r.kind !== 'ok') return r;

  const openGroups = filterMatchingGroups(r.groups, state.watchedGroups);
  const currentlyOpen = new Set(openGroups.map(g => g.name));
  if (!state.openGroupsState) state.openGroupsState = {};

  const newlyOpened = [];
  for (const g of openGroups) {
    if (!g || typeof g.name !== 'string') continue;
    if (!state.openGroupsState[g.name]?.open) newlyOpened.push(g);
  }
  const closed = [];
  for (const [name, prev] of Object.entries(state.openGroupsState)) {
    if (prev.open && !currentlyOpen.has(name)) closed.push(name);
  }
  for (const g of openGroups) state.openGroupsState[g.name] = { open: true, lastSeen: Date.now(), seats: g.seats, total: g.total };
  for (const name of closed) { if (state.openGroupsState[name]) { state.openGroupsState[name].open = false; state.openGroupsState[name].seats = 0; } }

  if (newlyOpened.length > 0) {
    state.counters.opens += newlyOpened.length;
    state.counters.alertsSent++;
    audit(state, 'target_open', { count: newlyOpened.length, groups: newlyOpened.map(g => g.name) });
    let msg = `🎉 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${newlyOpened.length} opened!</b>\n\n`;
    newlyOpened.slice(0, 8).forEach((g, i) => {
      msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      if (g.slots[0]) msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
    });
    msg += `\n🔗 <b>Open DULMS NOW!</b>`;
    await tgSend(msg, { silent: !USER_CONFIG.notifyWithSound });
    saveState(state);
  }
  if (closed.length > 0) {
    state.counters.closes += closed.length;
    log.info(`Closed: ${closed.join(', ')}`);
    audit(state, 'target_close', { groups: closed });
    saveState(state);
  }
  return { kind: 'open', groups: openGroups };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHAT MIGRATION
// ═══════════════════════════════════════════════════════════════════════════
async function detectChatMigration(state) {
  if (!CONFIG.tgChatId) return;
  if (!state.tgChatId) { state.tgChatId = CONFIG.tgChatId; return; }
  if (state.tgChatId !== CONFIG.tgChatId) {
    log.warn(`Chat migration: ${state.tgChatId} → ${CONFIG.tgChatId}`);
    audit(state, 'chat_migration', { from: state.tgChatId, to: CONFIG.tgChatId });
    state.tgChatId = CONFIG.tgChatId;
    const regs = state.registeredCourses.map(c => `• ${escapeHtml(c.code)}`).join('\n') || '—';
    await tgSend(`🔄 <b>Chat migration</b>\n\nBaseline (${state.registeredCourses.length}):\n${regs}\n\nTarget: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b>`, { replyMarkup: MAIN_KEYBOARD });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser, deadline) {
  if (!fs.existsSync(CONFIG.sessionFile) || sessionAgeMinutes() > CONFIG.cookieMaxAgeMin) {
    cleanupSession();
    await loginAndCaptureCookies(browser);
  }
  let context = await createRequestContext(browser, true);
  let request = context.request;
  let api = makeApi(request, browser);

  const state = loadState();
  state.startedAt = Date.now();
  if (USER_CONFIG.targetCourseId) state.targetCourseId = USER_CONFIG.targetCourseId;
  await detectChatMigration(state);
  saveState(state);

  const startupGapMs = USER_CONFIG.startupBriefHours * 60 * 60_000;
  if (Date.now() - state.startupBriefedAt > startupGapMs) {
    state.startupBriefedAt = Date.now();
    await tgSend(`🚀 <b>Watcher v9.3 online</b>\n\n🎯 ${escapeHtml(USER_CONFIG.targetCourse)}\n🛡️ ${state.registeredCourses.length} courses\n\nSend /help.`, { replyMarkup: MAIN_KEYBOARD });
    saveState(state);
  }

  log.step(`STARTED — Target: ${USER_CONFIG.targetCourse}`);

  const timers = { sniper: Date.now(), security: Date.now(), telegram: Date.now() + 2_000, memory: Date.now() + 60_000 };

  while (Date.now() < deadline) {
    const now = Date.now();
    if (state.paused) { await sleep(USER_CONFIG.heartbeatMs * 2); continue; }

    if (now >= timers.telegram) {
      await handleTelegramCommands(state, api, timers);
      timers.telegram = Date.now() + USER_CONFIG.telegramPollMs;
    }

    if (now >= timers.memory) {
      const mb = rssMb();
      if (mb >= CONFIG.memRestartMb) {
        log.err(`Memory critical (${mb} MB) — rebuild`);
        audit(state, 'browser_restart', { rssMb: mb });
        saveState(state);
        try { await context.close(); } catch {}
        return RESULT.REBUILD;
      }
      timers.memory = Date.now() + 60_000;
    }

    if (now >= timers.security) {
      const sr = await verifyRegistrationStability(api, state);
      if (sr.kind === 'ok') {
        if (!state.targetCourseId) {
          const resolved = await api.resolveTargetId(USER_CONFIG.targetCourse);
          if (resolved) {
            state.targetCourseId = resolved.id;
            state.targetCourseCode = resolved.code;
            state.targetCourseName = resolved.name;
            state.targetCourseStatus = resolved.status;
            log.ok(`Target resolved: ${resolved.code} → ${resolved.id}`);
            audit(state, 'target_resolved', resolved);
            await tgSend(`🎯 <b>Target resolved</b>\n\nCode: <code>${escapeHtml(resolved.code)}</code>\nStatus: ${statusLabel(resolved.status)}`);
          }
        }
        timers.security = Date.now() + USER_CONFIG.securityIntervalMs;
        saveState(state);
      } else if (sr.kind === 'session_dead') {
        log.warn('Security: session dead');
        state.counters.relogins++;
        try { await context.close(); } catch {}
        cleanupSession();
        await loginAndCaptureCookies(browser);
        context = await createRequestContext(browser, true);
        request = context.request;
        api = makeApi(request, browser);
        timers.security = Date.now() + 5_000;
      } else {
        state.counters.errors++;
        timers.security = Date.now() + 60_000;
      }
    }

    if (state.targetCourseId && now >= timers.sniper) {
      const sr = await sniperCheck(api, state);
      if (sr.kind === 'session_dead') {
        state.counters.relogins++;
        try { await context.close(); } catch {}
        cleanupSession();
        await loginAndCaptureCookies(browser);
        context = await createRequestContext(browser, true);
        request = context.request;
        api = makeApi(request, browser);
        timers.sniper = Date.now() + 5_000;
      } else if (sr.kind === 'soft_server' || sr.kind === 'http') {
        state.counters.errors++;
        timers.sniper = Date.now() + 30_000;
      } else if (sr.kind === 'structural') {
        state.counters.errors++;
        timers.sniper = Date.now() + 60_000;
      } else {
        timers.sniper = Date.now() + USER_CONFIG.sniperIntervalMs;
      }
    }

    await sleep(USER_CONFIG.heartbeatMs);
  }

  try { await context.close(); } catch {}
  return RESULT.COMPLETED;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════
let shuttingDown = false;
function setupShutdownHandlers() {
  const handler = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`Received ${signal} — saving state`);
    try { saveState(loadState()); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  if (!CONFIG.username || !CONFIG.password) { log.err('Missing credentials'); process.exit(1); }
  setupShutdownHandlers();

  const startTs = Date.now();
  const deadline = startTs + CONFIG.durationMin * 60_000;

  log.info(`Watcher v9.3 starting — PID ${process.pid}, RSS ${rssMb()} MB, deadline in ${CONFIG.durationMin} min`);

  await registerBotCommands();

  let iterations = 0;
  while (Date.now() < deadline && iterations < 10) {
    iterations++;
    const browser = await createBrowser();
    let result;
    try { result = await runScan(browser, deadline); }
    catch (e) { log.err('Fatal:', e.message); result = RESULT.FATAL; }
    finally { try { await browser.close(); } catch {} }

    if (result === RESULT.COMPLETED) { log.ok('Run completed'); break; }
    if (result === RESULT.REBUILD) { log.info('Rebuilding…'); await sleep(2_000); continue; }
    if (result === RESULT.FATAL) { log.err('Fatal — aborting'); break; }
  }

  try { saveState(loadState()); } catch {}
  log.info(`Watcher v9.3 exiting — final RSS ${rssMb()} MB`);
})();
