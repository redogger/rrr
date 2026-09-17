/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v4.0 — Smart Dedup + Cookie-First + Always-Notify
 *  ─────────────────────────────────────────────────────────────────────────
 *  Features:
 *    ✓ Cookie-first: reuse session until it expires
 *    ✓ Smart dedup: never notify same course twice (unless in alwaysNotify)
 *    ✓ Always-notify list: bypass dedup for specific courses (e.g., ENG)
 *    ✓ Never-notify list: silent ignore for courses you don't care about
 *    ✓ Persistent state across runs (GitHub cache + artifact backup)
 *    ✓ Fast fetch: every 10 seconds
 *    ✓ Auto re-login only when session actually dies
 *    ✓ Baseline on first run: silent, no spam
 *    ✓ Adaptive delays to prevent rate limiting
 *    ✓ Telegram notifications with detailed info
 * ═══════════════════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  🎯 إعدادات المستخدم — عدّل هنا فقط
// ═══════════════════════════════════════════════════════════════════════════
const USER_CONFIG = {
  // ⭐ المواد اللي عايز إشعار عنها **دايماً** حتى لو اتبعت قبل كده
  // (bypass dedup)
  alwaysNotify: [
    'ENG',
    'ENGLISH',
    // ضيف أي مادة تانية هنا
  ],

  // 🚫 المواد اللي **مش عايز** إشعارات عنها خالص
  neverNotify: [
    // مثال:
    // 'MEC 151',
    // 'CIV141',
  ],

  // 📜 الكود بيملأها تلقائياً — متعدلهاش يدوياً
  alreadyNotified: [],
};

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  baseUrl:          'https://dulms.deltauniv.edu.eg',
  loginUrl:         'https://dulms.deltauniv.edu.eg/Login.aspx',
  coursesUrl:       'https://dulms.deltauniv.edu.eg/Registered/CoursesRegisteration',

  username:         process.env.DULMS_USERNAME || '',
  password:         process.env.DULMS_PASSWORD || '',
  tgToken:          process.env.TG_TOKEN || '',
  tgChatId:         process.env.TG_CHAT_ID || '',
  durationMin:      parseFloat(process.env.DURATION_MIN || '4.5'),

  fetchIntervalSec: 10,
  courseDelayMs:    500,
  cookieMaxAgeMin:  15,
  maxRelogins:      5,

  stateFile:        path.join(process.cwd(), '.dulms-state.json'),
  sessionFile:      path.join(process.cwd(), '.dulms-session.json'),
  sessionMetaFile:  path.join(process.cwd(), '.dulms-session-meta.json'),
  interruptFile:    path.join(process.cwd(), '.dulms-interrupt'),
  timezone:         'Africa/Cairo',
  dryRun:           process.argv.includes('--dry-run'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════════════════
const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info:  (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  ok:    (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  warn:  (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  err:   (...a) => console.error(`[${ts()}] [FAIL]`, ...a),
  tg:    (...a) => console.log(`[${ts()}] [ TG ]`, ...a),
  skip:  (...a) => console.log(`[${ts()}] [SKIP]`, ...a),
  step:  (...a) => console.log(`\n[${ts()}] ━━━`, ...a, '━━━'),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
let lastTgCall = 0;
async function sendTelegram(title, body) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return false;
  if (CONFIG.dryRun) { log.info('[DRY]', title); return true; }
  const wait = Math.max(0, 40 - (Date.now() - lastTgCall));
  if (wait > 0) await sleep(wait);
  lastTgCall = Date.now();
  const text = (title ? `🔔 *${title}*\n` : '') + (body || '');
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.tgChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data.ok) { log.tg('✓ Sent'); return true; }
    if (data.error_code === 429) {
      const ra = data.parameters?.retry_after || 30;
      log.warn(`TG rate limited, wait ${ra}s`);
      await sleep((ra + 2) * 1000);
      return sendTelegram(title, body);
    }
    log.err('TG:', data.description);
    return false;
  } catch (e) {
    log.err('TG fetch:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const s = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
      if (s._alreadyNotified && Array.isArray(s._alreadyNotified)) {
        USER_CONFIG.alreadyNotified = s._alreadyNotified;
      }
      if (!s.courses) s.courses = {};
      return s;
    }
  } catch (e) {
    log.warn('State read failed:', e.message);
  }
  return { _lastUpdate: 0, _alreadyNotified: [], courses: {} };
}

function saveState(state) {
  try {
    state._lastUpdate = new Date().toISOString();
    state._alreadyNotified = USER_CONFIG.alreadyNotified;
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn('State write failed:', e.message);
  }
}

// ═══ Session meta ═══
function loadSessionMeta() {
  try {
    if (fs.existsSync(CONFIG.sessionMetaFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.sessionMetaFile, 'utf8'));
    }
  } catch (e) {}
  return { savedAt: 0 };
}

