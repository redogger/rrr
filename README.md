# 🛡️ DULMS Watcher v10.2 — Personal Guard Edition

بوت مخصص لثلاث وظائف دون إهدار موارد:

1. **قناص الكورسات (GEN 101):** فحص دقيق كل 10 ثواني لمادة GEN 101 فقط.
2. **الحارس الشخصي للتسجيل:** حفظ قائمة الكورسات المسجلة ومراجعتها كل 10 دقائق (تحذير فوري عند إلغاء مادة).
3. **التحقق الحي (Telegram Ping):** أرسل `/start` لبوت التيليجرام في أي وقت ليرد بأنه يستيقظ ويعمل.

## 🧩 البنية

- `watch.js` — نقطة الدخول + الحلقة الرئيسية.
- `lib/core.js` — الإعدادات، الـ logger، الأدوات، الحالة، الجلسة، الـ shutdown.
- `lib/telegram.js` — كل ما يخص Telegram (send + commands + callbacks).
- `lib/browser.js` — تشغيل Playwright، اعتراض AJAX، عميل API، ووحدات الفحص.

## ⚙️ بدء التشغيل
1. أضف الـ Secrets الأربعة في إعدادات المستودع:
   - `DULMS_USERNAME`
   - `DULMS_PASSWORD`
   - `TG_TOKEN`
   - `TG_CHAT_ID`
2. فعّل `Read and write permissions` من Workflow permissions.
3. تبويب **Actions** → **Run workflow**.

## ⌨️ أوامر البوت الأساسية
`/start` `/status` `/early` `/baseline` `/find` `/diag` `/groups` `/open`
`/info` `/target` `/watch` `/unwatch` `/reset` `/audit` `/pause` `/resume` `/help`
