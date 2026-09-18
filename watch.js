/* ═══════════════════════════════════════════════════════════════════════════
 *  DULMS Watcher v5.0 — Personal Guard & Targeted Sniper Edition
 * ═══════════════════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  🎯 إعداداتك الشخصية
// ═══════════════════════════════════════════════════════════════════════════
const USER_CONFIG = {
  targetCourse: 'GEN 101',      // المادة المستهدفة للفحص السريع
  checkRegIntervalMin: 10,      // كل كام دقيقة يفحص استقرار تسجيل موادك
  sendStartupMessage: true,     // يبعتلك "مرحباً أنا شغال" أول ما يشتغل
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
  durationMin:      parseFloat(process.env.DURATION_MIN || '50'),

  fetchIntervalSec: 10,
  cookieMaxAgeMin:  15,
  maxRelogins:      10,

  stateFile:        path.join(process.cwd(), '.dulms-state.json'),
  sessionFile:      path.join(process.cwd(), '.dulms-session.json'),
  sessionMetaFile:  path.join(process.cwd(), '.dulms-session-meta.json'),
  interruptFile:    path.join(process.cwd(), '.dulms-interrupt'),
  timezone:         'Africa/Cairo',
};

const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info:  (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  ok:    (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  warn:  (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  err:   (...a) => console.error(`[${ts()}] [FAIL]`, ...a),
  step:  (...a) => console.log(`\n[${ts()}] ━━━`, ...a, '━━━'),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
//  إرسال التيليجرام
// ═══════════════════════════════════════════════════════════════════════════
async function sendTelegram(title, body) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
  const text = (title ? `*${title}*\n` : '') + (body || '');
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.tgChatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  استقبال أوامر التيليجرام (/start)
// ═══════════════════════════════════════════════════════════════════════════
async function handleTelegramCommands(state) {
  if (!CONFIG.tgToken) return;
  try {
    const offset = state.lastTgUpdateId ? state.lastTgUpdateId + 1 : -1;
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${offset}&timeout=0`);
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      for (const msg of data.result) {
        state.lastTgUpdateId = msg.update_id;
        if (msg.message && msg.message.text === '/start') {
          await sendTelegram('🟢 أنا شغال بكفاءة!', `البوت نشط ومستمر في عمله:\n\n⚡ أفحص ${USER_CONFIG.targetCourse} كل 10 ثواني.\n🛡️ أراقب استقرار تسجيل بقية موادك كل ${USER_CONFIG.checkRegIntervalMin} دقائق.\n\nلا تقلق، سأبلغك فوراً بأي تحديث! 🫡`);
          log.info('Replied to /start command');
        }
      }
      saveState(state);
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  إدارة الحالة والتخزين
// ═══════════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    }
  } catch (e) {}
  return { registeredCourses: [], targetCourseId: null, targetWasOpen: false, lastTgUpdateId: 0 };
}

function saveState(state) {
  try { fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2)); } catch (e) {}
}

function sessionAgeMinutes() {
  try {
    if (fs.existsSync(CONFIG.sessionMetaFile)) {
      const m = JSON.parse(fs.readFileSync(CONFIG.sessionMetaFile, 'utf8'));
      return m.savedAt ? (Date.now() - m.savedAt) / 60000 : Infinity;
    }
  } catch (e) {}
  return Infinity;
}

function cleanupSession() {
  try { if (fs.existsSync(CONFIG.sessionFile)) fs.unlinkSync(CONFIG.sessionFile); } catch (e) {}
}

async function saveSession(ctx) {
  try {
    await ctx.storageState({ path: CONFIG.sessionFile });
    fs.writeFileSync(CONFIG.sessionMetaFile, JSON.stringify({ savedAt: Date.now() }));
    log.info('Cookies saved');
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  المتصفح وتسجيل الدخول
// ═══════════════════════════════════════════════════════════════════════════
async function createBrowser() {
  return await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function createPage(browser, useCookies = true) {
  const opts = { viewport: { width: 1280, height: 720 }, timezoneId: CONFIG.timezone };
  let cookiesLoaded = false;
  if (useCookies && fs.existsSync(CONFIG.sessionFile)) {
    opts.storageState = CONFIG.sessionFile;
    cookiesLoaded = true;
  }
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  await page.route('**/*', (r) => ['image', 'font', 'media', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue());
  return { context, page, cookiesLoaded };
}

