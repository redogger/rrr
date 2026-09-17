# DULMS Watcher v4.0

بوت مراقبة كورسات DULMS مع إشعارات Telegram ذكية.

## المميزات

- Cookie-first: يحتفظ بالجلسة حتى تنتهي
- Smart Dedup: لا يكرر الإشعارات
- Always-Notify: مواد معينة تُشعر دائماً (مثل ENG)
- Never-Notify: مواد معينة تُتجاهل
- Fast fetch: كل 10 ثواني
- Auto re-login: عند موت الجلسة فقط
- Baseline on first run: لا spam

## Setup

### Secrets (Settings - Secrets and variables - Actions)

| Secret | Value |
|---|---|
| DULMS_USERNAME | رقمك الجامعي |
| DULMS_PASSWORD | كلمة السر |
| TG_TOKEN | Telegram Bot Token |
| TG_CHAT_ID | Telegram Chat ID |

### التعديل على قائمة الإشعارات

افتح watch.js وعدّل:

```javascript
const USER_CONFIG = {
  alwaysNotify: ['ENG', 'ENGLISH'],
  neverNotify: [],
  alreadyNotified: [],
};
