/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Course Watcher - GitHub Actions Edition
 *  ─────────────────────────────────────────────────────────────────────────
 *  Runs on GitHub's servers 24/7 - your laptop can be off
 *  ─────────────────────────────────────────────────────────────────────────
 *  Environment Variables (GitHub Secrets):
 *    DULMS_USERNAME  → Student ID (12510419)
 *    DULMS_PASSWORD  → Your DULMS password
 *    TG_TOKEN        → Telegram Bot Token
 *    TG_CHAT_ID      → Telegram Chat ID
 *    DURATION_MIN    → How long to run (default: 5 minutes)
 *    CHECK_INTERVAL  → Seconds between checks (default: 30)
 * ═══════════════════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');

const CONFIG = {
  baseUrl:         'https://dulms.deltauniv.edu.eg',
  loginUrl:        'https://dulms.deltauniv.edu.eg/Login.aspx',
  coursesUrl:      'https://dulms.deltauniv.edu.eg/Registered/CoursesRegisteration',
  username:        process.env.DULMS_USERNAME || '',
  password:        process.env.DULMS_PASSWORD || '',
  tgToken:         process.env.TG_TOKEN || '',
  tgChatId:        process.env.TG_CHAT_ID || '',
  durationMin:     parseInt(process.env.DURATION_MIN || '5', 10),
  checkIntervalSec: parseInt(process.env.CHECK_INTERVAL || '30', 10),
};

// ═══════════════════════════════════════════════════════════════════════════
//  Telegram
// ═══════════════════════════════════════════════════════════════════════════
async function sendTelegram(title, body) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) {
    console.log('[TG] Not configured - skipping');
    return false;
  }
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
    if (data.ok) { console.log('[TG] ✓ Sent'); return true; }
    console.error('[TG] ✗', data.description);
    return false;
  } catch (e) {
    console.error('[TG] Error:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Login to DULMS
// ═══════════════════════════════════════════════════════════════════════════
async function loginToDulms(page) {
  console.log('[LOGIN] Opening login page...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // محاولة اختيار selector للـ username
  const usernameSelectors = [
    'input#LoginId',
    'input#txtUser',
    'input[name="LoginId"]',
    'input[name="Username"]',
    'input[type="text"]',
  ];

  let usernameField = null;
  for (const sel of usernameSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      usernameField = sel;
      console.log('[LOGIN] Username field:', sel);
      break;
    } catch (e) { /* continue */ }
  }

  if (!usernameField) {
    throw new Error('Could not find username field');
  }

  await page.fill(usernameField, CONFIG.username);

  // البحث عن password field
  const passwordSelectors = [
    'input#Password',
    'input#txtPassword',
    'input[name="Password"]',
    'input[type="password"]',
  ];

  let passwordField = null;
  for (const sel of passwordSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      passwordField = sel;
      console.log('[LOGIN] Password field:', sel);
      break;
    } catch (e) { /* continue */ }
  }

  if (!passwordField) {
    throw new Error('Could not find password field');
  }

  await page.fill(passwordField, CONFIG.password);

  // اضغط زر login
  const loginButtonSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button#btnLogin',
    'button.login-btn',
  ];

  for (const sel of loginButtonSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.log('[LOGIN] Clicking:', sel);
        await page.click(sel);
        break;
      }
    } catch (e) { /* continue */ }
  }

  // استنى التحميل
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  console.log('[LOGIN] Current URL:', page.url());
  console.log('[LOGIN] ✓ Done');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Fetch all courses and their schedules
// ═══════════════════════════════════════════════════════════════════════════
async function fetchAllCourses(page) {
  await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 });

  // استنى ظهور الكورسات
  try {
    await page.waitForSelector('article.course-item', { timeout: 20000 });
  } catch (e) {
    console.log('[COURSES] No course items found');
    return [];
  }

  // جيب الـ IDs والأسماء
  const courses = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('article.course-item[id]'));
    return items.map(el => {
      const nameEl = el.querySelector('.course-name');
      return {
        id: el.id,
        name: nameEl ? nameEl.innerText.trim() : '',
      };
    }).filter(c => c.name && c.id);
  });

  console.log(`[COURSES] Found ${courses.length} courses`);
  return courses;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Check a single course schedule
