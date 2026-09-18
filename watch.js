/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v9.2 — Diagnostic Edition
 *  ---------------------------------------------------------------------------
 *  New in v9.2:
 *   • Multi-source resolveTargetId (3 sources × 6 layers)
 *   • /find command — search ALL courses with status
 *   • /diag command — full diagnostic dump
 *   • Registerable-only filter (rejects already-registered courses)
 *   • Auto-reset watch list on target change
 *   • Course list caching (5 min TTL)
 *   • Better session-dead detection
 *   • statusLabel helper for readability
 *   • Detailed failure logging
 *   • GroupsIds fallback (tries '', -1, then missing)
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

  courseCacheTtlMs:     5 * 60 * 1000,   // 5 min cache for course lists
};

// ═══════════════════════════════════════════════════════════════════════════
//  RUNTIME CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  baseUrl:      'https://dulms.deltauniv.edu.eg',
  loginUrl:     'https://dulms.deltauniv.edu.eg/Login.aspx',

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
  stateVersion:     92,
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
    0: '❌ Failed',
    1: '✅ Passed',
    2: '↩️ Withdrawn',
    3: '⏳ Pending Verification',
    4: '📝 Registered',
    5: '🆕 Never Registered',
  };
  if (status == null) return '❓ Unknown';
  return map[Number(status)] || `❓ Unknown (${status})`;
}

function statusIsRegisterable(status) {
  const s = Number(status);
  return s === 0 || s === 2 || s === 5; // failed, withdrawn, never
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
    targetResolveFailures: 0,   // ← NEW: count consecutive failures
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
  input_field_placeholder: 'اختر أمرًا أو اكتب /help',
};

const BUTTON_MAP = {
  '📊 Status':   '/status',
  '🎯 Groups':   '/groups',
  '🔥 Open':     '/open',
  '🔍 Find':     '/find',
  '👁️ Watch':    '/watch',
  '📋 Audit':    '/audit',
  '⏸️ Pause':    '/pause',
  '▶️ Resume':   '/resume',
  '🔄 Reset':    '/reset',
  '❓ Help':     '/help',
};

