/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v2.0 — Premium Edition
 *  ─────────────────────────────────────────────────────────────────────────
 *  ✓ Runs on GitHub Actions 24/7 (your laptop can be off)
 *  ✓ Auto-login with session recovery
 *  ✓ Filters out registered/passed courses
 *  ✓ Detects NEW openings only (no spam)
 *  ✓ Persistent state across runs (GitHub cache)
 *  ✓ Telegram notifications with detailed info
 *  ✓ First-run baseline (silent mode)
 *  ✓ Graceful shutdown with cleanup
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
  interruptFile:    path.join(process.cwd(), '.dulms-interrupt'),
  dryRun:           process.argv.includes('--dry-run'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════════════════
const log = {
  info:  (...a) => console.log('[INFO]',  ...a),
  ok:    (...a) => console.log('[ OK ]',  ...a),
  warn:  (...a) => console.warn('[WARN]', ...a),
  err:   (...a) => console.error('[FAIL]', ...a),
  tg:    (...a) => console.log('[ TG ]',  ...a),
  step:  (...a) => console.log('\n━━━', ...a, '━━━'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
async function sendTelegram(title, body, options = {}) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) {
    log.warn('Telegram not configured');
    return false;
  }
  if (CONFIG.dryRun) {
    log.info('[DRY-RUN] Would send:', title);
    return true;
  }

  const text = (title ? `🔔 *${title}*\n` : '') + (body || '');
  const url = `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt++) {
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
      log.err('Telegram error:', data.description);
      return false;
    } catch (e) {
      if (attempt < 3) {
        log.warn(`Telegram retry ${attempt}/3 in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        log.err('Telegram failed after 3 attempts:', e.message);
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const raw = fs.readFileSync(CONFIG.stateFile, 'utf8');
      const state = JSON.parse(raw);
      log.info(`State loaded: ${Object.keys(state).length} entries from ${state._lastUpdate || 'unknown'}`);
      return state;
    }
  } catch (e) { log.warn('State read failed:', e.message); }
  return {};
}

function saveState(state) {
  try {
    state._lastUpdate = new Date().toISOString();
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
    log.ok(`State saved (${Object.keys(state).length - 1} entries)`);
  } catch (e) { log.warn('State write failed:', e.message); }
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
    ],
  });
}

async function createPage(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
  });
  const page = await context.newPage();
  // سرعة تحميل: حجب الصور والـ fonts
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') {
      return route.abort();
    }
    return route.continue();
  });
  return page;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════════════════════