function saveSessionMeta() {
  try {
    fs.writeFileSync(CONFIG.sessionMetaFile, JSON.stringify({ savedAt: Date.now() }));
  } catch (e) {}
}

function sessionAgeMinutes() {
  const m = loadSessionMeta();
  return m.savedAt ? (Date.now() - m.savedAt) / 60000 : Infinity;
}

function cleanupSession() {
  try { if (fs.existsSync(CONFIG.sessionFile)) fs.unlinkSync(CONFIG.sessionFile); } catch (e) {}
  try { if (fs.existsSync(CONFIG.sessionMetaFile)) fs.unlinkSync(CONFIG.sessionMetaFile); } catch (e) {}
}

async function saveSession(ctx) {
  try {
    await ctx.storageState({ path: CONFIG.sessionFile });
    saveSessionMeta();
    log.info('Cookies saved');
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  🎯 SMART NOTIFICATION LOGIC
// ═══════════════════════════════════════════════════════════════════════════
function shouldNotify(course, result) {
  const name = course.name.toUpperCase();
  const code = course.name.split(' - ')[0].toUpperCase();

  // 1. Never-notify list
  for (const skip of USER_CONFIG.neverNotify) {
    if (name.includes(skip.toUpperCase())) {
      return { notify: false, reason: 'in neverNotify list' };
    }
  }

  // 2. Always-notify list (bypass dedup)
  for (const always of USER_CONFIG.alwaysNotify) {
    if (name.includes(always.toUpperCase())) {
      return { notify: true, reason: 'alwaysNotify (bypass dedup)', bypass: true };
    }
  }

  // 3. Dedup
  const wasNotified = USER_CONFIG.alreadyNotified.includes(code);
  if (wasNotified) {
    return { notify: false, reason: 'already notified before (dedup)' };
  }

  // 4. First time
  return { notify: true, reason: 'first time opening' };
}

function markAsNotified(course) {
  const code = course.name.split(' - ')[0].trim();
  if (!USER_CONFIG.alreadyNotified.includes(code)) {
    USER_CONFIG.alreadyNotified.push(code);
    log.info(`Added "${code}" to notified list`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BROWSER
// ═══════════════════════════════════════════════════════════════════════════
async function createBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
    ],
  });
}

async function createPage(browser, useCookies = true) {
  const opts = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: CONFIG.timezone,
  };

  let cookiesLoaded = false;
  if (useCookies && fs.existsSync(CONFIG.sessionFile)) {
    try {
      opts.storageState = CONFIG.sessionFile;
      cookiesLoaded = true;
      log.info(`Cookies loaded (age: ${sessionAgeMinutes().toFixed(1)} min)`);
    } catch (e) {}
  }

  const context = await browser.newContext(opts);
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(t)) return route.abort();
    return route.continue();
  });

  return { context, page, cookiesLoaded };
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════════════════════
async function findFirst(page, sels) {
  for (const s of sels) {
    try {
      const l = page.locator(s).first();
      if (await l.count() > 0) {
        await l.waitFor({ state: 'visible', timeout: 5000 });
        return s;
      }
    } catch (e) {}
  }
  return null;
}