async function sendMainKeyboard() {
  await tgSend(
    `🎛️ <b>لوحة التحكم</b>\nاستخدم الأزرار تحت أو اكتب /help`,
    { replyMarkup: MAIN_KEYBOARD }
  );
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
      body: JSON.stringify({
        commands: BOT_COMMANDS,
        scope: { type: 'chat', chat_id: CONFIG.tgChatId },
      }),
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
      if (chatId !== CONFIG.tgChatId) {
        log.warn(`Unauthorized chat: ${chatId}`);
        audit(state, 'unauthorized', { chatId });
        continue;
      }

      const text = msg.text.trim();
      let cmd, args;
      if (BUTTON_MAP[text]) {
        cmd = BUTTON_MAP[text];
        args = [];
      } else {
        const parts = text.split(/\s+/);
        cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
        args = parts.slice(1);
      }

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
    await tgSend(`👁️ Added to watch list: <b>${escapeHtml(target)}</b>`);
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
    // ─────────────────────────────────────────────────────────────
    case '/start': {
      await sendMainKeyboard();
      await dispatchCommand('/status', [], state, api, timers);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/status': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code>`).join(' ')
        : '—';
      const target = state.targetCourseId
        ? `<code>${escapeHtml(state.targetCourseId)}</code>`
        : '⏳ resolving';
      const targetStatus = state.targetCourseStatus != null
        ? statusLabel(state.targetCourseStatus)
        : '—';
      const watched = state.watchedGroups.length
        ? state.watchedGroups.map(escapeHtml).join(', ')
        : '<i>all groups</i>';
      const openCount = Object.values(state.openGroupsState).filter(g => g.open).length;

      await tgSend(
        `🟢 <b>Watcher v9.2</b>\n` +
        `⏱ Uptime: <b>${uptimeMin} min</b> | 💾 RSS: <b>${rssMb()} MB</b>\n` +
        `${state.paused ? '⏸ <b>PAUSED</b>' : '▶️ Running'}\n\n` +
        `🎯 Target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> (${target})\n` +
        `📋 Status: ${targetStatus}\n` +
        `📚 Mode: <b>${state.targetIsLectureOnly ? 'lectures only' : 'full'}</b>\n` +
        `👁️ Watching: ${watched}\n` +
        `🔥 Open now: <b>${openCount}</b>\n\n` +
        `🛡️ Baseline (${state.registeredCourses.length}): ${regs}\n\n` +
        `📊 <b>Counters:</b>\n` +
        `opens=<b>${state.counters.opens}</b> ` +
        `closes=<b>${state.counters.closes}</b> ` +
        `drops=<b>${state.counters.drops}</b> ` +
        `adds=<b>${state.counters.adds}</b>\n` +
        `relogins=<b>${state.counters.relogins}</b> ` +
        `errors=<b>${state.counters.errors}</b> ` +
        `alerts=<b>${state.counters.alertsSent}</b>`
      );
      break;
    }

    // ─────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────
    case '/find': {
      const q = args.join(' ').trim();
      if (!q) {
        await tgSend(
          `🔍 <b>Search courses</b>\n\n` +
          `Usage: <code>/find &lt;code or name&gt;</code>\n` +
          `Examples:\n` +
          `• <code>/find GEN</code>\n` +
          `• <code>/find CIV</code>\n` +
          `• <code>/find English</code>`
        );
        break;
      }
      const r = await api.getCourses({ statuses: '0,1,2,3,4,5', forceRefresh: true });
      if (r.kind !== 'ok' || !r.courses) {
        await tgSend(`❌ API error: <code>${escapeHtml(r.kind)}</code>`);
        break;
      }
      const qUp = q.toUpperCase();
      const qNorm = qUp.replace(/\s+/g, '');
      const matches = r.courses.filter(c =>
        String(c.code).toUpperCase().includes(qUp) ||
        String(c.name).toUpperCase().includes(qUp) ||
        String(c.code).toUpperCase().replace(/\s+/g, '').includes(qNorm)
      );

      if (matches.length === 0) {
        await tgSend(
          `🔍 <b>No matches for "${escapeHtml(q)}"</b>\n\n` +
          `📊 Total courses from API: <b>${r.courses.length}</b>\n\n` +
          `<i>Try shorter query or /diag to see all.</i>`
        );
        break;
      }
      let msg = `🔍 <b>${matches.length} match(es) for "${escapeHtml(q)}":</b>\n\n`;
      matches.slice(0, 20).forEach((c, i) => {
        msg += `<b>${i + 1}.</b> <code>${escapeHtml(c.code)}</code>\n`;
        msg += `   ${escapeHtml(c.name)}\n`;
        msg += `   ${statusLabel(c.status)} | ID: <code>${escapeHtml(c.id)}</code>\n\n`;
      });
      if (matches.length > 20) msg += `<i>…and ${matches.length - 20} more.</i>`;
      await tgSend(msg);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/diag': {
      const r = await api.getCourses({ statuses: '0,1,2,3,4,5', forceRefresh: true });
      if (r.kind !== 'ok' || !r.courses) {
        await tgSend(`❌ API error: <code>${escapeHtml(r.kind)}</code>`);
        break;
      }
      // Group by status
      const byStatus = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
      for (const c of r.courses) {
        const s = Number(c.status);
        if (byStatus[s]) byStatus[s].push(c.code);
      }
      let msg = `🩺 <b>Diagnostic Dump</b>\n\n`;
      msg += `📊 <b>Total: ${r.courses.length} courses</b>\n\n`;
      for (const [s, codes] of Object.entries(byStatus)) {
        if (codes.length === 0) continue;
        msg += `${statusLabel(Number(s))} (${codes.length}):\n`;
        msg += `<code>${codes.slice(0, 15).map(escapeHtml).join(', ')}</code>\n`;
        if (codes.length > 15) msg += `<i>…+${codes.length - 15} more</i>\n`;
        msg += `\n`;
      }
      await tgSend(msg);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/groups': {
      if (!state.targetCourseId) {
        await tgSend(
          `⚠️ Target not resolved.\n\n` +
          `Try: <code>/target GEN101</code>`
        );
        break;
      }
      const r = await api.getCourseSchedule(state.targetCourseId);
      if (r.kind !== 'ok' || !r.groups || r.groups.length === 0) {
        await tgSend(`❌ No groups for <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> right now.`);
        break;
      }
      const sorted = [...r.groups].sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      let msg = `🎯 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${r.groups.length} groups</b>\n`;
      msg += `<i>🔥=open · ❄️=full · 👁️=watched</i>\n\n`;

      sorted.slice(0, 20).forEach((g) => {
        const watched = state.watchedGroups.some(w =>
          g.name.toUpperCase().includes(w.toUpperCase())
        );
        const mark = watched ? '👁️ ' : '';
        const icon = g.available ? '🔥' : '❄️';
        const blocked = g.blocked ? ' 🚫' : '';
        msg += `${mark}${icon} <b>${escapeHtml(g.name)}</b>${blocked} — 💺 ${g.seats}/${g.total}\n`;
        if (g.slots[0]) {
          msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
          if (g.slots[0].hall) msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
        }
      });
      if (sorted.length > 20) msg += `\n<i>…and ${sorted.length - 20} more.</i>`;

      const availableGroups = sorted.filter(g => g.available).slice(0, 8);
      const inlineRows = availableGroups.map(g => ([{
        text: `👁️ Watch ${g.name} (${g.seats} seats)`,
        callback_data: `watch:${g.name}`.slice(0, 64),
      }]));

      const replyMarkup = inlineRows.length > 0
        ? { inline_keyboard: inlineRows }
        : undefined;

      await tgSend(msg, { replyMarkup });
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/open': {
      const openGroups = Object.entries(state.openGroupsState)
        .filter(([_, v]) => v.open)
        .map(([name, v]) => ({ name, ...v }));

      if (openGroups.length === 0) {
        await tgSend(`❄️ <b>No groups currently open</b>\nI'll alert you the moment one opens.`);
        break;
      }
      let msg = `🔥 <b>Currently open (${openGroups.length}):</b>\n\n`;
      openGroups.forEach((g, i) => {
        const watched = state.watchedGroups.some(w => g.name.toUpperCase().includes(w.toUpperCase()));
        msg += `${watched ? '👁️ ' : ''}<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      });
      msg += `\n<i>Register now on DULMS!</i>`;
      await tgSend(msg);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/info': {
      const r = await api.getRegInfo();
      if (r.kind !== 'ok' || !Array.isArray(r.data) || r.data.length === 0) {
        await tgSend(`❌ Could not fetch registration info (${r.kind}).`);
        break;
      }
      const info = r.data[0];
      const avail = info.RegAvailabilty;
      const statusTxt = avail === 1 ? '✅ OPEN' : (avail === -1 ? '⏳ NOT STARTED' : '🚫 BLOCKED');
      await tgSend(
        `ℹ️ <b>Registration Info</b>\n\n` +
        `Status: <b>${statusTxt}</b>\n` +
        (info.RegAvailabiltyReason ? `<i>${escapeHtml(info.RegAvailabiltyReason)}</i>\n` : '') +
        `\n📅 Reg ends: <b>${escapeHtml(String(info.RegEndDate || '—'))}</b>\n` +
        `📅 Edit ends: <b>${escapeHtml(String(info.RegEditEndDate || '—'))}</b>\n\n` +
        `💰 Balance: <b>${escapeHtml(String(info.StudentCredit || '—'))} ${escapeHtml(String(info.Currency || ''))}</b>\n` +
        `⏱ Permitted: <b>${escapeHtml(String(info.AcademicAllowedHours || '—'))}</b> hrs\n` +
        `📚 Registered: <b>${escapeHtml(String(info.RegisteredHours || '—'))}</b> hrs\n` +
        `✅ Confirmed: <b>${escapeHtml(String(info.ConfirmedHours || '—'))}</b> hrs`
      );
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/target': {
      const code = args.join(' ').trim();
      if (!code) {
        await tgSend(
          `🎯 <b>Set Target</b>\n\n` +
          `Usage: <code>/target &lt;course_code&gt;</code>\n\n` +
          `Current: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> ` +
          `(id: ${state.targetCourseId ? `<code>${escapeHtml(state.targetCourseId)}</code>` : 'not resolved'})\n\n` +
          `<i>⚠️ Only registerable courses are accepted.</i>\n` +
          `Use <code>/find</code> to search.`
        );
        break;
      }

      log.info(`/target: resolving "${code}" (registerable only)`);
      const resolved = await api.resolveTargetId(code, { onlyRegisterable: true });

      if (resolved) {
        state.targetCourseId = resolved.id;
        state.targetCourseCode = resolved.code;
        state.targetCourseName = resolved.name;
        state.targetCourseStatus = resolved.status;
        state.watchedGroups = [];
        state.openGroupsState = {};
        state.targetResolveFailures = 0;
        audit(state, 'target_set_manual', { code, id: resolved.id });
        saveState(state);
        await tgSend(
          `🎯 <b>Target updated</b>\n\n` +
          `Code: <code>${escapeHtml(resolved.code)}</code>\n` +
          `Name: ${escapeHtml(resolved.name)}\n` +
          `ID: <code>${escapeHtml(resolved.id)}</code>\n` +
          `Status: ${statusLabel(resolved.status)}\n\n` +
          `<i>Watch list reset. Use /groups.</i>`
        );
        break;
      }

      // Not registerable — check why
      log.info(`/target: "${code}" not registerable, checking full list`);
      const all = await api.resolveTargetId(code, { onlyRegisterable: false });
      if (all) {
        await tgSend(
          `⚠️ <b>"${escapeHtml(code)}" cannot be sniped</b>\n\n` +
          `Code: <code>${escapeHtml(all.code)}</code>\n` +
          `Name: ${escapeHtml(all.name)}\n` +
          `Status: <b>${statusLabel(all.status)}</b>\n\n` +
          `<i>You can only snipe: failed, withdrawn, or never-registered courses.</i>`
        );
      } else {
        await tgSend(
          `❌ <b>Could not find "${escapeHtml(code)}"</b>\n\n` +
          `The course is not in your registration list.\n\n` +
          `Try <code>/find ${escapeHtml(code.split(/\s+/)[0])}</code> to search.`
        );
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/watch': {
      if (args.length === 0) {
        if (state.watchedGroups.length === 0) {
          await tgSend(
            `👁️ <b>Watch list: empty</b>\n\n` +
            `You'll receive alerts for <b>ANY group</b> that opens.\n\n` +
            `Use <code>/groups</code> to see groups and tap 👁️ Watch.`
          );
        } else {
          const rows = state.watchedGroups.map(g => ([{
            text: `🚫 Unwatch ${g}`,
            callback_data: `unwatch:${g}`.slice(0, 64),
          }]));
          let msg = `👁️ <b>Watch list (${state.watchedGroups.length}):</b>\n\n`;
          state.watchedGroups.forEach((g, i) => {
            msg += `${i + 1}. <code>${escapeHtml(g)}</code>\n`;
          });
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
      await tgSend(`👁️ Now watching: <b>${escapeHtml(grp)}</b>\n<i>Total: ${state.watchedGroups.length}</i>`);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/unwatch': {
      if (args.length === 0) {
        await tgSend(`Usage: <code>/unwatch &lt;group&gt;</code> or <code>/unwatch all</code>`);
        break;
      }
      const target = args.join(' ').trim();
      if (target.toLowerCase() === 'all') {
        const count = state.watchedGroups.length;
        state.watchedGroups = [];
        audit(state, 'watch_clear');
        saveState(state);
        await tgSend(`🚫 Cleared watch list (was ${count}).`);
        break;
      }
      state.watchedGroups = state.watchedGroups.filter(g => g !== target);
      audit(state, 'watch_remove', { group: target });
      saveState(state);
      await tgSend(`🚫 Stopped watching: <b>${escapeHtml(target)}</b>`);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/reset': {
      state.targetCourseId = null;
      state.targetCourseCode = null;
      state.targetCourseName = null;
      state.targetCourseStatus = null;
      state.watchedGroups = [];
      state.openGroupsState = {};
      state.targetResolveFailures = 0;
      audit(state, 'reset');
      saveState(state);
      await tgSend(
        `🔄 <b>Reset complete</b>\n\n` +
        `🎯 Target cleared (will auto re-resolve)\n` +
        `👁️ Watch list cleared\n` +
        `🔥 Open state cleared`
      );
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/audit': {
      const last = state.audit.slice(-10).map(e =>
        `• <code>${new Date(e.t).toISOString().slice(11,19)}</code> ${escapeHtml(e.event)}`
      ).join('\n');
      await tgSend(`📜 <b>Last 10 events</b>\n${last || '— empty —'}`);
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/pause': {
      state.paused = true;
      audit(state, 'paused');
      saveState(state);
      await tgSend('⏸️ <b>Paused</b>\nSend /resume to continue.');
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/resume': {
      state.paused = false;
      audit(state, 'resumed');
      saveState(state);
      await tgSend('▶️ <b>Resumed</b>');
      break;
    }

    // ─────────────────────────────────────────────────────────────
    case '/help': {
      await tgSend(
        `🤖 <b>الأوامر المتاحة</b>\n\n` +
        BOT_COMMANDS.map(c => `/<b>${c.command}</b> — ${c.description}`).join('\n') +
        `\n\n<i>💡 استخدم الأزرار تحت الشات</i>`,
        { replyMarkup: MAIN_KEYBOARD }
      );
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
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-extensions', '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--js-flags=--max-old-space-size=512',
    ],
  });
}

