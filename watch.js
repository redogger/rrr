/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v10.0 — Rapid 10s Early Detection
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
};

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

  timezone:     'Africa/Cairo',
  stateVersion: 100,
};

const RESULT = Object.freeze({ COMPLETED: 'completed', REBUILD: 'rebuild', FATAL: 'fatal' });

const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  ok:   (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  warn: (...a) => console.warn (`[${ts()}] [WARN]`, ...a),
  err:  (...a) => console.error(`[${ts()}] [FAIL]`, ...a),
  step: (...a) => console.log (`\n[${ts()}] ━━━`, ...a, '━━━'),
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
));
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/-/g, '');

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
  } catch {}
}

function timeSince(t) {
  if (!t) return 'never';
  const d = Math.floor((Date.now() - t) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
}

function defaultState() {
  return {
    version:              CONFIG.stateVersion,
    registeredCourses:    [],
    targetCourseId:       USER_CONFIG.targetCourseId,
    targetCourseCode:     null,
    targetCourseName:     null,
    targetCourseStatus:   null,
    openGroupsState:      {},
    lastTgUpdateId:       0,
    tgChatId:             null,
    watchedGroups:        [...USER_CONFIG.preferredGroups],
    startupBriefedAt:     0,
    paused:               false,
    earlyDetection: {
      enabled:    USER_CONFIG.earlyDetectionEnabled,
      checks:     0, hits: 0,
      lastCheck:  0, lastFound: 0, notifiedAt: 0,
    },
    audit:    [],
    counters: { opens: 0, closes: 0, drops: 0, adds: 0, relogins: 0, errors: 0, alertsSent: 0 },
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
  try { rotateAuditIfNeeded(); fs.appendFileSync(CONFIG.auditFile, JSON.stringify(entry) + '\n'); } catch {}
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
        if (!body.ok && body.error_code === 429) {
          const r = (body.parameters && body.parameters.retry_after) || 5;
          tgQueue.unshift({ html: msg, silent: sil, replyMarkup: rm });
          await sleep(r * 1000);
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
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS, scope: { type: 'chat', chat_id: CONFIG.tgChatId } }),
    });
    log.ok(`Registered ${BOT_COMMANDS.length} commands`);
  } catch (e) { log.warn('Command registration failed:', e.message); }
}
