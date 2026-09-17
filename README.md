# DULMS Watcher v4.0

بوت مراقبة كورسات DULMS مع إشعارات Telegram ذكية.

## المميزات

- **Cookie-first**: يحتفظ بالجلسة حتى تنتهي (من `storageState`)
- **Smart Dedup**: لا يكرر الإشعارات لنفس الكورس
- **Always-Notify**: مواد معينة تُشعر دائماً (مثل ENG)
- **Never-Notify**: مواد معينة تُتجاهل
- **Fast fetch**: كل 10 ثواني
- **Auto re-login**: عند موت الجلسة فقط
- **Baseline on first run**: لا spam
- **Rate limiting**: يتعامل مع 429 من Telegram تلقائياً
- **Persistent state**: في GitHub cache + artifact backup

## Setup

### 1. Secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `DULMS_USERNAME` | رقمك الجامعي |
| `DULMS_PASSWORD` | كلمة السر |
| `TG_TOKEN` | Telegram Bot Token |
| `TG_CHAT_ID` | Telegram Chat ID |

### 2. التعديل على قائمة الإشعارات

افتح `watch.js` وعدّل:

```javascript
const USER_CONFIG = {
  sendBaselineMessage: false,   // لا ترسل رسالة "بدأ المراقبة"
  alwaysNotify: ['ENG', 'ENGLISH'],
  neverNotify: [],
  alreadyNotified: [],
};
