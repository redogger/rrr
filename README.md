# DULMS Watcher v3.0

Bot يراقب كورسات DULMS على GitHub Actions 24/7 ويبعت إشعارات فورية على Telegram عند فتح أي كورس.

## 🎯 المميزات

- ✅ **يعمل على GitHub Actions** — لابتوبك يمكن أن يكون مغلقاً
- ✅ **حفظ الجلسة** عبر `storageState` — يقلل تسجيلات الدخول
- ✅ **إعادة تسجيل دخول تلقائي** عند انتهاء الجلسة
- ✅ **فلترة الكورسات المسجلة** — لا إشعارات مزعجة
- ✅ **كشف الفتحات الجديدة فقط** — First-run = baseline صامت
- ✅ **حفظ الحالة** عبر Cache + Artifact backup
- ✅ **معالجة Rate Limits** لـ Telegram API
- ✅ **Selectors متعددة** — يتعامل مع تغييرات DULMS

## 🔐 Setup

### 1. Secrets (Settings → Secrets and variables → Actions)

| Secret | القيمة |
|---|---|
| `DULMS_USERNAME` | رقمك الجامعي (مثال: 12510419) |
| `DULMS_PASSWORD` | كلمة سر DULMS |
| `TG_TOKEN` | Telegram Bot Token |
| `TG_CHAT_ID` | Telegram Chat ID |

### 2. الحصول على Telegram Token
1. افتح `@BotFather` على Telegram
2. `/newbot` → اتبع التعليمات
3. احفظ الـ Token

### 3. الحصول على Chat ID
1. ابعت `/start` للبوت بتاعك
2. افتح: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. ابحث عن `"chat":{"id":NUMBER` — ده الـ Chat ID

## ⚙️ Environment Variables

| Variable | Default | الوصف |
|---|---|---|
| `DULMS_USERNAME` | — | رقمك الجامعي |
| `DULMS_PASSWORD` | — | كلمة السر |
| `TG_TOKEN` | — | Telegram Bot Token |
| `TG_CHAT_ID` | — | Telegram Chat ID |
| `DURATION_MIN` | `4.5` | مدة التشغيل بالدقايق |
| `CHECK_INTERVAL` | `30` | الفحص كل كام ثانية |

## 📊 التغطية

| المدة | تشغيل كل | تغطية |
|---|---|---|
| 4.5 دقيقة | 5 دقايق | ~90% |
| 9 دقايق | 10 دقايق | ~95% |

> ⚠️ **ملاحظة**: GitHub Actions cron غير موثوق 100%. يمكن أن يتأخر 5-15 دقيقة في أوقات الذروة. للحل الدقيق، استخدم n8n أو سيرفر خاص.

## 🚀 التشغيل

### تلقائي: كل 5 دقايق
### يدوي:
Actions → DULMS Watcher → Run workflow

## 🛑 إيقاف الإشعارات مؤقتاً

Actions → DULMS Watcher → `...` → Disable workflow

## 🐛 Troubleshooting

| المشكلة | الحل |
|---|---|
| `Missing DULMS_USERNAME` | أضف الـ secret |
| `Login fields not found` | DULMS غيّرت الفورم — افتح Issue |
| `Login failed` | تحقق من كلمة السر |
| `Session died` | عادي — يعيد تسجيل دخول تلقائي |
| `Rate limited` | ينتظر ويعيد المحاولة تلقائياً |

## 📁 State

الحالة تُحفظ في `.dulms-state.json`:
- Cache (7 أيام)
- Artifact backup (30 يوم)

## 🔒 الأمان

- كل الأسرار في GitHub Secrets (مشفرة)
- لا تضع كلمة السر في الكود
- استخدم `.gitignore` لملف الجلسة
