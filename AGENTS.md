# AGENTS.md — لوحة Cloudflare

## المشروع
واجهة عربية (RTL) بتشتغل كـ Cloudflare Worker لإدارة سجلات DNS وأنفاق Cloudflare Tunnel.
تفاصيل التشغيل والنشر بـ `README.md`.

```
src/index.js      الـ Worker: مصادقة + توسيط Cloudflare API + العمليات المركّبة
public/index.html الواجهة الرئيسية (تبويبان: DNS، الأنفاق)
public/app.js     منطق الواجهة — بدون أي مكتبات خارجية أو خطوة بناء
public/login.html صفحة تسجيل الدخول
public/styles.css ستايل موحّد (فاتح/غامق حسب إعداد النظام)
wrangler.toml     إعداد النشر — static assets مع run_worker_first = true
```

## المتغيرات
| الاسم | النوع | الوصف |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | توكن API (مو Global API Key) |
| `UI_PASSWORD` | secret | كلمة سر الدخول للواجهة |
| `CLOUDFLARE_ACCOUNT_ID` | var بـ wrangler.toml | `50d79fcbc90bf84876653d770bc1c0ec` (kinan) |

- **Auth header**: `Authorization: Bearer $CLOUDFLARE_API_TOKEN`
- **API base**: `https://api.cloudflare.com/client/v4`
- صلاحيات التوكن المطلوبة: `Account → Cloudflare Tunnel: Edit`، `Zone → DNS: Edit`، `Zone → Zone: Read`

## النشر
- المشروع Worker مع static assets (**مو Pages**). النشر من Git عبر Workers Builds.
- اسم الـ Worker بلوحة كلاودفلير لازم يطابق `name` بـ `wrangler.toml` (`cf-console`) وإلا البناء بيفشل.
- كلاودفلير بتبني من الفرع الافتراضي للريبو — أو من الفرع المحدد بـ Settings ← Build ← Branch control.
- الأسرار ما بتنتقل من Git. `/api/setup-status` نقطة عامة (بدون مصادقة) بترجّع أسماء
  المتغيرات الناقصة بس — بدون أي قيمة — وصفحة الدخول بتعرضها كتعليمات إعداد.
- `package.json` فيه `cloudflare.bindings` بأوصاف الأسرار، و `.dev.vars.example` فيه أسماءها.
  الاثنين بيقراهن زر «Deploy to Cloudflare» ليطلب القيم وقت الإعداد.

## نقاط API المستخدمة
```
GET    /zones
GET    /zones/{zone}/dns_records            (بترقيم صفحات، 100 بالصفحة)
POST   /zones/{zone}/dns_records
PATCH  /zones/{zone}/dns_records/{id}
DELETE /zones/{zone}/dns_records/{id}
GET    /accounts/{acct}/cfd_tunnel
POST   /accounts/{acct}/cfd_tunnel          ({ name, config_src: "cloudflare" })
DELETE /accounts/{acct}/cfd_tunnel/{id}
GET    /accounts/{acct}/cfd_tunnel/{id}/configurations
PUT    /accounts/{acct}/cfd_tunnel/{id}/configurations   ({ config: { ingress: [...] } })
GET    /accounts/{acct}/cfd_tunnel/{id}/token
```

## قواعد مهمة بالكود
- **قاعدة الـ catch-all**: مصفوفة `ingress` لازم تنتهي دايماً بقاعدة بدون `hostname`
  (افتراضياً `{ service: "http_status:404" }`). `splitIngress()` و `buildIngress()` بيضمنوا هالشي.
- **سجل النفق**: `CNAME → {tunnel_id}.cfargotunnel.com` مع `proxied: true` إجبارياً.
- **حذف آمن**: `removeTunnelDns()` بتحذف السجل فقط إذا كان CNAME وبيأشر على نفس النفق.
- **اختيار الـ zone**: `pickZone()` بتاخد النطاق الأطول المطابق (حتى `api.sub.example.com`
  يروح لـ `sub.example.com` مو `example.com`).
- **التوكن ما بيوصل للمتصفح**: كل نداءات الـ API بتمرق من الـ Worker.

## ملاحظات على Cloudflare (الحساب المجاني)
- WAF القديم متوقف ← استخدم Managed Rulesets
- Minify ما بيشتغل على الخطة المجانية
- حذف zone بدّه Global API Key (مو API Token)
- `Access session_duration`: 24 ساعة كحد أقصى على المجاني
- قاعدة الإيميل الشاملة (catch-all) ما بتنعدّل عبر API — من اللوحة بس
- DNSSEC بيضل `pending` لحدا ما تنتشر الـ nameservers