// ═══════════════════════════════════════════════════════════════════════════
async function checkCourseSchedule(page, courseId) {
  try {
    const result = await page.evaluate(async (cid) => {
      const res = await fetch('/Registered/GetCourseSchedual?CourseId=' + encodeURIComponent(cid));
      if (!res.ok) return { error: 'http_' + res.status };
      const raw = (await res.text()).trim();
      if (raw === '-1' || raw === '""') return { sessionDead: true };
      if (raw === '' || raw === 'null' || raw === '[]') return { empty: true };
      if (raw.charAt(0) === '<') return { sessionDead: true };
      try {
        return { data: JSON.parse(raw) };
      } catch (e) { return { error: 'parse' }; }
    }, courseId);

    if (result.sessionDead) return { sessionDead: true };
    if (result.empty) return { available: false, count: 0 };
    if (result.error) return { error: result.error };
    if (!Array.isArray(result.data)) return { available: false, count: 0 };

    // حلل الـ Groups
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
//  Main scan loop
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser) {
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    await loginToDulms(page);

    const courses = await fetchAllCourses(page);
    if (!courses.length) {
      console.log('[SCAN] No courses to check');
      await page.close();
      return;
    }

    // الحالة السابقة (نمررها من GitHub cache)
    const prevStateFile = '.dulms-state.json';
    const fs = require('fs');
    let prevState = {};
    try {
      if (fs.existsSync(prevStateFile)) {
        prevState = JSON.parse(fs.readFileSync(prevStateFile, 'utf8'));
      }
    } catch (e) {}

    // الفحص الدوري
    const endTime = Date.now() + CONFIG.durationMin * 60 * 1000;
    let round = 0;
    let sessionDead = false;

    while (Date.now() < endTime && !sessionDead) {
      round++;
      console.log(`\n[SCAN] Round #${round} | Courses: ${courses.length}`);

      for (const course of courses) {
        if (Date.now() >= endTime) break;

        const result = await checkCourseSchedule(page, course.id);

        if (result.sessionDead) {
          console.log(`  ⚠️ Session died - logging in again`);
          sessionDead = true;
          try {
            await loginToDulms(page);
            await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            sessionDead = false;
          } catch (e) {
            console.log('  ✗ Re-login failed:', e.message);
          }
          break;
        }

        if (result.error) {
          console.log(`  ⚠️ ${course.name} - error: ${result.error}`);
          continue;
        }

        const wasAvailable = prevState[course.id]?.available || false;
        const key = course.id;
        const newState = {
          available: result.available,
          count: result.count || 0,
          ts: Date.now(),
        };

        if (result.available && !wasAvailable) {
          // 🎉 فتح جديد!
          console.log(`  🎉 ${course.name} - OPEN! (${result.count} groups)`);

          const groupsLines = (result.groups || []).slice(0, 5).map((g, i) => {
            let line = `${i + 1}. *${g.name}*  💺 ${g.open}/${g.total}`;
            if (g.firstSlot) {
              line += `\n   📅 ${g.firstSlot.day} | ⏰ ${g.firstSlot.time}`;
              if (g.firstSlot.hall) line += `\n   🏛️ ${g.firstSlot.hall}`;
            }
            return line;
          }).join('\n\n');

          await sendTelegram(
            `🎉 ${course.name} فتح للتسجيل!`,
            `✅ *${result.count}* Group متاحة\n\n${groupsLines}\n\n🕐 ${new Date().toLocaleString('ar-EG')}\n\n🔗 سجّل فوراً على DULMS`
          );
        } else if (result.available) {
          console.log(`  ✓ ${course.name} - متاح (${result.count})`);
        } else {
          console.log(`  ○ ${course.name} - مقفول`);
        }

        prevState[key] = newState;

        // انتظار بين كل كورس
        await new Promise(r => setTimeout(r, 500));
      }

      // احفظ الحالة
      try {
        fs.writeFileSync(prevStateFile, JSON.stringify(prevState, null, 2));
      } catch (e) {}

      // انتظر قبل الدورة القادمة
      if (Date.now() < endTime) {
        console.log(`[SCAN] Sleeping ${CONFIG.checkIntervalSec}s...`);
        await new Promise(r => setTimeout(r, CONFIG.checkIntervalSec * 1000));
      }
    }

  } catch (e) {
    console.error('[SCAN] Fatal error:', e.message);
    await sendTelegram('⚠️ DULMS Watcher Error', `\`${e.message}\`\n\nسيتم إعادة المحاولة تلقائياً في الدورة القادمة.`);
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  👁️  DULMS Watcher - GitHub Actions Edition');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Username:  ${CONFIG.username ? CONFIG.username.slice(0, 4) + '***' : '(not set)'}`);
  console.log(`  Password:  ${CONFIG.password ? '***' : '(not set)'}`);
  console.log(`  Telegram:  ${CONFIG.tgToken ? '✓' : '(not set)'}`);
  console.log(`  Duration:  ${CONFIG.durationMin} minutes`);
  console.log(`  Interval:  ${CONFIG.checkIntervalSec} seconds`);
  console.log('═══════════════════════════════════════════════\n');

  if (!CONFIG.username || !CONFIG.password) {
    console.error('❌ Missing DULMS_USERNAME or DULMS_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await runScan(browser);
  } finally {
    await browser.close();
    console.log('\n[MAIN] Done');
  }
})();
