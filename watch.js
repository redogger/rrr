/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v9.0 — Fortress Edition
 *  ---------------------------------------------------------------------------
 *  Key improvements over v8:
 *   • Per-group state tracking (openGroupsState Map)
 *   • Batched notifications (multiple groups → 1 message)
 *   • Robust target ID resolution (code / stripped-code / name fallback)
 *   • Clean rebuild signal (RESULT enum) — no more broken breaks
 *   • ShortName-GroupName display for university groups
 *   • Audit log rotation (1 MB cap)
 *   • New commands: /target, /info, /unwatch all
 *   • New counters: closes, alertsSent
 *   • Graceful shutdown (SIGTERM/SIGINT)
 *   • Startup brief throttled to 12 hours
 *   • HTML-safe everywhere
 * ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  USER CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const USER_CONFIG = {
  targetCourse:        'GEN 101',
  targetCourseId:      null,     // auto-resolved; override here if you know it

  expectedCourses:     ['MEC151', 'BAS111', 'CIV111', 'CIV121', 'CIV131', 'GEN 101'],

  preferredGroups:     [],       // e.g. ['Civil-E1', 'Civil A']

  sniperIntervalMs:    10 * 1000,
  securityIntervalMs:  10 * 60 * 1000,
  telegramPollMs:      5  * 1000,
  heartbeatMs:         500,

  startupBriefHours:   12,       // ← throttled to once per 12h
  notifyWithSound:     true,
  maxTelegramPerMin:   20,
  maxReloginsPerHour:  6,
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
    scheduleTable:  '/Registered/GetStudentTable',
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

  auditMaxBytes:    1 * 1024 * 1024,   // 1 MB

  timezone:         'Africa/Cairo',
  stateVersion:     9,
};

// ═══════════════════════════════════════════════════════════════════════════
//  RESULT SIGNALS (for the entrypoint loop)
// ═══════════════════════════════════════════════════════════════════════════
const RESULT = Object.freeze({
  COMPLETED: 'completed',   // hit time deadline
  REBUILD:   'rebuild',     // need fresh browser context
  FATAL:     'fatal',       // unrecoverable
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
      log.info('Audit log rotated');
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
    openGroupsState:      {},     // { "Civil-E1": { open, lastSeen, seats, total } }
    lastTgUpdateId:       0,
    tgChatId:             null,
    watchedGroups:        [...USER_CONFIG.preferredGroups],
    startupBriefedAt:     0,
    paused:               false,
    audit:                [],
    counters:             {
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
//  TELEGRAM — queue + rate limiting
// ═══════════════════════════════════════════════════════════════════════════
const tgQueue = [];
let tgSending = false;
const tgTimestamps = [];

async function tgSend(html, { silent = false } = {}) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId || !html) return;
  tgQueue.push({ html, silent });
  if (tgSending) return;
  tgSending = true;
  try {
    while (tgQueue.length > 0) {
      const now = Date.now();
      while (tgTimestamps.length && now - tgTimestamps[0] > 60_000) tgTimestamps.shift();
      if (tgTimestamps.length >= USER_CONFIG.maxTelegramPerMin) {
        const wait = 60_000 - (now - tgTimestamps[0]) + 100;
        log.warn(`TG rate limit — waiting ${wait}ms`);
        await sleep(wait);
      }
      tgTimestamps.push(Date.now());

      const { html: msg, silent: sil } = tgQueue.shift();
      try {
        const res = await withTimeout(
          fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CONFIG.tgChatId,
              text: msg,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              disable_notification: sil,
            }),
          }),
          CONFIG.netTimeoutMs, 'tg-send'
        );
        const body = await res.json().catch(() => ({}));
        if (!body.ok && body.error_code === 429) {
          const retry = (body.parameters && body.parameters.retry_after) || 5;
          log.warn(`TG 429 — retry in ${retry}s`);
          tgQueue.unshift({ html: msg, silent: sil });
          await sleep(retry * 1000);
        }
      } catch (e) { log.warn('TG send failed:', e.message); }
      await sleep(1_100);
    }
  } finally { tgSending = false; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM — command registry
// ═══════════════════════════════════════════════════════════════════════════
const BOT_COMMANDS = [
  { command: 'start',    description: '🟢 Bot alive check' },
  { command: 'status',   description: '📊 Full status report' },
  { command: 'baseline', description: '🛡️ Registered courses + missing' },
  { command: 'groups',   description: '🎯 Target course groups' },
  { command: 'info',     description: 'ℹ️ Registration period info' },
  { command: 'target',   description: '🎯 Manually set target course' },
  { command: 'watch',    description: '👁️ Watch a group (or list watched)' },
  { command: 'unwatch',  description: '🚫 Stop watching (or "all")' },
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

async function handleTelegramCommands(state, api) {
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
      const msg = upd.message;
      if (!msg || !msg.text) continue;

      const chatId = String(msg.chat.id);
      if (chatId !== CONFIG.tgChatId) {
        log.warn(`Unauthorized chat: ${chatId}`);
        audit(state, 'unauthorized', { chatId });
        continue;
      }

      const parts = msg.text.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
      const args = parts.slice(1);
      await dispatchCommand(cmd, args, state, api);
    }
    saveState(state);
  } catch { /* silent */ }
}

