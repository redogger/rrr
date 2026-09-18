# 👁️ DULMS Watcher v4.5 — محرك المراقبة المستمرة 24/7

نظام فحص ذكي ومستمر لمراقبة فتح مقررات جامعة الدلتا (DULMS) عبر GitHub Actions بنظام التتابع المتواصل (Relay Engine).

## ⚙️ التجهيز السريع

### 1. ضبط البيانات السرية (GitHub Secrets)
توجه إلى: `Settings` ➔ `Secrets and variables` ➔ `Actions` وأضف المتغيرات الآتية:

| المتغير | الوصف |
|---|---|
| `DULMS_USERNAME` | رقمك الجامعي |
| `DULMS_PASSWORD` | كلمة سر حسابك الجامعي |
| `TG_TOKEN` | توكن بوت التيليجرام |
| `TG_CHAT_ID` | معرّف المحادثة في التيليجرام |

### 2. تفعيل صلاحيات الـ Relay للتشغيل المستمر (ضروري جداً)
لكي يستطيع السيرفر تشغيل الجلسة التالية بنفسه 24/7:
1. افتح مستودعك على GitHub.
2. اذهب إلى **Settings** ➔ **Actions** ➔ **General**.
3. انزل لأسفل حتى تصل إلى قسم **Workflow permissions**.
4. اختر: **Read and write permissions**.
5. ضع علامة صح أمام **Allow GitHub Actions to create and approve pull requests**.
6. اضغط **Save**.

### 3. إطلاق النظام
اذهب إلى تبويب **Actions** ➔ اختر **DULMS Watcher 24-7** ➔ اضغط **Run workflow**.

النظام سيعمل الآن 50 دقيقة لكل جولة ويستدعي الجولة التالية فوراً دون أي انقطاع.