async function loginToDulms(page) {
  log.info('Logging in...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[type="text"]', CONFIG.username);
  await page.fill('input[type="password"]', CONFIG.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click('input[type="submit"], button[type="submit"]'),
  ]);
  if (page.url().includes('/Login.aspx')) throw new Error('Login failed');
  log.ok('Logged in successfully');
}

// ═══════════════════════════════════════════════════════════════════════════
//  العمليات: فحص التسجيل وفحص الكورس المستهدف
// ═══════════════════════════════════════════════════════════════════════════
async function fetchAllCourses(page) {
  await page.goto(CONFIG.coursesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  try { await page.waitForSelector('article.course-item', { timeout: 15000 }); } catch (e) { return []; }
  
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.course-item[id]')).map(el => {
      const n = el.querySelector('.course-name');
      let st = 'never';
      if (el.classList.contains('registered')) st = 'registered';
      else if (el.classList.contains('passed')) st = 'passed';
      return { id: el.id, name: n ? n.innerText.trim() : '', status: st };
    });
  });
}

async function verifyRegistrationStability(page, state) {
  const allCourses = await fetchAllCourses(page);
  if (allCourses.length === 0) return; // فشل تحميل الصفحة

  const currentReg = allCourses.filter(c => c.status === 'registered').map(c => c.name);
  
  // لو دي أول مرة، نحفظ الكورسات اللي متسجلة حالياً
  if (!state.registeredCourses || state.registeredCourses.length === 0) {
    state.registeredCourses = currentReg;
    log.ok(`Baseline registrations set: ${currentReg.length} courses`);
    return allCourses;
  }

  // مقارنة الكورسات المحفوظة باللي موجودة دلوقتي
  for (const saved of state.registeredCourses) {
    if (!currentReg.includes(saved)) {
      log.err(`COURSE DROPPED: ${saved}`);
      await sendTelegram('🚨 تنبيه أمني: تغيير في تسجيلك!', `لقد تم رصد اختفاء مادة من جدولك المسجل:\n\n❌ *${saved}*\n\nيرجى فتح النظام فوراً للتحقق مما إذا كان الدكتور قد ألغى تسجيلك!`);
    }
  }
  
  state.registeredCourses = currentReg;
  return allCourses;
}