async function loginToDulms(page) {
  log.info('Login (fresh)...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const u = await findFirst(page, ['input#LoginId', 'input[name="LoginId"]', 'input#txtUser', 'input[type="text"]']);
  const p = await findFirst(page, ['input#Password', 'input[name="Password"]', 'input[type="password"]']);
  const b = await findFirst(page, ['input[type="submit"]', 'button[type="submit"]']);

  if (!u || !p || !b) throw new Error('Login fields not found');

  await page.fill(u, CONFIG.username);
  await page.fill(p, CONFIG.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click(b),
  ]);

  if (page.url().includes('/Login.aspx')) throw new Error('Login failed');
  log.ok('Logged in');
}

async function validateCookies(page) {
  try {
    await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    if (page.url().includes('/Login.aspx') || page.url().includes('/Account/')) {
      log.warn('Cookies expired');
      return false;
    }

    const cnt = await page.locator('article.course-item').count();
    if (cnt === 0) {
      log.warn('No courses in page');
      return false;
    }
    log.ok(`Cookies valid (${cnt} courses)`);
    return true;
  } catch (e) {
    log.warn('Cookie validation failed:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  COURSES
// ═══════════════════════════════════════════════════════════════════════════
async function fetchAllCourses(page) {
  await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  try {
    await page.waitForSelector('article.course-item', { timeout: 20000 });
  } catch (e) {
    return [];
  }

  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.course-item[id]')).map(el => {
      const n = el.querySelector('.course-name');
      let st = 'never';
      if      (el.classList.contains('registered')) st = 'registered';
      else if (el.classList.contains('passed'))     st = 'passed';
      else if (el.classList.contains('failed'))     st = 'failed';
      else if (el.classList.contains('withdaw'))    st = 'withdrawn';
      return { id: el.id, name: n ? n.innerText.trim() : '', status: st };
    }).filter(c => c.name && c.id);
  });
}