async function dispatchCommand(cmd, args, state, api) {
  const now = Date.now();
  const uptimeMin = Math.floor((now - (state.startedAt || now)) / 60_000);

  switch (cmd) {
    case '/start':
    case '/status': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.name)}`).join('\n')
        : '— none —';
      const target = state.targetCourseId
        ? `<code>${escapeHtml(state.targetCourseId)}</code>${state.targetCourseCode ? ` (${escapeHtml(state.targetCourseCode)})` : ''}`
        : '⏳ resolving';
      const watched = state.watchedGroups.length ? state.watchedGroups.map(escapeHtml).join(', ') : 'all groups';
      const openCount = Object.values(state.openGroupsState).filter(g => g.open).length;

      await tgSend(
        `🟢 <b>Watcher v9.0 — alive</b>\n` +
        `Uptime: <b>${uptimeMin} min</b> | RSS: <b>${rssMb()} MB</b>\n` +
        `Paused: <b>${state.paused ? 'yes' : 'no'}</b>\n\n` +
        `🎯 Target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> — ${target}\n` +
        `👁️ Watching: <b>${watched}</b>\n` +
        `🔥 Currently open: <b>${openCount}</b> group(s)\n` +
        `🛡️ Security: every 10 min\n\n` +
        `<b>Baseline (${state.registeredCourses.length}):</b>\n${regs}\n\n` +
        `Counters: opens=<b>${state.counters.opens}</b> ` +
        `closes=<b>${state.counters.closes}</b> ` +
        `drops=<b>${state.counters.drops}</b> ` +
        `adds=<b>${state.counters.adds}</b> ` +
        `relogins=<b>${state.counters.relogins}</b> ` +
        `errors=<b>${state.counters.errors}</b> ` +
        `alerts=<b>${state.counters.alertsSent}</b>`
      );
      break;
    }

    case '/baseline': {
      const regs = state.registeredCourses.length
        ? state.registeredCourses.map(c => `• <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.name)}`).join('\n')
        : '— none —';
      const missing = USER_CONFIG.expectedCourses.filter(exp =>
        !state.registeredCourses.some(c => c.code.toUpperCase().includes(exp.toUpperCase()))
      );
      const missingTxt = missing.length
        ? `\n\n⚠️ <b>Missing (${missing.length}):</b>\n` + missing.map(m => `❌ ${escapeHtml(m)}`).join('\n')
        : `\n\n✅ All expected courses present!`;
      await tgSend(`🛡️ <b>Baseline snapshot</b>\n${regs}${missingTxt}`);
      break;
    }

    case '/groups': {
      if (!state.targetCourseId) {
        await tgSend(`⚠️ Target course ID not yet resolved. Send <code>/target &lt;code&gt;</code> to set it manually.`);
        break;
      }
      const r = await api.getCourseSchedule(state.targetCourseId);
      if (r.kind !== 'ok' || !r.groups || r.groups.length === 0) {
        await tgSend(`❌ No groups returned for <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> right now.`);
        break;
      }
      // Sort: available first, then by name
      const sorted = [...r.groups].sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      let msg = `🎯 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${r.groups.length} groups</b>\n`;
      msg += `<i>🔥 = open · 💺 = seats</i>\n\n`;
      sorted.slice(0, 25).forEach((g, i) => {
        const mark = state.watchedGroups.some(w => g.name.toUpperCase().includes(w.toUpperCase())) ? '👁️ ' : '';
        const icon = g.available ? '🔥' : '❄️';
        const blocked = g.blocked ? ' 🚫' : '';
        msg += `${mark}${icon} <b>${escapeHtml(g.name)}</b>${blocked} — 💺 ${g.seats}/${g.total}\n`;
        if (g.slots[0]) {
          msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
          if (g.slots[0].hall) msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
        }
      });
      if (sorted.length > 25) msg += `\n<i>…and ${sorted.length - 25} more.</i>`;
      await tgSend(msg);
      break;
    }

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
        `⏱ Permitted hours: <b>${escapeHtml(String(info.AcademicAllowedHours || '—'))}</b>\n` +
        `📚 Registered hours: <b>${escapeHtml(String(info.RegisteredHours || '—'))}</b>\n` +
        `✅ Confirmed hours: <b>${escapeHtml(String(info.ConfirmedHours || '—'))}</b>`
      );
      break;
    }

    case '/target': {
      const code = args.join(' ').trim();
      if (!code) {
        await tgSend(
          `Usage: <code>/target &lt;course_code&gt;</code>\n` +
          `Example: <code>/target GEN101</code>\n\n` +
          `Current target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> ` +
          `(id: ${state.targetCourseId ? `<code>${escapeHtml(state.targetCourseId)}</code>` : 'not resolved'})`
        );
        break;
      }
      // Try to resolve immediately
      const resolved = await api.resolveTargetId(code);
      if (resolved) {
        state.targetCourseId = resolved.id;
        state.targetCourseCode = resolved.code;
        state.targetCourseName = resolved.name;
        audit(state, 'target_set_manual', { code, id: resolved.id });
        saveState(state);
        await tgSend(
          `🎯 <b>Target updated</b>\n\n` +
          `Code: <code>${escapeHtml(resolved.code)}</code>\n` +
          `Name: ${escapeHtml(resolved.name)}\n` +
          `ID: <code>${escapeHtml(resolved.id)}</code>`
        );
      } else {
        await tgSend(
          `❌ Could not resolve "<code>${escapeHtml(code)}</code>".\n` +
          `Make sure the course appears in your registration list.`
        );
      }
      break;
    }

    case '/watch': {
      if (args.length === 0) {
        // Show watched list
        const list = state.watchedGroups.length
          ? state.watchedGroups.map((g, i) => `${i + 1}. <code>${escapeHtml(g)}</code>`).join('\n')
          : '<i>No groups watched — will alert on ANY group.</i>';
        await tgSend(`👁️ <b>Watched groups</b>\n${list}`);
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
        await tgSend(`🚫 Cleared watch list (was ${count} groups).`);
        break;
      }
      state.watchedGroups = state.watchedGroups.filter(g => g !== target);
      audit(state, 'watch_remove', { group: target });
      saveState(state);
      await tgSend(`🚫 Stopped watching: <b>${escapeHtml(target)}</b>`);
      break;
    }

    case '/audit': {
      const last = state.audit.slice(-10).map(e =>
        `• <code>${new Date(e.t).toISOString().slice(11,19)}</code> ${escapeHtml(e.event)}`
      ).join('\n');
      await tgSend(`📜 <b>Last 10 events</b>\n${last || '— empty —'}`);
      break;
    }

    case '/pause': {
      state.paused = true;
      audit(state, 'paused');
      saveState(state);
      await tgSend('⏸️ <b>Paused</b>\nSend /resume to continue.');
      break;
    }

    case '/resume': {
      state.paused = false;
      audit(state, 'resumed');
      saveState(state);
      await tgSend('▶️ <b>Resumed</b>');
      break;
    }

    case '/help': {
      await tgSend(
        `🤖 <b>Commands</b>\n` +
        BOT_COMMANDS.map(c => `/<b>${c.command}</b> — ${c.description}`).join('\n')
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
    async getCourseSchedule(courseId) {
      const r = await retry(
        () => call('GET', CONFIG.API.courseSchedule, { params: { CourseId: courseId } }),
        { label: 'getCourseSchedule' }
      );
      if (r.kind !== 'ok') return r;

      const groups = {};
      for (const item of r.data) {
        if (item.Type !== 'Group') continue;
        const gid = item.GroupId;
        if (!groups[gid]) {
  // ⭐ Safe display name — always a non-empty string
  const rawName = String(item.GroupName || '').trim();
  const shortName = String(item.ShortName || '').trim();
  const isUni = !!item.IsUniversity;

  let displayName;
  if (isUni && shortName && rawName) {
    displayName = `${shortName}-${rawName}`;
  } else if (rawName) {
    displayName = rawName;
  } else if (shortName) {
    displayName = `${shortName}-${gid}`;
  } else {
    displayName = `Group-${gid}`;
  }

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
          day: item.DayWeekName,
          time: item.Time,
          hall: item.ClassRoomName,
          staff: item.Staff,
        });
      }

      const list = Object.values(groups).map(g => ({
        ...g,
        seats: g.total - g.registered,
        available: !g.blocked && (g.total - g.registered) > 0,
      }));

      return { kind: 'ok', groups: list };
    },

    async getCourses({ statuses = '3,4', groups = '-1', virtual = false } = {}) {
      const r = await retry(
        () => call('GET', CONFIG.API.coursesList, {
          params: { GradeStatusIds: statuses, GroupsIds: groups, IsVirtualRegisteration: virtual },
        }),
        { label: 'getCourses' }
      );
      if (r.kind !== 'ok') return r;
      const list = (r.data || []).map(c => ({
        id: String(c.CourseId),
        code: c.Code,
        name: c.Name,
        status: c.GradeStatusId,
        group: c.GrpName,
      }));
      return { kind: 'ok', courses: list };
    },

    async getRegInfo() {
      return retry(() => call('POST', CONFIG.API.regInfo), { label: 'getRegInfo' });
    },

    // ⭐ Robust target resolution — 3-layer fallback
    async resolveTargetId(query) {
      const r = await this.getCourses({ statuses: '0,1,2,3,4,5' });
      if (r.kind !== 'ok' || !r.courses) return null;

      const norm = s => String(s || '').toUpperCase().replace(/\s+/g, '');
      const targetNorm = norm(query);
      const targetRaw = String(query).toUpperCase().trim();

      // Layer 1: exact code match (normalized)
      let found = r.courses.find(c => norm(c.code) === targetNorm);

      // Layer 2: exact code match (raw)
      if (!found) found = r.courses.find(c => String(c.code).toUpperCase().trim() === targetRaw);

      // Layer 3: code contains
      if (!found) found = r.courses.find(c => norm(c.code).includes(targetNorm));

      // Layer 4: name contains
      if (!found) found = r.courses.find(c => String(c.name).toUpperCase().includes(targetRaw));

      if (!found) return null;
      return { id: found.id, code: found.code, name: found.name };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY TASK
// ═══════════════════════════════════════════════════════════════════════════
function sameCourse(a, b) {
  if (a.id && b.id) return String(a.id) === String(b.id);
  return a.code && b.code && a.code.toUpperCase() === b.code.toUpperCase();
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
      !currentReg.some(c => c.code.toUpperCase().includes(exp.toUpperCase()))
    );
    if (missing.length > 0) {
      await tgSend(
        `⚠️ <b>Baseline note</b>\n` +
        `Not yet registered:\n` +
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
      log.err(`COURSE DROPPED: ${saved.code} — ${saved.name}`);
      audit(state, 'course_dropped', { code: saved.code, name: saved.name });
      await tgSend(
        `🚨 <b>Registration change detected!</b>\n` +
        `A course disappeared from your schedule:\n\n` +
        `❌ <b>${escapeHtml(saved.code)} — ${escapeHtml(saved.name)}</b>\n\n` +
        `Open DULMS immediately to verify.`
      );
    }
  }

  // Adds
  for (const curr of currentReg) {
    if (!state.registeredCourses.some(s => sameCourse(s, curr))) {
      state.counters.adds++;
      log.ok(`NEW COURSE: ${curr.code} — ${curr.name}`);
      audit(state, 'course_added', { code: curr.code, name: curr.name });

      const isExpected = USER_CONFIG.expectedCourses.some(exp =>
        curr.code.toUpperCase().includes(exp.toUpperCase())
      );
      if (isExpected) {
        const afterAdd = [...state.registeredCourses, curr];
        const stillMissing = USER_CONFIG.expectedCourses.filter(exp =>
          !afterAdd.some(c => c.code.toUpperCase().includes(exp.toUpperCase()))
        );
        const complete = stillMissing.length === 0;
        await tgSend(
          `✅ <b>Great news!</b>\n` +
          `A new course appeared in your schedule:\n\n` +
          `➕ <b>${escapeHtml(curr.code)} — ${escapeHtml(curr.name)}</b>\n\n` +
          (complete
            ? `🎉 <b>Your schedule is now COMPLETE!</b>`
            : `<i>Still waiting for: ${stillMissing.map(escapeHtml).join(', ')}</i>`)
        );
      } else {
        await tgSend(
          `➕ <b>New course detected</b>\n` +
          `${escapeHtml(curr.code)} — ${escapeHtml(curr.name)}\n\n` +
          `<i>If you didn't register this, check DULMS immediately.</i>`
        );
      }
    }
  }

  state.registeredCourses = currentReg;
  return { kind: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNIPER TASK — per-group tracking
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

  // Ensure state object exists
  if (!state.openGroupsState || typeof state.openGroupsState !== 'object') {
    state.openGroupsState = {};
  }

  // Detect NEWLY opened (was closed → now open)
  // Detect NEWLY opened (was closed → now open)
const newlyOpened = [];
for (const g of openGroups) {
  if (!g || typeof g.name !== 'string' || g.name.length === 0) continue;
  const prev = state.openGroupsState[g.name];
  if (!prev || !prev.open) {
    newlyOpened.push(g);
  }
}

  // Detect CLOSED (was open → now closed)
  const closed = [];
  for (const [name, prev] of Object.entries(state.openGroupsState)) {
    if (prev.open && !currentlyOpen.has(name)) {
      closed.push(name);
    }
  }

  // Update state for all currently open
  for (const g of openGroups) {
    state.openGroupsState[g.name] = {
      open: true,
      lastSeen: Date.now(),
      seats: g.seats,
      total: g.total,
    };
  }
  // Mark closed as not open (keep seats=0)
  for (const name of closed) {
    if (state.openGroupsState[name]) {
      state.openGroupsState[name].open = false;
      state.openGroupsState[name].seats = 0;
      state.openGroupsState[name].lastSeen = Date.now();
    }
  }

  // Counters
  if (newlyOpened.length > 0) {
    state.counters.opens += newlyOpened.length;
    state.counters.alertsSent++;
    audit(state, 'target_open', {
      count: newlyOpened.length,
      groups: newlyOpened.map(g => g.name),
    });

    // ⭐ Batched notification
    let msg = `🎉 <b>${escapeHtml(USER_CONFIG.targetCourse)} — ${newlyOpened.length} group(s) opened!</b>\n\n`;
    newlyOpened.slice(0, 8).forEach((g, i) => {
      msg += `<b>${i + 1}. ${escapeHtml(g.name)}</b> — 💺 ${g.seats}/${g.total}\n`;
      if (g.slots[0]) {
        msg += `   📅 ${escapeHtml(g.slots[0].day)} | ⏰ ${escapeHtml(g.slots[0].time)}\n`;
        if (g.slots[0].hall) msg += `   🏛 ${escapeHtml(g.slots[0].hall)}\n`;
        if (g.slots[0].staff) msg += `   👤 ${escapeHtml(g.slots[0].staff)}\n`;
      }
      msg += `\n`;
    });
    if (newlyOpened.length > 8) {
      msg += `<i>…and ${newlyOpened.length - 8} more (see /groups).</i>\n`;
    }
    msg += `🔗 Open DULMS and register NOW!`;

    await tgSend(msg, { silent: !USER_CONFIG.notifyWithSound });
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

    const regs = state.registeredCourses.map(c => `• ${escapeHtml(c.code)}`).join('\n') || '— none —';
    await tgSend(
      `🔄 <b>Chat migration synced</b>\n\n` +
      `<b>Baseline (${state.registeredCourses.length}):</b>\n${regs}\n\n` +
      `Target: <b>${escapeHtml(USER_CONFIG.targetCourse)}</b>`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN LOOP (returns RESULT signal)
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser, deadline) {
  // Session bootstrap
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

  // Startup brief (throttled)
  const startupGapMs = USER_CONFIG.startupBriefHours * 60 * 60_000;
  if (Date.now() - state.startupBriefedAt > startupGapMs) {
    state.startupBriefedAt = Date.now();
    const missing = USER_CONFIG.expectedCourses.filter(exp =>
      !state.registeredCourses.some(c => c.code.toUpperCase().includes(exp.toUpperCase()))
    );
    const missingTxt = missing.length
      ? `\n⚠️ Waiting for: ${missing.map(escapeHtml).join(', ')}`
      : `\n✅ All expected courses present`;
    await tgSend(
      `🚀 <b>Watcher v9.0 online</b>\n\n` +
      `🎯 Sniping <b>${escapeHtml(USER_CONFIG.targetCourse)}</b> every 10s\n` +
      `🛡️ Guarding <b>${state.registeredCourses.length}</b> registered courses${missingTxt}\n\n` +
      `Send /help for commands.`
    );
    saveState(state);
  }

  log.step(`STARTED — Target: ${USER_CONFIG.targetCourse}`);

  const due = {
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

    // ── Telegram ────────────────────────────────────────────────────
    if (now >= due.telegram) {
      await handleTelegramCommands(state, api);
      due.telegram = Date.now() + USER_CONFIG.telegramPollMs;
    }

    // ── Memory watchdog ─────────────────────────────────────────────
    if (now >= due.memory) {
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
      due.memory = Date.now() + 60_000;
    }

    // ── Security check ──────────────────────────────────────────────
    if (now >= due.security) {
      const sr = await verifyRegistrationStability(api, state);

      if (sr.kind === 'ok') {
        // Resolve target if needed
        if (!state.targetCourseId) {
          const resolved = await api.resolveTargetId(USER_CONFIG.targetCourse);
          if (resolved) {
            state.targetCourseId = resolved.id;
            state.targetCourseCode = resolved.code;
            state.targetCourseName = resolved.name;
            log.ok(`Target resolved: ${resolved.code} → id ${resolved.id}`);
            audit(state, 'target_resolved', resolved);
          }
        }
        due.security = Date.now() + USER_CONFIG.securityIntervalMs;
        saveState(state);
      } else if (sr.kind === 'session_dead') {
        log.warn('Security: session dead — relogin + rebuild context');
        audit(state, 'session_dead_security');
        state.counters.relogins++;
        try { await context.close(); } catch {}
        cleanupSession();
        await loginAndCaptureCookies(browser);
        context = await createRequestContext(browser, true);
        request = context.request;
        api = makeApi(request);
        due.security = Date.now() + 5_000;
        saveState(state);
      } else {
        log.warn(`Security check failed (${sr.kind}) — retry in 60s`);
        state.counters.errors++;
        due.security = Date.now() + 60_000;
      }
    }

    // ── Sniper ──────────────────────────────────────────────────────
    if (state.targetCourseId && now >= due.sniper) {
      const sr = await sniperCheck(api, state);

      switch (sr.kind) {
        case 'session_dead': {
          log.warn('Sniper: session dead — relogin + rebuild context');
          audit(state, 'session_dead_sniper');
          state.counters.relogins++;
          try { await context.close(); } catch {}
          cleanupSession();
          await loginAndCaptureCookies(browser);
          context = await createRequestContext(browser, true);
          request = context.request;
          api = makeApi(request);
          due.sniper = Date.now() + 5_000;
          saveState(state);
          break;
        }
        case 'soft_server':
        case 'http': {
          state.counters.errors++;
          due.sniper = Date.now() + 30_000;
          log.warn('Sniper: server issue — backoff 30s');
          break;
        }
        case 'structural': {
          state.counters.errors++;
          log.err('Sniper: structural response — API shape may have changed');
          audit(state, 'structural_change');
          due.sniper = Date.now() + 60_000;
          break;
        }
        default: {
          due.sniper = Date.now() + USER_CONFIG.sniperIntervalMs;
          break;
        }
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
    log.warn(`Received ${signal} — saving state and exiting cleanly`);
    try {
      const s = loadState();
      saveState(s);
    } catch {}
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

  log.info(`Watcher v9.0 starting — PID ${process.pid}, RSS ${rssMb()} MB, deadline in ${CONFIG.durationMin} min`);

  // Register commands once
  await registerBotCommands();

  // Outer loop: allows clean browser rebuild without leaking
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

    if (result === RESULT.COMPLETED) {
      log.ok('Run completed — deadline reached');
      break;
    }
    if (result === RESULT.REBUILD) {
      log.info('Rebuilding browser context…');
      await sleep(2_000);
      continue;
    }
    if (result === RESULT.FATAL) {
      log.err('Fatal error — aborting');
      break;
    }
  }

  // Final save
  try {
    const s = loadState();
    saveState(s);
  } catch {}

  log.info(`Watcher v9.0 exiting — final RSS ${rssMb()} MB`);
})();