async function checkCourse(page, id) {
  try {
    const r = await page.evaluate(async (cid) => {
      const res = await fetch('/Registered/GetCourseSchedual?CourseId=' + encodeURIComponent(cid));
      if (!res.ok) return { error: 'http' };
      const raw = (await res.text()).trim();
      if (raw === '-1' || raw.charAt(0) === '<') return { sessionDead: true };
      if (raw === '' || raw === 'null' || raw === '[]') return { empty: true };
      return { data: JSON.parse(raw) };
    }, id);

    if (r.sessionDead) return { sessionDead: true };
    if (r.empty || r.error || !Array.isArray(r.data)) return { available: false, count: 0 };

    const groups = {};
    for (const item of r.data) {
      if (item.Type !== 'Group') continue;
      const gid = item.GroupId;
      if (!groups[gid]) {
        groups[gid] = { name: item.GroupName, blocked: !!item.IsBlocked, total: parseInt(item.StudentsCount)||0, registered: parseInt(item.RegisteredCount)||0, slots: [] };
      }
      groups[gid].slots.push({ day: item.DayWeekName, time: item.Time, hall: item.ClassRoomName });
    }

    const available = Object.values(groups).filter(g => !g.blocked && (g.total - g.registered) > 0).map(g => ({
      name: g.name, open: g.total - g.registered, total: g.total, firstSlot: g.slots[0] || null
    }));

    return { available: available.length > 0, count: available.length, groups: available };
  } catch (e) { return { error: e.message }; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  الحلقة الرئيسية 24/7
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(browser) {
  let { context, page, cookiesLoaded } = await createPage(browser, true);
  if (!cookiesLoaded || sessionAgeMinutes() > CONFIG.cookieMaxAgeMin) {
    cleanupSession(); await context.close(); ({ context, page } = await createPage(browser, false));
    await loginToDulms(page); await saveSession(context);
  }

  const state = loadState();
  let lastRegCheck = 0;
  
  if (USER_CONFIG.sendStartupMessage) {
    await sendTelegram('🚀 مرحباً! البوت بدأ العمل', `أنا شغال الآن وأقوم بـ:\n\n1️⃣ فحص مادة *${USER_CONFIG.targetCourse}* كل 10 ثواني.\n2️⃣ مراجعة ثبات تسجيلك لموادك الـ 5 كل ${USER_CONFIG.checkRegIntervalMin} دقائق.\n\nأرسل /start في أي وقت للتأكد أني مستيقظ.`);
  }

  const endTime = Date.now() + CONFIG.durationMin * 60 * 1000;
  log.step(`STARTED — Target: ${USER_CONFIG.targetCourse}`);

  while (Date.now() < endTime) {
    // 1. الاستماع لتيليجرام (/start)
    await handleTelegramCommands(state);

    // 2. فحص استقرار التسجيل كل 10 دقائق
    if (Date.now() - lastRegCheck > USER_CONFIG.checkRegIntervalMin * 60 * 1000) {
      log.info('Running security check on your registered courses...');
      const allCourses = await verifyRegistrationStability(page, state);
      
      // الحصول على ID الخاص بمادة GEN 101 عشان نفحصها
      if (allCourses && !state.targetCourseId) {
        const target = allCourses.find(c => c.name.toUpperCase().includes(USER_CONFIG.targetCourse.toUpperCase()));
        if (target) state.targetCourseId = target.id;
      }
      lastRegCheck = Date.now();
      saveState(state);
    }

    // 3. فحص كورس GEN 101 كل 10 ثواني
    if (state.targetCourseId) {
      const r = await checkCourse(page, state.targetCourseId);
      
      if (r.sessionDead) {
        log.warn('Session dead, relogging...');
        cleanupSession(); await context.close(); ({ context, page } = await createPage(browser, false));
        await loginToDulms(page); await saveSession(context);
        continue;
      }

      if (r.available) {
        if (!state.targetWasOpen) {
          log.ok(`🎉 ${USER_CONFIG.targetCourse} OPEN!`);
          
          let msg = `🎉 *مادة ${USER_CONFIG.targetCourse} فتحت!*\n✅ *${r.count}* مجموعات متاحة للتسجيل\n\n`;
          r.groups.slice(0, 5).forEach((g, i) => {
            msg += `*${i + 1}. ${g.name}*   💺 ${g.open}/${g.total}\n`;
            if (g.firstSlot) msg += `   📅 ${g.firstSlot.day} | ⏰ ${g.firstSlot.time}\n`;
          });
          msg += `\n🔗 افتح النظام وسجّل فوراً!`;
          
          await sendTelegram('', msg);
          state.targetWasOpen = true;
          saveState(state);
        }
      } else {
        log.info(`${USER_CONFIG.targetCourse} — Closed`);
        state.targetWasOpen = false;
        saveState(state);
      }
    }

    await sleep(CONFIG.fetchIntervalSec * 1000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Entrypoint
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  if (!CONFIG.username || !CONFIG.password) process.exit(1);
  const browser = await createBrowser();
  try {
    await runScan(browser);
  } catch (e) {
    log.err('Fatal:', e.message);
  } finally {
    await browser.close();
  }
})();
