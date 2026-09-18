# 🛡️ DULMS Watcher v10.4 — Personal Guard Edition

بوت مراقبة لمادة GEN 101 (English Language 2) على DULMS.

## 🎯 3 مهام أساسية

1. **Early Detection** — يراقب ظهور GEN 101 كل 10 ثواني، ويبعت إشعار + صوت 🔔 فور ظهورها.
2. **Sniper** — بعد ظهور المادة، يراقب مجموعاتها كل 10 ثواني ويبعت إشعار لما أي مجموعة فيها مقاعد فاضية.
3. **Security Guard** — يراقب المواد المسجلة كل 10 دقائق وينبهك لو أي مادة اتشالت.

## 🆕 v10.4 — ما الجديد

- ✅ حفظ الحالة **قبل** أي عملية شبكة → لن تفقد `state` حتى لو فشل تسجيل الدخول.
- ✅ إشعار تيليجرام فوري عند أي crash مع نص الخطأ.
- ✅ **Auto-resume**: لو البوت كان Paused من run سابق، يُلغى تلقائياً.
- ✅ **Multi-selector login**: يجرّب 4 selectors مختلفة لحقول الدخول.
- ✅ **تصنيف ذكي** لسبب فشل الدخول: `captcha_required` / `invalid_credentials` / `account_locked` / `site_maintenance`.
- ✅ **4 محاولات** دخول مع backoff متزايد.
- ✅ **Dump تلقائي** للحالة والـ audit في GitHub Actions عند أي فشل.

## ⚙️ بدء التشغيل

1. أضف الأسرار الأربعة في `Settings → Secrets and variables → Actions`:
   - `DULMS_USERNAME`
   - `DULMS_PASSWORD`
   - `TG_TOKEN`
   - `TG_CHAT_ID`
2. فعّل `Read and write permissions` من Workflow permissions.
3. تبويب **Actions** → **Run workflow**.

## 🔍 تشخيص فشل الدخول

بعد أي run فاشل، افتح:
- `Actions → آخر run → Dump state on failure` — سترى:
  - `.dulms-state.json` مع حقل `lastError.phase = "login"` أو `"fatal"`
  - `.dulms-audit.log` مع حدث `login_failed`
- أو حمّل الـ artifact `dulms-state-v104` من نفس الـ run.

## ⌨️ الأوامر

`/start` `/status` `/early` `/baseline` `/find` `/diag` `/groups` `/open`
`/info` `/target` `/watch` `/unwatch` `/reset` `/audit` `/pause` `/resume` `/help`
