# DULMS Watcher

Bot يراقب كورسات DULMS 24/7 ويبعت إشعارات على Telegram عند فتح أي كورس.

## Setup

1. **Secrets** (Settings → Secrets and variables → Actions):
   - `DULMS_USERNAME` — رقمك الجامعي
   - `DULMS_PASSWORD` — كلمة السر
   - `TG_TOKEN` — Telegram Bot Token
   - `TG_CHAT_ID` — Telegram Chat ID

2. **تشغيل يدوي**:
   - Actions → DULMS Watcher → Run workflow

3. **تلقائي**: كل 5 دقايق

## Environment Variables

| Variable | Default | الوصف |
|---|---|---|
| `DULMS_USERNAME` | — | رقمك الجامعي |
| `DULMS_PASSWORD` | — | كلمة السر |
| `TG_TOKEN` | — | Telegram Bot Token |
| `TG_CHAT_ID` | — | Telegram Chat ID |
| `DURATION_MIN` | `4.5` | مدة التشغيل بالدقايق |
| `CHECK_INTERVAL` | `30` | الفحص كل كام ثانية |

## Behavior

- ✅ يشتغل 4.5 دقيقة × كل 5 دقايق (متصل ~90%)
- ✅ يفلتر الكورسات المسجلة
- ✅ يحفظ الحالة في GitHub cache
- ✅ يبعت إشعار فقط عند فتح جديد
- ✅ إعادة تسجيل دخول تلقائي عند انتهاء الجلسة

## Manual Run

```bash
DULMS_USERNAME=xxx DULMS_PASSWORD=yyy TG_TOKEN=zzz TG_CHAT_ID=123 node watch.js
