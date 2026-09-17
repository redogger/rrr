/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v3.0 — Production Grade
 *  ─────────────────────────────────────────────────────────────────────────
 *  Improvements over v2.0:
 *    ✓ Session persistence via storageState (Playwright best practice)
 *    ✓ Multi-selector fallback (robust to DULMS changes)
 *    ✓ Telegram rate-limit handling (30/sec) + retry on 429
 *    ✓ Persists state to cache + artifact backup
 *    ✓ First-run baseline (silent mode, no spam)
 *    ✓ Registered/passed courses filtering
 *    ✓ Graceful shutdown + interrupt support
 *    ✓ Detailed logging with context
 *    ✓ Auto re-login on session death (max 3 attempts)
 *    ✓ Timezone-aware timestamps (Africa/Cairo)
 *    ✓ Node.js 22 compatible
 * ═══════════════════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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
  checkIntervalSec: parseInt(process.env.CHECK_INTERVAL || '30', 10),
  stateFile:        path.join(process.cwd(), '.dulms-state.json'),
  sessionFile:      path.join(process.cwd(), '.dulms-session.json'),
  interruptFile:    path.join(process.cwd(), '.dulms-interrupt'),
  timezone:         'Africa/Cairo',
  maxRelogins:      3,
  dryRun:           process.argv.includes('--dry-run'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGER (with timestamps)
// ═══════════════════════════════════════════════════════════════════════════
const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info:  (...a) => console.log(`[${ts()}] [INFO]`,  ...a),
  ok:    (...a) => console.log(`[${ts()}] [ OK ]`,  ...a),
  warn:  (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  err:   (...a) => console.error(`[${ts()}] [FAIL]`, ...a),
  tg:    (...a) => console.log(`[${ts()}] [ TG ]`,  ...a),
  step:  (...a) => console.log(`\n[${ts()}] ━━━`, ...a, '━━━'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM (with rate-limit handling + retry)
// ═══════════════════════════════════════════════════════════════════════════
let lastTelegramCall = 0;
const TG_MIN_INTERVAL = 40; // ms — يضمن أقل من 30 msg/sec

async function sendTelegram(title, body, attempt = 1) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) {
    log.warn('Telegram not configured');
    return false;
  }
  if (CONFIG.dryRun) {
    log.info('[DRY-RUN] Telegram:', title);
    return true;
  }

  // Rate limiting (30 msg/sec = 33ms بين كل طلب)
  const now = Date.now();
  const wait = Math.max(0, TG_MIN_INTERVAL - (now - lastTelegramCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastTelegramCall = Date.now();

  const text = (title ? `🔔 *${title}*\n` : '') + (body || '');
  const url = `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`;

  try {
    const res = await fetch(url, {
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

    // Rate limit reached
    if (data.error_code === 429) {
      const retryAfter = data.parameters?.retry_after || 30;
      log.warn(`Telegram rate limited. Retry after ${retryAfter}s`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, (retryAfter + 2) * 1000));
        return sendTelegram(title, body, attempt + 1);
      }
    }

    log.err('Telegram error:', data.description);
    return false;
  } catch (e) {
    if (attempt < 3) {
      log.warn(`Telegram retry ${attempt}/3 in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return sendTelegram(title, body, attempt + 1);
    }
    log.err('Telegram failed:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
      const n = Object.keys(state).filter(k => !k.startsWith('_')).length;
      log.info(`State loaded: ${n} courses, last update: ${state._lastUpdate || 'never'}`);
      return state;
    }
  } catch (e) { log.warn('State read failed:', e.message); }
  return {};
}

function saveState(state) {
  try {
    state._lastUpdate = new Date().toISOString();
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
    const n = Object.keys(state).filter(k => !k.startsWith('_')).length;
    log.ok(`State saved (${n} courses)`);
  } catch (e) { log.warn('State write failed:', e.message); }
}

function cleanupSession() {
  try { if (fs.existsSync(CONFIG.sessionFile)) fs.unlinkSync(CONFIG.sessionFile); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  BROWSER HELPERS
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
      '--no-zygote',
      '--single-process', // يستخدم ذاكرة أقل
    ],
  });
}

async function createContext(browser, useStoredSession = true) {
  const opts = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: CONFIG.timezone,
  };

  // محاولة استخدام الجلسة المحفوظة (Playwright best practice)
  if (useStoredSession && fs.existsSync(CONFIG.sessionFile)) {
    try {
      opts.storageState = CONFIG.sessionFile;
      log.info('Using stored session');
    } catch (e) {
      log.warn('Session file corrupt, starting fresh');
    }
  }

  const context = await browser.newContext(opts);
  const page = await context.newPage();

  // حجب الصور والـ fonts لتسريع التحميل
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(t)) return route.abort();
    return route.continue();
  });

  return { context, page };
}

async function saveSession(context) {
  try {
    await context.storageState({ path: CONFIG.sessionFile });
    log.info('Session saved to disk');
  } catch (e) {
    log.warn('Session save failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOGIN (with multi-selector fallback)
// ═══════════════════════════════════════════════════════════════════════════
async function findFirstMatch(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        await loc.waitFor({ state: 'visible', timeout });
        return sel;
      }
    } catch (e) { /* continue */ }
  }
  return null;
}

async function loginToDulms(page) {
  log.info('Logging in...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const userSel = await findFirstMatch(page, [
    'input#LoginId', 'input[name="LoginId"]', 'input#txtUser',
    'input[name="Username"]', 'input[type="text"]'
  ]);
  const passSel = await findFirstMatch(page, [
    'input#Password', 'input[name="Password"]',
    'input#txtPassword', 'input[type="password"]'
  ]);
  const btnSel = await findFirstMatch(page, [
    'input[type="submit"]', 'button[type="submit"]',
    'button#btnLogin', 'button.login-btn'
  ]);

  if (!userSel || !passSel || !btnSel) {
    throw new Error(`Login fields not found (user=${userSel}, pass=${passSel}, btn=${btnSel})`);
  }

  log.info(`Fields: user="${userSel}", pass="${passSel}", btn="${btnSel}"`);

  await page.fill(userSel, CONFIG.username);
  await page.fill(passSel, CONFIG.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click(btnSel),
  ]);

  const finalUrl = page.url();
  if (finalUrl.includes('/Login.aspx') || finalUrl.includes('error')) {
    throw new Error(`Login failed — still at ${finalUrl}`);
  }
  log.ok(`Logged in → ${finalUrl}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  FETCH COURSES
// ═══════════════════════════════════════════════════════════════════════════
async function fetchAllCourses(page) {
  await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  try {
    await page.waitForSelector('article.course-item', { timeout: 20000 });
  } catch (e) {
    log.warn('No course items in DOM');
    return [];
  }

  const courses = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('article.course-item[id]'));
    return items.map(el => {
      const nameEl = el.querySelector('.course-name');
      let status = 'never';
      if      (el.classList.contains('registered')) status = 'registered';
      else if (el.classList.contains('passed'))     status = 'passed';
      else if (el.classList.contains('failed'))     status = 'failed';
      else if (el.classList.contains('withdaw'))    status = 'withdrawn';
      return {
        id: el.id,
        name: nameEl ? nameEl.innerText.trim() : '',
        status,
      };
    }).filter(c => c.name && c.id);
  });

  log.info(`Found ${courses.length} courses`);
  return courses;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHECK COURSE SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════
async function checkCourseSchedule(page, courseId) {
  try {
    const result = await page.evaluate(async (cid) => {
      const res = await fetch('/Registered/GetCourseSchedual?CourseId=' + encodeURIComponent(cid));
      if (!res.ok) return { error: 'http_' + res.status };
      const raw = (await res.text()).trim();
      if (raw === '-1' || raw === '""' || raw.charAt(0) === '<') return { sessionDead: true };
      if (raw === '' || raw === 'null' || raw === '[]') return { empty: true };
      try { return { data: JSON.parse(raw) }; }
      catch (e) { return { error: 'parse' }; }
    }, courseId);

    if (result.sessionDead) return { sessionDead: true };
    if (result.empty || result.error) return { available: false, count: 0 };
    if (!Array.isArray(result.data)) return { available: false, count: 0 };

    const groupsMap = {};
    for (const item of result.data) {
      if (item.Type !== 'Group') continue;
      const gid = item.GroupId;
      if (!groupsMap[gid]) {
        groupsMap[gid] = {
          name: item.GroupName,
          blocked: !!item.IsBlocked,
          total: parseInt(item.StudentsCount, 10) || 0,
          registered: parseInt(item.RegisteredCount, 10) || 0,
          slots: [],
        };
      }
      groupsMap[gid].slots.push({
        day: item.DayWeekName,
        time: item.Time,
        hall: item.ClassRoomName,
      });
    }

    const available = Object.values(groupsMap)
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
//  TELEGRAM MESSAGE FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════
function formatOpeningMessage(course, result) {
  const courseCode = course.name.split(' - ')[0];
  const lines = [];

  lines.push(`✅ *${result.count}* Group(s) متاحة للتسجيل`);
  lines.push('');

  result.groups.slice(0, 5).forEach((g, i) => {
    lines.push(`*${i + 1}. ${g.name}*   💺 ${g.open}/${g.total}`);
    if (g.firstSlot) {
      lines.push(`   📅 ${g.firstSlot.day} | ⏰ ${g.firstSlot.time}`);
      if (g.firstSlot.hall) lines.push(`   🏛️ ${g.firstSlot.hall}`);
    }
    if (i < Math.min(4, result.groups.length - 1)) lines.push('');
  });

  if (result.groups.length > 5) {
    lines.push(`\n_و ${result.groups.length - 5} Group إضافية..._`);
  }

  lines.push('');
  lines.push(`🕐 ${new Date().toLocaleString('ar-EG', { timeZone: CONFIG.timezone })}`);
  lines.push('');
  lines.push('🔗 افتح DULMS وسجّل فوراً!');

  return {
    title: `🎉 ${courseCode} فتح للتسجيل!`,
    body: lines.join('\n'),
  };
}

function formatBaselineMessage(watchable, prevState) {
  const avail = watchable.filter(c => prevState[c.id]?.available);
  const lines = [];

  lines.push(`📚 *${watchable.length}* كورس تحت المراقبة`);
  lines.push('');
  lines.push(`✅ *${avail.length}* متاح حالياً:`);
  lines.push('');
  avail.slice(0, 15).forEach(c => lines.push(`  • ${c.name}`));
  if (avail.length > 15) lines.push(`  _...و ${avail.length - 15} أخرى_`);

  lines.push('');
  lines.push(`🕐 ${new Date().toLocaleString('ar-EG', { timeZone: CONFIG.timezone })}`);
  lines.push('');
  lines.push('_ستصلك رسالة فوراً عند فتح أي كورس جديد_');

  return {
    title: '👁️ DULMS Watcher — بدأ المراقبة',
    body: lines.join('\n'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SCAN LOOP
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser) {
  let { context, page } = await createContext(browser, true);

  try {
    // ─── 1. Login ───
    let loggedIn = false;

    // جرّب الجلسة المحفوظة أولاً
    if (fs.existsSync(CONFIG.sessionFile)) {
      try {
        await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        const url = page.url();
        if (url.includes('/Login.aspx') || url.includes('/Account/')) {
          log.warn('Stored session expired — re-login');
          cleanupSession();
        } else {
          log.ok('Reused stored session ✓');
          loggedIn = true;
        }
      } catch (e) {
        log.warn('Session check failed:', e.message);
      }
    }

    if (!loggedIn) {
      await loginToDulms(page);
      await saveSession(context);
    }

    // ─── 2. Fetch courses ───
    const courses = await fetchAllCourses(page);
    if (!courses.length) throw new Error('No courses found');

    // ─── 3. Filter ───
    const watchable = courses.filter(c => c.status === 'never');
    log.info(`Watching ${watchable.length}/${courses.length} courses (skip registered/passed/failed/withdrawn)`);

    if (!watchable.length) {
      log.warn('No watchable courses');
      return;
    }

    // ─── 4. State ───
    const prevState = loadState();
    const isFirstRun = !prevState._lastUpdate;
    log.step(isFirstRun ? 'FIRST RUN — baseline mode' : 'RESUMED — will alert on new openings');

    // ─── 5. Scan loop ───
    const endTime = Date.now() + CONFIG.durationMin * 60 * 1000;
    let round = 0;
    let reLoginCount = 0;

    while (Date.now() < endTime) {
      // Interrupt check
      if (fs.existsSync(CONFIG.interruptFile)) {
        log.warn('Interrupt — stopping');
        try { fs.unlinkSync(CONFIG.interruptFile); } catch (e) {}
        break;
      }

      round++;
      const elapsed = ((Date.now() - (endTime - CONFIG.durationMin * 60 * 1000)) / 1000).toFixed(0);
      const remaining = ((endTime - Date.now()) / 1000).toFixed(0);
      log.step(`Round #${round} | ${elapsed}s elapsed | ${remaining}s remaining`);

      let sessionDead = false;

      for (const course of watchable) {
        if (Date.now() >= endTime) break;

        const result = await checkCourseSchedule(page, course.id);

        if (result.sessionDead) {
          log.warn('Session died');
          if (reLoginCount < CONFIG.maxRelogins) {
            reLoginCount++;
            try {
              cleanupSession();
              await loginToDulms(page);
              await saveSession(context);
              await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              log.ok(`Re-login #${reLoginCount} successful`);
              sessionDead = false;
              break; // restart this round
            } catch (e) {
              log.err('Re-login failed:', e.message);
              sessionDead = true;
            }
          } else {
            log.err('Max re-logins reached');
            sessionDead = true;
          }
          break;
        }

        if (result.error) {
          log.warn(`${course.name} — ${result.error}`);
          continue;
        }

        const key = course.id;
        const wasOpen = prevState[key]?.available || false;
        const nowOpen = result.available;

        if (nowOpen && !wasOpen && !isFirstRun) {
          log.ok(`🎉 ${course.name} — OPEN! (${result.count} groups)`);
          const msg = formatOpeningMessage(course, result);
          await sendTelegram(msg.title, msg.body);
        } else if (nowOpen) {
          log.ok(`${course.name} — متاح (${result.count})`);
        } else {
          log.info(`${course.name} — مقفول`);
        }

        prevState[key] = {
          available: nowOpen,
          count: result.count || 0,
          lastCheck: Date.now(),
        };

        await new Promise(r => setTimeout(r, 800)); // تأخير بين الكورسات
      }

      if (sessionDead) log.warn('Skipping rest of round');

      saveState(prevState);

      const remainingMs = endTime - Date.now();
      if (remainingMs > CONFIG.checkIntervalSec * 1000) {
        log.info(`Sleeping ${CONFIG.checkIntervalSec}s...`);
        await new Promise(r => setTimeout(r, CONFIG.checkIntervalSec * 1000));
      }
    }

    // ─── 6. Baseline notification ───
    if (isFirstRun) {
      const msg = formatBaselineMessage(watchable, prevState);
      await sendTelegram(msg.title, msg.body);
    }

    log.step(`SCAN COMPLETE — ${round} rounds`);

  } catch (e) {
    log.err('FATAL:', e.message);
    await sendTelegram(
      '⚠️ DULMS Watcher Error',
      `\`${e.message}\`\n\n_سيُعاد التشغيل تلقائياً_`
    );
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
  console.log('  👁️  DULMS Watcher v3.0 — Production Grade');
  console.log('═══════════════════════════════════════════════');
  console.log(`  User:       ${CONFIG.username ? CONFIG.username.slice(0, 4) + '***' : '❌ MISSING'}`);
  console.log(`  Password:   ${CONFIG.password ? '✓ set' : '❌ MISSING'}`);
  console.log(`  Telegram:   ${CONFIG.tgToken ? '✓' : '❌ MISSING'}`);
  console.log(`  Duration:   ${CONFIG.durationMin} minutes`);
  console.log(`  Interval:   ${CONFIG.checkIntervalSec}s`);
  console.log(`  Dry run:    ${CONFIG.dryRun}`);
  console.log(`  Node:       ${process.version}`);
  console.log('═══════════════════════════════════════════════\n');

  if (!CONFIG.username || !CONFIG.password) {
    log.err('Missing DULMS_USERNAME or DULMS_PASSWORD');
    process.exit(1);
  }

  const browser = await createBrowser();

  // Graceful shutdown
  const shutdown = async (sig) => {
    log.warn(`Received ${sig} — shutting down`);
    try { fs.writeFileSync(CONFIG.interruptFile, '1'); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runScan(browser);
  } catch (e) {
    log.err('Run failed:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[MAIN] Done in ${elapsed}s\n`);
  }
})();