async function createRequestContext(browser, useCookies = true) {
  const opts = {
    baseURL: CONFIG.baseUrl,
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
    },
  };
  if (useCookies && fs.existsSync(CONFIG.sessionFile)) {
    opts.storageState = CONFIG.sessionFile;
  }
  return browser.newContext(opts);
}

async function loginAndCaptureCookies(browser) {
  log.info('Logging in via headless page…');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.route('**/*', (r) => {
    const t = r.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') return r.abort();
    return r.continue();
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await retry(async () => {
    await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeoutMs });
    await page.fill('input[type="text"]', CONFIG.username);
    await page.fill('input[type="password"]', CONFIG.password);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);
    if (page.url().includes('/Login.aspx')) throw new Error('Login failed — still on Login.aspx');
  }, { attempts: 3, baseMs: 1_500, label: 'login' });

  await saveSession(context);
  await context.close();
  log.ok('Logged in — cookies saved');
}

// ═══════════════════════════════════════════════════════════════════════════
//  API CLIENT
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
  try { data = JSON.parse(s); }
  catch { return { kind: 'structural' }; }
  return { kind: 'ok', data };
}

function makeApi(request) {
  // ⭐ Course cache to avoid hammering the API
  let courseCache = { ts: 0, data: null };

  async function call(method, url, { params, data } = {}) {
    const fullUrl = params
      ? `${url}?${new URLSearchParams(params).toString()}`
      : url;
    const opts = { method, timeout: CONFIG.netTimeoutMs };
    if (data) {
      opts.data = data;
      opts.headers = { 'Content-Type': 'application/json; charset=utf-8' };
    }
    const res = await request.fetch(fullUrl, opts);
    const body = await res.text().catch(() => '');
    return classifyApiResponse(res, body);
  }

  return {
    // ⭐ Get course schedule (groups for a specific course)
    async getCourseSchedule(courseId) {
      const r = await retry(
        () => call('GET', CONFIG.API.courseSchedule, { params: { CourseId: courseId } }),
        { label: 'getCourseSchedule' }
      );
      if (r.kind !== 'ok') return r;

      if (!Array.isArray(r.data)) {
        log.warn('getCourseSchedule: response is not an array');
        return { kind: 'structural' };
      }

      const groups = {};
      let hasSubgroups = false;

      for (const item of r.data) {
        if (!item) continue;
        if (item.Type === 'SubGroup') { hasSubgroups = true; continue; }
        if (item.Type !== 'Group') continue;

        const gid = item.GroupId;
        if (gid == null) continue;

        if (!groups[gid]) {
          const rawName   = String(item.GroupName || '').trim();
          const shortName = String(item.ShortName || '').trim();
          const isUni     = !!item.IsUniversity;

          let displayName;
          if (isUni && shortName && rawName) displayName = `${shortName}-${rawName}`;
          else if (rawName)                  displayName = rawName;
          else if (shortName)                displayName = `${shortName}-${gid}`;
          else                               displayName = `Group-${gid}`;

          groups[gid] = {
            id: gid,
            name: displayName,
            rawName: rawName || null,
            shortName: shortName || null,
            isUniversity: isUni,
            blocked: !!item.IsBlocked,
            selected: !!item.IsSelected,
            total: parseInt(item.StudentsCount) || 0,
            registered: parseInt(item.RegisteredCount) || 0,
            slots: [],
          };
        }
        groups[gid].slots.push({
          day:   item.DayWeekName,
          time:  item.Time,
          hall:  item.ClassRoomName,
          staff: item.Staff,
        });
      }

      const list = Object.values(groups).map(g => ({
        ...g,
        seats: g.total - g.registered,
        available: !g.blocked && (g.total - g.registered) > 0,
      }));

      return { kind: 'ok', groups: list, hasSubgroups };
    },

    // ⭐ Get courses list (with cache)
    async getCourses({ statuses = '3,4', groups = '-1', virtual = false, forceRefresh = false } = {}) {
      // Cache check
      if (!forceRefresh && courseCache.data &&
          Date.now() - courseCache.ts < USER_CONFIG.courseCacheTtlMs) {
        return { kind: 'ok', courses: courseCache.data };
      }

      const params = {
        GradeStatusIds: statuses,
        IsVirtualRegisteration: virtual,
      };
      if (groups !== '' && groups != null) {
        params.GroupsIds = groups;
      }

      const r = await retry(
        () => call('GET', CONFIG.API.coursesList, { params }),
        { label: 'getCourses' }
      );
      if (r.kind !== 'ok') return r;

      const data = Array.isArray(r.data) ? r.data : [];
      const list = data.map(c => ({
        id: String(c.CourseId),
        code: c.Code || '',
        name: c.Name || '',
        status: c.GradeStatusId,
        group: c.GrpName,
      }));

      // Cache
      courseCache = { ts: Date.now(), data: list };
      return { kind: 'ok', courses: list };
    },

    // ⭐ Get registration info
    async getRegInfo() {
      return retry(() => call('POST', CONFIG.API.regInfo), { label: 'getRegInfo' });
    },

    // ⭐⭐ ROBUST target resolution — 3 sources × 6 layers
    async resolveTargetId(query, { onlyRegisterable = true } = {}) {
      log.info(`resolveTargetId: query="${query}" onlyRegisterable=${onlyRegisterable}`);

      // Try multiple source configurations
      const sources = [
        { statuses: onlyRegisterable ? '0,2,5' : '0,1,2,3,4,5', groups: '-1', label: 'std' },
        { statuses: '0,1,2,3,4,5', groups: '-1', label: 'all-statuses' },
        { statuses: '0,1,2,3,4,5', groups: '',  label: 'all-groups' },
      ];

      let allCourses = [];
      for (const src of sources) {
        try {
          const r = await this.getCourses({
            statuses: src.statuses,
            groups: src.groups,
            forceRefresh: true,
          });
          if (r.kind === 'ok' && r.courses && r.courses.length > 0) {
            allCourses = r.courses;
            log.ok(`resolveTargetId[${src.label}]: got ${r.courses.length} courses`);
            break;
          } else if (r.kind !== 'ok') {
            log.warn(`resolveTargetId[${src.label}]: ${r.kind}`);
          }
        } catch (e) {
          log.warn(`resolveTargetId[${src.label}]: ${e.message}`);
        }
      }

      if (allCourses.length === 0) {
        log.warn('resolveTargetId: no courses from any source');
        return null;
      }

      // Debug: log first 10
      const sample = allCourses.slice(0, 10).map(c => `${c.code}(${c.status})`).join(', ');
      log.info(`Sample: ${sample}`);

      const targetNorm = normalizeCode(query);
      const targetRaw  = String(query).toUpperCase().trim();
      const targetNoSp = String(query).toUpperCase().replace(/\s+/g, '');

      // Layer 1: exact normalized
      let found = allCourses.find(c => normalizeCode(c.code) === targetNorm);
      if (found) { log.ok(`L1: ${found.code} (${found.status})`); return found; }

      // Layer 2: exact raw
      found = allCourses.find(c => String(c.code).toUpperCase().trim() === targetRaw);
      if (found) { log.ok(`L2: ${found.code} (${found.status})`); return found; }

      // Layer 3: normalized contains
      found = allCourses.find(c => normalizeCode(c.code).includes(targetNorm));
      if (found) { log.ok(`L3: ${found.code} (${found.status})`); return found; }

      // Layer 4: name contains (raw)
      found = allCourses.find(c => String(c.name).toUpperCase().includes(targetRaw));
      if (found) { log.ok(`L4: ${found.code} (${found.status})`); return found; }

      // Layer 5: name contains (no spaces)
      found = allCourses.find(c =>
        String(c.name).toUpperCase().replace(/\s+/g, '').includes(targetNoSp)
      );
      if (found) { log.ok(`L5: ${found.code} (${found.status})`); return found; }

      // Layer 6: fuzzy — all tokens match
      const tokens = targetRaw.split(/\s+/).filter(t => t.length >= 3);
      if (tokens.length > 0) {
        found = allCourses.find(c => {
          const hay = `${c.code} ${c.name}`.toUpperCase();
          return tokens.every(t => hay.includes(t));
        });
        if (found) { log.ok(`L6: ${found.code} (${found.status})`); return found; }
      }

      log.warn(`resolveTargetId: FAILED for "${query}" (${allCourses.length} courses)`);
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
    log.ok(`   → ${currentReg.map(c => c.code).join(', ')}`);
    audit(state, 'baseline_set', { count: currentReg.length, codes: currentReg.map(c => c.code) });

    const missing = USER_CONFIG.expectedCourses.filter(exp =>
      !currentReg.some(c => normalizeCode(c.code).includes(normalizeCode(exp)))
    );
    if (missing.length > 0) {
      await tgSend(
        `⚠️ <b>Baseline note</b>\nNot yet registered:\n` +
        missing.map(m => `• ${escapeHtml(m)}`).join('\n') +
        `\n\nSniper is hunting. 🎯`
      );
    }
    return { kind: 'ok' };
  }

  // Drops
  for (const saved of state.registeredCourses) {
    if (!currentReg.some(c => sameCourse(c, saved))) {
      state.counters.drops++;
      log.err(`COURSE DROPPED: ${saved.code}`);
      audit(state, 'course_dropped', { code: saved.code, name: saved.name });
      await tgSend(
        `🚨 <b>Registration change!</b>\n` +
        `Course disappeared:\n\n❌ <b>${escapeHtml(saved.code)}</b> — ${escapeHtml(saved.name)}\n\n` +
        `Open DULMS immediately!`
      );
    }
  }

  // Adds
  for (const curr of currentReg) {
    if (!state.registeredCourses.some(s => sameCourse(s, curr))) {
      state.counters.adds++;
      log.ok(`NEW COURSE: ${curr.code}`);
      audit(state, 'course_added', { code: curr.code, name: curr.name });
      await tgSend(
        `✅ <b>New course added!</b>\n➕ <b>${escapeHtml(curr.code)}</b> — ${escapeHtml(curr.name)}`
      );
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
  const available = groups.filter(g =>
    g && g.available && typeof g.name === 'string' && g.name.length > 0
  );
  if (!Array.isArray(watched) || watched.length === 0) return available;

  const w = watched
    .filter(x => typeof x === 'string' && x.length > 0)
    .map(x => x.toUpperCase());
  if (w.length === 0) return available;

  return available.filter(g => {
    const name = String(g.name || '').toUpperCase();
    return w.some(pattern => name.includes(pattern));
  });
}

async function sniperCheck(api, state) {
  if (!state.targetCourseId) return { kind: 'no_target' };

  const r = await api.getCourseSchedule(state.targetCourseId);
  if (r.kind !== 'ok') return r;

  const openGroups = filterMatchingGroups(r.groups, state.watchedGroups);
  const currentlyOpen = new Set(openGroups.map(g => g.name));

  if (!state.openGroupsState || typeof state.openGroupsState !== 'object') {
    state.openGroupsState = {};
  }

  const newlyOpened = [];
  for (const g of openGroups) {
    if (!g || typeof g.name !== 'string') continue;
    const prev = state.openGroupsState[g.name];
    if (!prev || !prev.open) newlyOpened.push(g);
  }

  const closed = [];
  for (const [name, prev] of Object.entries(state.openGroupsState)) {
    if (prev.open && !currentlyOpen.has(name)) closed.push(name);
  }

  for (const g of openGroups) {
    state.openGroupsState[g.name] = {
      open: true, lastSeen: Date.now(), seats: g.seats, total: g.total,
    };
  }
  for (const name of closed) {
    if (state.openGroupsState[name]) {
      state.openGroupsState[name].open = false;
      state.openGroupsState[name].seats = 0;
      state.openGroupsState[name].lastSeen = Date.now();
    }
  }

  if (newlyOpened.length > 0) {
    state.counters.opens += newlyOpened.length;
    state.counters.alertsSent++;
    audit(state, 'target_open', {
      count: newlyOpened.length, groups: newlyOpened.map(g => g.name),
    });

    let msg = `🎉 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${newlyOpened.length} opened!</b>\n\n`;
    newlyOpened.slice(0, 8).forEach((g, i) => {
      msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      if (g.slots[0]) {
        msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
        if (g.slots[0].hall) msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
        if (g.slots[0].staff) msg += `   👤 ${escapeHtml(g.slots[0].staff)}\n`;
      }
      msg += `\n`;
    });
    msg += `🔗 <b>Open DULMS NOW!</b>`;

    const btns = newlyOpened.slice(0, 3).map(g => ([{
      text: `📝 Register ${g.name}`,
      url: 'https://dulms.deltauniv.edu.eg/Registered/CoursesRegisteration',
    }]));

    await tgSend(msg, {
      silent: !USER_CONFIG.notifyWithSound,
      replyMarkup: btns.length ? { inline_keyboard: btns } : undefined,
    });
    saveState(state);
  }

  if (closed.length > 0) {
    state.counters.closes += closed.length;
    log.info(`Groups closed: ${closed.join(', ')}`);
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
    await tgSend(
      `🔄 <b>Chat migration synced</b>\n\n` +
      `<b>Baseline (${state.registeredCourses.length}):</b>\n${regs}\n\n` +
      `Target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b>`,
      { replyMarkup: MAIN_KEYBOARD }
    );
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
  let api = makeApi(request);

  const state = loadState();
  state.startedAt = Date.now();
  if (USER_CONFIG.targetCourseId) state.targetCourseId = USER_CONFIG.targetCourseId;

  await detectChatMigration(state);
  saveState(state);

  const startupGapMs = USER_CONFIG.startupBriefHours * 60 * 60_000;
  if (Date.now() - state.startupBriefedAt > startupGapMs) {
    state.startupBriefedAt = Date.now();
    const missing = USER_CONFIG.expectedCourses.filter(exp =>
      !state.registeredCourses.some(c => normalizeCode(c.code).includes(normalizeCode(exp)))
    );
    const missingTxt = missing.length
      ? `\n⚠️ Waiting for: ${missing.map(escapeHtml).join(', ')}`
      : `\n✅ All registered courses present`;
    await tgSend(
      `🚀 <b>Watcher v9.2 online</b>\n\n` +
      `🎯 Sniping <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> every 10s\n` +
      `🎓 Mode: <b>lectures only</b>\n` +
      `🛡️ Guarding <b>${state.registeredCourses.length}</b> courses${missingTxt}\n\n` +
      `Send /help or use the buttons.`,
      { replyMarkup: MAIN_KEYBOARD }
    );
    saveState(state);
  }

  log.step(`STARTED — Target: ${USER_CONFIG.targetCourse} (lectures only)`);

  const timers = {
    sniper:   Date.now(),
    security: Date.now(),
    telegram: Date.now() + 2_000,
    memory:   Date.now() + 60_000,
  };

  while (Date.now() < deadline) {
    const now = Date.now();

    if (state.paused) {
      await sleep(USER_CONFIG.heartbeatMs * 2);
      continue;
    }

    // Telegram
    if (now >= timers.telegram) {
      await handleTelegramCommands(state, api, timers);
      timers.telegram = Date.now() + USER_CONFIG.telegramPollMs;
    }

    // Memory watchdog
    if (now >= timers.memory) {
      const mb = rssMb();
      if (mb >= CONFIG.memRestartMb) {
        log.err(`Memory critical (${mb} MB) — signaling rebuild`);
        audit(state, 'browser_restart', { rssMb: mb });
        saveState(state);
        try { await context.close(); } catch {}
        return RESULT.REBUILD;
      } else if (mb >= CONFIG.memWarnMb) {
        log.warn(`Memory high: ${mb} MB`);
      }
      timers.memory = Date.now() + 60_000;
    }

    // Security check
    if (now >= timers.security) {
      const sr = await verifyRegistrationStability(api, state);

      if (sr.kind === 'ok') {
        // ⭐ Auto-resolve target if needed
        if (!state.targetCourseId) {
          log.info(`Attempting target auto-resolution for "${USER_CONFIG.targetCourse}"...`);
          const resolved = await api.resolveTargetId(USER_CONFIG.targetCourse);
          if (resolved) {
            state.targetCourseId = resolved.id;
            state.targetCourseCode = resolved.code;
            state.targetCourseName = resolved.name;
            state.targetCourseStatus = resolved.status;
            state.targetResolveFailures = 0;
            log.ok(`Target resolved: ${resolved.code} → id ${resolved.id}`);
            audit(state, 'target_resolved', resolved);
            await tgSend(
              `🎯 <b>Target auto-resolved</b>\n\n` +
              `Code: <code>${escapeHtml(resolved.code)}</code>\n` +
              `Name: ${escapeHtml(resolved.name)}\n` +
              `Status: ${statusLabel(resolved.status)}`
            );
          } else {
            state.targetResolveFailures = (state.targetResolveFailures || 0) + 1;
            log.warn(`Target resolution failed (${state.targetResolveFailures} times)`);
            audit(state, 'target_resolve_failed', { attempts: state.targetResolveFailures });

            // ⭐ After 3 failures, notify user with hint
            if (state.targetResolveFailures === 3) {
              await tgSend(
                `⚠️ <b>Could not auto-resolve "${escapeHtml(USER_CONFIG.targetCourse)}"</b>\n\n` +
                `I tried 3 times without luck.\n\n` +
                `Try:\n` +
                `• <code>/diag</code> — see all your courses\n` +
                `• <code>/find GEN</code> — search for GEN courses\n` +
                `• <code>/target &lt;exact code&gt;</code> — set manually`
              );
            }
          }
        }
        timers.security = Date.now() + USER_CONFIG.securityIntervalMs;
        saveState(state);
      } else if (sr.kind === 'session_dead') {
        log.warn('Security: session dead — relogin');
        audit(state, 'session_dead_security');
        state.counters.relogins++;
        try { await context.close(); } catch {}
        cleanupSession();
        await loginAndCaptureCookies(browser);
        context = await createRequestContext(browser, true);
        request = context.request;
        api = makeApi(request);
        timers.security = Date.now() + 5_000;
        saveState(state);
      } else {
        log.warn(`Security check failed (${sr.kind}) — retry in 60s`);
        state.counters.errors++;
        timers.security = Date.now() + 60_000;
      }
    }

    // Sniper
    if (state.targetCourseId && now >= timers.sniper) {
      const sr = await sniperCheck(api, state);
      switch (sr.kind) {
        case 'session_dead': {
          log.warn('Sniper: session dead — relogin');
          audit(state, 'session_dead_sniper');
          state.counters.relogins++;
          try { await context.close(); } catch {}
          cleanupSession();
          await loginAndCaptureCookies(browser);
          context = await createRequestContext(browser, true);
          request = context.request;
          api = makeApi(request);
          timers.sniper = Date.now() + 5_000;
          saveState(state);
          break;
        }
        case 'soft_server':
        case 'http':
          state.counters.errors++;
          timers.sniper = Date.now() + 30_000;
          break;
        case 'structural':
          state.counters.errors++;
          log.err('Sniper: structural response');
          audit(state, 'structural_change');
          timers.sniper = Date.now() + 60_000;
          break;
        default:
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
  process.on('SIGINT',  () => handler('SIGINT'));
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

  log.info(`Watcher v9.2 starting — PID ${process.pid}, RSS ${rssMb()} MB, deadline in ${CONFIG.durationMin} min`);

  await registerBotCommands();

  let iterations = 0;
  const maxIterations = 10;
  while (Date.now() < deadline && iterations < maxIterations) {
    iterations++;
    const browser = await createBrowser();
    let result;
    try {
      result = await runScan(browser, deadline);
    } catch (e) {
      log.err('Fatal:', e.message);
      if (e.stack) console.error(e.stack);
      result = RESULT.FATAL;
    } finally {
      try { await browser.close(); } catch {}
    }

    if (result === RESULT.COMPLETED) { log.ok('Run completed'); break; }
    if (result === RESULT.REBUILD) { log.info('Rebuilding…'); await sleep(2_000); continue; }
    if (result === RESULT.FATAL) { log.err('Fatal — aborting'); break; }
  }

  try { saveState(loadState()); } catch {}
  log.info(`Watcher v9.2 exiting — final RSS ${rssMb()} MB`);
})();