async function checkCourse(page, id) {
  try {
    const r = await page.evaluate(async (cid) => {
      const res = await fetch('/Registered/GetCourseSchedual?CourseId=' + encodeURIComponent(cid));
      if (!res.ok) return { error: 'http_' + res.status };
      const raw = (await res.text()).trim();
      if (raw === '-1' || raw === '""' || raw.charAt(0) === '<') return { sessionDead: true };
      if (raw === '' || raw === 'null' || raw === '[]') return { empty: true };
      try { return { data: JSON.parse(raw) }; }
      catch (e) { return { error: 'parse' }; }
    }, id);

    if (r.sessionDead) return { sessionDead: true };
    if (r.empty || r.error || !Array.isArray(r.data)) return { available: false, count: 0 };

    const groups = {};
    for (const item of r.data) {
      if (item.Type !== 'Group') continue;
      const gid = item.GroupId;
      if (!groups[gid]) {
        groups[gid] = {
          name: item.GroupName,
          blocked: !!item.IsBlocked,
          total: parseInt(item.StudentsCount, 10) || 0,
          registered: parseInt(item.RegisteredCount, 10) || 0,
          slots: [],
        };
      }
      groups[gid].slots.push({
        day: item.DayWeekName,
        time: item.Time,
        hall: item.ClassRoomName,
      });
    }

    const available = Object.values(groups)
      .filter(g => !g.blocked && (g.total - g.registered) > 0)
      .map(g => ({
        name: g.name,
        open: g.total - g.registered,
        total: g.total,
        firstSlot: g.slots[0] || null,
      }))
      .sort((a, b) => b.open - a.open);

    return { available: available.length > 0, count: available.length, groups: available };
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MESSAGE FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════
function fmtOpening(course, r, isAlwaysNotify) {
  const code = course.name.split(' - ')[0];
  const L = [`✅ *${r.count}* Group(s) متاحة للتسجيل`, ''];

  r.groups.slice(0, 5).forEach((g, i) => {
    L.push(`*${i + 1}. ${g.name}*   💺 ${g.open}/${g.total}`);
    if (g.firstSlot) {
      L.push(`   📅 ${g.firstSlot.day} | ⏰ ${g.firstSlot.time}`);
      if (g.firstSlot.hall) L.push(`   🏛️ ${g.firstSlot.hall}`);
    }
    if (i < Math.min(4, r.groups.length - 1)) L.push('');
  });

  if (r.groups.length > 5) L.push(`\n_و ${r.groups.length - 5} Group إضافية..._`);

  L.push('');
  L.push(`🕐 ${new Date().toLocaleString('ar-EG', { timeZone: CONFIG.timezone })}`);

  if (isAlwaysNotify) L.push('⭐ _مادة في قائمة Always-Notify_');

  L.push('');
  L.push('🔗 افتح DULMS وسجّل فوراً!');

  return { title: `🎉 ${code} فتح للتسجيل!`, body: L.join('\n') };
}

function fmtBaseline(watchable, state) {
  const avail = watchable.filter(c => state.courses[c.id]?.available);
  const L = [
    `📚 *${watchable.length}* كورس تحت المراقبة`,
    '',
    `✅ *${avail.length}* متاح حالياً:`,
    '',
  ];

  avail.slice(0, 15).forEach(c => L.push(`  • ${c.name}`));
  if (avail.length > 15) L.push(`  _...و ${avail.length - 15} أخرى_`);

  L.push('');
  L.push(`🕐 ${new Date().toLocaleString('ar-EG', { timeZone: CONFIG.timezone })}`);
  L.push('');
  L.push(`⭐ *Always-Notify:* ${USER_CONFIG.alwaysNotify.join(', ') || '(empty)'}`);
  L.push(`🚫 *Never-Notify:* ${USER_CONFIG.neverNotify.join(', ') || '(empty)'}`);
  L.push('');
  L.push('_ستصلك رسالة فوراً عند فتح أي كورس جديد_');

  return { title: '👁️ DULMS Watcher v4.0 — بدأ المراقبة', body: L.join('\n') };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SCAN
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser) {
  let { context, page, cookiesLoaded } = await createPage(browser, true);
  let hasValidSession = false;

  if (cookiesLoaded && sessionAgeMinutes() < CONFIG.cookieMaxAgeMin) {
    hasValidSession = await validateCookies(page);
  } else if (cookiesLoaded) {
    log.warn(`Cookies too old (${sessionAgeMinutes().toFixed(1)} min)`);
    cleanupSession();
    await context.close();
    ({ context, page } = await createPage(browser, false));
  }

  const state = loadState();
  const isFirstRun = !state._lastUpdate;
  let reloginCount = 0;

  try {
    if (!hasValidSession) {
      await loginToDulms(page);
      await saveSession(context);
      reloginCount++;
    }

    const courses = await fetchAllCourses(page);
    const watchable = courses.filter(c => c.status === 'never');
    log.info(`Watching ${watchable.length}/${courses.length} courses`);

    if (!watchable.length) throw new Error('No watchable courses');

    log.step(isFirstRun ? 'FIRST RUN — baseline (no alerts)' : 'RESUMED');
    if (USER_CONFIG.alwaysNotify.length) {
      log.info(`Always-Notify: ${USER_CONFIG.alwaysNotify.join(', ')}`);
    }
    if (USER_CONFIG.neverNotify.length) {
      log.info(`Never-Notify: ${USER_CONFIG.neverNotify.join(', ')}`);
    }
    if (USER_CONFIG.alreadyNotified.length) {
      log.info(`Already notified: ${USER_CONFIG.alreadyNotified.length} courses`);
    }

    const endTime = Date.now() + CONFIG.durationMin * 60 * 1000;
    let cycle = 0;

    while (Date.now() < endTime) {
      if (fs.existsSync(CONFIG.interruptFile)) {
        log.warn('Interrupt');
        try { fs.unlinkSync(CONFIG.interruptFile); } catch (e) {}
        break;
      }

      const cycleStart = Date.now();
      cycle++;
      const elapsed = ((Date.now() - (endTime - CONFIG.durationMin * 60 * 1000)) / 1000).toFixed(0);
      const left = ((endTime - Date.now()) / 1000).toFixed(0);
      log.step(`Cycle #${cycle} | ${elapsed}s | ${left}s left | cookie: ${sessionAgeMinutes().toFixed(0)}min`);

      let sessionDead = false;

      for (let i = 0; i < watchable.length; i++) {
        if (Date.now() >= endTime) break;

        const course = watchable[i];
        const r = await checkCourse(page, course.id);

        if (r.sessionDead) {
          log.warn(`Session died at [${i + 1}/${watchable.length}] ${course.name}`);
          sessionDead = true;
          break;
        }

        if (r.error) {
          log.warn(`${course.name} — ${r.error}`);
          continue;
        }

        const key = course.id;
        const wasOpen = state.courses[key]?.available || false;
        const nowOpen = r.available;

        if (nowOpen && !wasOpen && !isFirstRun) {
          const decision = shouldNotify(course, r);
          if (decision.notify) {
            log.ok(`🎉 ${course.name} — OPEN (${r.count}) [${decision.reason}]`);
            const msg = fmtOpening(course, r, decision.bypass);
            await sendTelegram(msg.title, msg.body);
            if (!decision.bypass) markAsNotified(course);
          } else {
            log.skip(`🎉 ${course.name} — OPEN but ${decision.reason}`);
          }
        } else if (nowOpen) {
          log.ok(`${course.name} — متاح (${r.count})`);
        } else {
          log.info(`${course.name} — مقفول`);
        }

        state.courses[key] = {
          available: nowOpen,
          count: r.count || 0,
          lastCheck: Date.now(),
        };

        if (i < watchable.length - 1) await sleep(CONFIG.courseDelayMs);
      }

      saveState(state);

      // Session died → re-login
      if (sessionDead) {
        if (reloginCount < CONFIG.maxRelogins) {
          log.warn(`Re-login #${reloginCount + 1}`);
          try {
            cleanupSession();
            await context.close();
            ({ context, page } = await createPage(browser, false));
            await loginToDulms(page);
            await saveSession(context);
            reloginCount++;
            log.ok('Re-login ✓');
            continue;
          } catch (e) {
            log.err('Re-login failed:', e.message);
            break;
          }
        } else {
          log.err('Max re-logins reached');
          break;
        }
      }

      const cycleElapsed = Date.now() - cycleStart;
      const sleepTime = Math.max(0, CONFIG.fetchIntervalSec * 1000 - cycleElapsed);
      if (sleepTime > 0) {
        log.info(`Cycle: ${(cycleElapsed / 1000).toFixed(1)}s | sleeping ${(sleepTime / 1000).toFixed(1)}s`);
        await sleep(sleepTime);
      }
    }

    if (isFirstRun) {
      const msg = fmtBaseline(watchable, state);
      await sendTelegram(msg.title, msg.body);
    }

    log.step(`SCAN COMPLETE — ${cycle} cycles, ${reloginCount} logins`);

  } catch (e) {
    log.err('FATAL:', e.message);
    await sendTelegram('⚠️ DULMS Watcher Error', `\`${e.message}\``);
    throw e;
  } finally {
    await context.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const t0 = Date.now();

  console.log('\n═══════════════════════════════════════════════');
  console.log('  🎯 DULMS Watcher v4.0 — Smart Dedup');
  console.log('═══════════════════════════════════════════════');
  console.log(`  User:            ${CONFIG.username ? CONFIG.username.slice(0, 4) + '***' : '(not set)'}`);
  console.log(`  Telegram:        ${CONFIG.tgToken ? '✓' : '(not set)'}`);
  console.log(`  Duration:        ${CONFIG.durationMin} min`);
  console.log(`  Fetch every:     ${CONFIG.fetchIntervalSec}s`);
  console.log(`  Cookie max age:  ${CONFIG.cookieMaxAgeMin} min`);
  console.log(`  Always-notify:   ${USER_CONFIG.alwaysNotify.join(', ') || '(none)'}`);
  console.log(`  Never-notify:    ${USER_CONFIG.neverNotify.join(', ') || '(none)'}`);
  console.log(`  Node:            ${process.version}`);
  console.log('═══════════════════════════════════════════════\n');

  if (!CONFIG.username || !CONFIG.password) {
    log.err('Missing DULMS_USERNAME or DULMS_PASSWORD');
    process.exit(1);
  }

  const browser = await createBrowser();

  const shutdown = async (sig) => {
    log.warn(`Received ${sig} — shutting down`);
    try { fs.writeFileSync(CONFIG.interruptFile, '1'); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runScan(browser);
  } catch (e) {
    log.err('Run failed:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log(`\n[MAIN] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }
})();