async function loginToDulms(page) {
  log.info('Logging in...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // اكتشاف حقول تسجيل الدخول
  const userSelectors = ['input#LoginId', 'input[name="LoginId"]', 'input#txtUser', 'input[type="text"]'];
  const passSelectors = ['input#Password', 'input[name="Password"]', 'input[type="password"]'];
  const btnSelectors  = ['input[type="submit"]', 'button[type="submit"]', 'button#btnLogin'];

  let userField = null, passField = null, btnField = null;

  for (const sel of userSelectors) {
    if (await page.locator(sel).count() > 0) { userField = sel; break; }
  }
  for (const sel of passSelectors) {
    if (await page.locator(sel).count() > 0) { passField = sel; break; }
  }
  for (const sel of btnSelectors) {
    if (await page.locator(sel).count() > 0) { btnField = sel; break; }
  }

  if (!userField || !passField || !btnField) {
    throw new Error(`Login fields not found (u=${userField}, p=${passField}, b=${btnField})`);
  }

  await page.fill(userField, CONFIG.username);
  await page.fill(passField, CONFIG.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click(btnField),
  ]);

  const finalUrl = page.url();
  if (!finalUrl.includes('/Login.aspx')) {
    log.ok(`Logged in → ${finalUrl}`);
  } else {
    throw new Error('Login failed — still on login page');
  }
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
    log.warn('No course items found in DOM');
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
      return { id: el.id, name: nameEl ? nameEl.innerText.trim() : '', status };
    }).filter(c => c.name && c.id);
  });

  log.info(`Found ${courses.length} courses`);
  return courses;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHECK SINGLE COURSE SCHEDULE
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
//  FORMAT TELEGRAM MESSAGE
// ═══════════════════════════════════════════════════════════════════════════
function formatOpeningMessage(course, result) {
  const lines = [];
  const courseName = course.name.split(' - ').slice(1).join(' - ') || course.name;
  const courseCode = course.name.split(' - ')[0];

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
    lines.push('');
    lines.push(`_و ${result.groups.length - 5} Group إضافية..._`);
  }

  lines.push('');
  lines.push(`🕐 ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}`);
  lines.push('');
  lines.push('🔗 افتح DULMS وسجّل فوراً!');

  return {
    title: `🎉 ${courseCode} فتح للتسجيل!`,
    body: lines.join('\n'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SCAN LOOP
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser) {
  const page = await createPage(browser);

  try {
    // ── 1. Login ──
    await loginToDulms(page);

    // ── 2. Fetch courses ──
    const courses = await fetchAllCourses(page);
    if (!courses.length) {
      throw new Error('No courses found — page structure may have changed');
    }

    // ── 3. Filter registered/passed ──
    const watchable = courses.filter(c => c.status === 'never');
    log.info(`Watching ${watchable.length}/${courses.length} courses (skip registered/passed/failed/withdrawn)`);
    watchable.forEach(c => log.info(`  • ${c.id} — ${c.name}`));

    if (!watchable.length) {
      log.warn('No watchable courses — all are registered/passed');
      return;
    }

    // ── 4. Load state ──
    const prevState = loadState();
    const isFirstRun = !prevState._lastUpdate;

    if (isFirstRun) {
      log.step('FIRST RUN — baseline mode (no alerts, saving current state)');
    } else {
      log.step('RESUMED — will alert on new openings');
    }

    // ── 5. Scan loop ──
    const endTime = Date.now() + CONFIG.durationMin * 60 * 1000;
    let round = 0;
    const newOpenings = [];

    while (Date.now() < endTime) {
      // Graceful interrupt
      if (fs.existsSync(CONFIG.interruptFile)) {
        log.warn('Interrupt signal received — stopping early');
        try { fs.unlinkSync(CONFIG.interruptFile); } catch (e) {}
        break;
      }

      round++;
      const elapsed = ((Date.now() - (endTime - CONFIG.durationMin * 60 * 1000)) / 1000).toFixed(0);
      log.step(`Round #${round} | elapsed ${elapsed}s | remaining ${((endTime - Date.now()) / 1000).toFixed(0)}s`);

      let sessionDead = false;

      for (const course of watchable) {
        if (Date.now() >= endTime) break;

        const result = await checkCourseSchedule(page, course.id);

        // ── Session recovery ──
        if (result.sessionDead) {
          log.warn('Session died — re-login attempt');
          try {
            await loginToDulms(page);
            await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            sessionDead = false;
            log.ok('Session restored');
          } catch (e) {
            log.err('Re-login failed:', e.message);
            sessionDead = true;
          }
          break;
        }

        if (result.error) {
          log.warn(`${course.name} — ${result.error}`);
          continue;
        }

        // ── Detect transition ──
        const key = course.id;
        const wasOpen = prevState[key]?.available || false;
        const nowOpen = result.available;

        if (nowOpen && !wasOpen && !isFirstRun) {
          // 🎉 NEW OPENING
          log.ok(`🎉 ${course.name} — OPEN! (${result.count} groups)`);
          const msg = formatOpeningMessage(course, result);
          const sent = await sendTelegram(msg.title, msg.body);
          if (sent) newOpenings.push(course.name);
        } else if (nowOpen) {
          log.ok(`${course.name} — متاح (${result.count})`);
        } else {
          log.info(`${course.name} — مقفول`);
        }

        // ── Update state ──
        prevState[key] = {
          available: nowOpen,
          count: result.count || 0,
          lastCheck: Date.now(),
        };

        // ── Politeness delay between courses ──
        await new Promise(r => setTimeout(r, 800));
      }

      if (sessionDead) {
        log.warn('Skipping rest of this round due to session death');
      }

      // ── Save state after each round ──
      saveState(prevState);

      // ── Wait before next round ──
      const remaining = endTime - Date.now();
      if (remaining > CONFIG.checkIntervalSec * 1000) {
        log.info(`Sleeping ${CONFIG.checkIntervalSec}s...`);
        await new Promise(r => setTimeout(r, CONFIG.checkIntervalSec * 1000));
      }
    }

    // ── 6. Summary ──
    log.step('SCAN COMPLETE');
    log.info(`Rounds: ${round}`);
    log.info(`New openings: ${newOpenings.length}`);

    // ── 7. First-run baseline notification ──
    if (isFirstRun) {
      const nowAvailable = watchable.filter(c => prevState[c.id]?.available);
      const body = [
        `📚 *${watchable.length}* كورس تحت المراقبة`,
        `✅ *${nowAvailable.length}* متاح حالياً:`,
        '',
        ...nowAvailable.slice(0, 15).map(c => `  • ${c.name}`),
        nowAvailable.length > 15 ? `  _...و ${nowAvailable.length - 15} أخرى_` : '',
        '',
        `🕐 ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}`,
        '',
        '_ستصلك رسالة فوراً عند فتح أي كورس جديد_',
      ].filter(Boolean).join('\n');

      await sendTelegram('👁️ DULMS Watcher — بدأ المراقبة', body);
    }

  } catch (e) {
    log.err('FATAL:', e.message);
    await sendTelegram(
      '⚠️ DULMS Watcher Error',
      `\`${e.message}\`\n\n_سيُعاد التشغيل تلقائياً_`
    );
    throw e;
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const t0 = Date.now();

  console.log('\n═══════════════════════════════════════════════');
  console.log('  👁️  DULMS Watcher v2.0 — Premium Edition');
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
  const shutdown = async (signal) => {
    log.warn(`Received ${signal} — shutting down`);
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
