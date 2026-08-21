/**
 * cf-console — واجهة مبسّطة لإدارة سجلات DNS وأنفاق Cloudflare Tunnel.
 *
 * الـ Worker بيعمل 3 أشياء:
 *   1. بيحمي كل شي بكلمة سر (UI_PASSWORD) عبر كوكي موقّعة.
 *   2. بيوسّط الطلبات لـ Cloudflare API بالتوكن (CLOUDFLARE_API_TOKEN) — التوكن ما بيوصل للمتصفح أبداً.
 *   3. بيجمّع العمليات المتعددة الخطوات بخطوة وحدة (مثلاً: إضافة نطاق للنفق = تعديل ingress + إنشاء سجل CNAME).
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const COOKIE_NAME = "cfc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 ساعة
const SESSION_SALT = "cf-console-session-v1";
const TUNNEL_SUFFIX = ".cfargotunnel.com";
const DEFAULT_FALLBACK = { service: "http_status:404" };

// الأصول اللي بتنخدم بدون تسجيل دخول (صفحة الدخول وستايلها — ما فيها أي معلومة حساسة)
const PUBLIC_ASSETS = new Set(["/login.html", "/styles.css", "/login.js", "/favicon.ico"]);

// كبح محاولات الدخول الفاشلة. بينمسح لما ينعاد تدوير الـ isolate — حماية إضافية مو أساسية.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------------------------------- أدوات ---------------------------------- */

const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesEqual(a, b) {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** مقارنة نصوص بزمن ثابت (عبر تجزئة الطرفين بمفتاح عشوائي لمرة واحدة). */
async function safeEqual(a, b) {
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(String(a))),
    crypto.subtle.sign("HMAC", key, encoder.encode(String(b))),
  ]);
  return bytesEqual(ha, hb);
}

/* --------------------------------- الجلسة --------------------------------- */

async function sessionKey(env) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(SESSION_SALT + "|" + (env.UI_PASSWORD || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function issueSession(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(exp));
  return exp + "." + b64url(sig);
}

async function isSessionValid(env, token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(exp));
  return await safeEqual(token.slice(dot + 1), b64url(expected));
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function cookieHeader(request, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function throttled(request) {
  const entry = loginAttempts.get(clientKey(request));
  if (!entry) return false;
  if (Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(clientKey(request));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(request) {
  const key = clientKey(request);
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

/* ------------------------------ عميل Cloudflare ----------------------------- */

async function cfApi(env, path, init = {}) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new ApiError(
      "CLOUDFLARE_API_TOKEN غير مضبوط. ضيفه من لوحة كلاودفلير: Workers & Pages → cf-console → Settings → Variables and Secrets → Add (النوع: Secret)، أو شغّل: npx wrangler secret put CLOUDFLARE_API_TOKEN",
      500,
    );
  }
  const res = await fetch(CF_API + path, {
    method: init.method || "GET",
    body: init.body,
    headers: {
      Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`رد غير متوقع من Cloudflare (HTTP ${res.status})`, 502);
  }

  if (!res.ok || data.success === false) {
    const parts = (data.errors || []).map((e) => {
      const chain = (e.error_chain || []).map((c) => c.message).filter(Boolean).join(" ← ");
      return [e.message, chain].filter(Boolean).join(" ← ") + (e.code ? ` (code ${e.code})` : "");
    });
    throw new ApiError(parts.join(" • ") || `فشل الطلب (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? 403 : 400);
  }
  return data;
}

const accountId = (env) => {
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new ApiError("CLOUDFLARE_ACCOUNT_ID غير مضبوط بـ wrangler.toml", 500);
  return env.CLOUDFLARE_ACCOUNT_ID;
};

async function listZones(env) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await cfApi(env, `/zones?per_page=50&page=${page}`);
    out.push(...(d.result || []));
    const info = d.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
  }
  return out.map((z) => ({
    id: z.id,
    name: z.name,
    status: z.status,
    paused: z.paused,
    plan: z.plan && z.plan.name,
    name_servers: z.name_servers || [],
  }));
}

async function listAllRecords(env, zoneId) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await cfApi(env, `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    out.push(...(d.result || []));
    const info = d.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
  }
  return out;
}

/* ------------------------------ منطق الأنفاق ------------------------------ */

const tunnelTarget = (tunnelId) => tunnelId + TUNNEL_SUFFIX;

/** يفصل قواعد النطاقات عن القاعدة الأخيرة (catch-all) اللي بتشترطها كلاودفلير. */
function splitIngress(ingress) {
  const rules = [];
  let fallback = null;
  for (const rule of ingress || []) {
    if (rule && rule.hostname) rules.push(rule);
    else if (rule) fallback = rule;
  }
  return { rules, fallback: fallback || { ...DEFAULT_FALLBACK } };
}

const buildIngress = (rules, fallback) => [...rules, fallback || { ...DEFAULT_FALLBACK }];

const sameRule = (rule, hostname, path) =>
  rule.hostname === hostname && (rule.path || "") === (path || "");

/** يختار النطاق (zone) الأطول اللي بينتمي إله الاسم. */
function pickZone(zones, hostname) {
  let best = null;
  for (const zone of zones) {
    if (hostname === zone.name || hostname.endsWith("." + zone.name)) {
      if (!best || zone.name.length > best.name.length) best = zone;
    }
  }
  return best;
}

async function getTunnelConfig(env, tunnelId) {
  const d = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/configurations`);
  return (d.result && d.result.config) || {};
}

async function putTunnelConfig(env, tunnelId, config) {
  return cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

/** ينشئ أو يحدّث سجل CNAME موجّه للنفق. بيرجع تحذير بدل ما يرمي خطأ إذا فشل. */
async function syncTunnelDns(env, tunnelId, hostname, zones) {
  const zone = pickZone(zones, hostname);
  if (!zone) {
    return { ok: false, warning: `ما لقيت نطاقاً بحسابك بيغطي «${hostname}» — لازم تضيف سجل CNAME يدوياً.` };
  }
  const target = tunnelTarget(tunnelId);
  const records = await listAllRecords(env, zone.id);
  const existing = records.find((r) => r.name === hostname);

  const payload = {
    type: "CNAME",
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
    comment: "cf-console: نفق " + tunnelId,
  };

  if (!existing) {
    await cfApi(env, `/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify(payload) });
    return { ok: true, action: "created", zone: zone.name };
  }
  if (existing.type === "CNAME" && existing.content === target && existing.proxied) {
    return { ok: true, action: "unchanged", zone: zone.name };
  }
  if (existing.type !== "CNAME") {
    return {
      ok: false,
      warning: `في سجل ${existing.type} موجود على «${hostname}». احذفه من تبويب DNS أولاً حتى ينشبك بالنفق.`,
    };
  }
  await cfApi(env, `/zones/${zone.id}/dns_records/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return { ok: true, action: "updated", zone: zone.name };
}

/** يحذف سجل الـ CNAME الخاص بالنفق فقط — ما بيلمس أي سجل تاني. */
async function removeTunnelDns(env, tunnelId, hostname, zones) {
  const zone = pickZone(zones, hostname);
  if (!zone) return { ok: true, action: "skipped" };
  const records = await listAllRecords(env, zone.id);
  const target = tunnelTarget(tunnelId);
  const match = records.find((r) => r.name === hostname && r.type === "CNAME" && r.content === target);
  if (!match) return { ok: true, action: "not-found" };
  await cfApi(env, `/zones/${zone.id}/dns_records/${match.id}`, { method: "DELETE" });
  return { ok: true, action: "deleted", zone: zone.name };
}

/* --------------------------------- المسارات -------------------------------- */

async function handleApi(request, env, segments) {
  const method = request.method;
  const [, ...rest] = segments; // نتجاوز "api"
  const body = ["POST", "PUT", "PATCH"].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  /* --- تسجيل الدخول والخروج --- */
  if (rest[0] === "login" && method === "POST") {
    if (!env.UI_PASSWORD) {
      return json(
        {
          error:
            "UI_PASSWORD غير مضبوطة. ضيفها من لوحة كلاودفلير: Workers & Pages → cf-console → Settings → Variables and Secrets → Add (النوع: Secret)، أو شغّل: npx wrangler secret put UI_PASSWORD",
        },
        500,
      );
    }
    if (throttled(request)) {
      return json({ error: "محاولات كتيرة. جرّب بعد 10 دقائق." }, 429);
    }
    if (await safeEqual(body.password || "", env.UI_PASSWORD)) {
      loginAttempts.delete(clientKey(request));
      const token = await issueSession(env);
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(request, token, SESSION_TTL_SECONDS) });
    }
    noteFailure(request);
    return json({ error: "كلمة السر غلط." }, 401);
  }

  // حالة الإعداد — عامة عن قصد: بتقول شو ناقص بس بدون ما تكشف أي قيمة.
  // بدونها المستخدم بيوصل لصفحة دخول ما بتشتغل وما بيعرف ليش.
  if (rest[0] === "setup-status" && method === "GET") {
    const missing = [];
    if (!env.UI_PASSWORD) missing.push("UI_PASSWORD");
    if (!env.CLOUDFLARE_API_TOKEN) missing.push("CLOUDFLARE_API_TOKEN");
    if (!env.CLOUDFLARE_ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID");
    return json({ configured: missing.length === 0, missing });
  }

  if (rest[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(request, "", 0) });
  }

  /* --- من هون وطالع: لازم جلسة صالحة --- */
  if (!(await isSessionValid(env, readCookie(request, COOKIE_NAME)))) {
    return json({ error: "الجلسة انتهت. سجّل دخول من جديد.", unauthenticated: true }, 401);
  }

  /* --- فحص صحة التوكن --- */
  if (rest[0] === "health" && method === "GET") {
    const d = await cfApi(env, "/user/tokens/verify");
    return json({ ok: true, token_status: d.result && d.result.status, account_id: accountId(env) });
  }

  /* --- النطاقات --- */
  if (rest[0] === "zones" && rest.length === 1 && method === "GET") {
    return json({ zones: await listZones(env) });
  }

  /* --- سجلات DNS --- */
  if (rest[0] === "zones" && rest[2] === "records") {
    const zoneId = rest[1];
    const recordId = rest[3];

    if (method === "GET" && !recordId) {
      const records = await listAllRecords(env, zoneId);
      return json({
        records: records.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
          proxied: !!r.proxied,
          proxiable: !!r.proxiable,
          ttl: r.ttl,
          priority: r.priority,
          comment: r.comment || "",
          locked: !!r.locked,
          tunnel: typeof r.content === "string" && r.content.endsWith(TUNNEL_SUFFIX),
        })),
      });
    }

    if (method === "POST" && !recordId) {
      const payload = buildRecordPayload(body);
      const d = await cfApi(env, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(payload) });
      return json({ ok: true, record: d.result });
    }

    if (method === "PATCH" && recordId) {
      const payload = buildRecordPayload(body);
      const d = await cfApi(env, `/zones/${zoneId}/dns_records/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return json({ ok: true, record: d.result });
    }

    if (method === "DELETE" && recordId) {
      await cfApi(env, `/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
      return json({ ok: true });
    }
  }

  /* --- الأنفاق --- */
  if (rest[0] === "tunnels") {
    const tunnelId = rest[1];
    const sub = rest[2];

    if (!tunnelId && method === "GET") {
      const d = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel?is_deleted=false&per_page=100`);
      return json({
        tunnels: (d.result || []).map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          created_at: t.created_at,
          conns_active_at: t.conns_active_at,
          remote: t.remote_config === true || t.config_src === "cloudflare",
          connections: (t.connections || []).length,
        })),
      });
    }

    if (!tunnelId && method === "POST") {
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "لازم تحدد اسماً للنفق." }, 400);
      const d = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel`, {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" }),
      });
      // نفق جديد لازمه على الأقل قاعدة catch-all حتى تشتغل واجهة الإعدادات
      await putTunnelConfig(env, d.result.id, { ingress: [{ ...DEFAULT_FALLBACK }] }).catch(() => {});
      return json({ ok: true, tunnel: { id: d.result.id, name: d.result.name } });
    }

    if (tunnelId && !sub && method === "DELETE") {
      await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
      return json({ ok: true });
    }

    if (tunnelId && sub === "token" && method === "GET") {
      const d = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/token`);
      return json({ token: d.result });
    }

    if (tunnelId && sub === "connections" && method === "GET") {
      const d = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/connections`);
      return json({ connections: d.result || [] });
    }

    if (tunnelId && sub === "hostnames") {
      const config = await getTunnelConfig(env, tunnelId);
      const { rules, fallback } = splitIngress(config.ingress);

      if (method === "GET") {
        return json({ hostnames: rules, fallback, target: tunnelTarget(tunnelId) });
      }

      const hostname = String(body.hostname || "").trim().toLowerCase().replace(/\.$/, "");
      const path = String(body.path || "").trim();

      if (method === "POST" || method === "PUT") {
        const service = String(body.service || "").trim();
        if (!hostname) return json({ error: "لازم تحدد النطاق (hostname)." }, 400);
        if (!service) return json({ error: "لازم تحدد الخدمة (service)، مثال: http://localhost:3000" }, 400);

        const rule = { hostname, service };
        if (path) rule.path = path;
        const originRequest = {};
        if (body.noTLSVerify) originRequest.noTLSVerify = true;
        if (body.httpHostHeader) originRequest.httpHostHeader = String(body.httpHostHeader).trim();
        if (Object.keys(originRequest).length) rule.originRequest = originRequest;

        const zones = await listZones(env);
        let next;
        let removedDns = null;

        if (method === "POST") {
          if (rules.some((r) => sameRule(r, hostname, path))) {
            return json({ error: `«${hostname}» مضاف مسبقاً على هالنفق.` }, 409);
          }
          next = [...rules, rule];
        } else {
          const oldHost = String(body.originalHostname || "").trim().toLowerCase();
          const oldPath = String(body.originalPath || "").trim();
          const idx = rules.findIndex((r) => sameRule(r, oldHost, oldPath));
          if (idx < 0) return json({ error: "ما لقيت القاعدة المطلوب تعديلها — حدّث الصفحة وجرّب كمان مرة." }, 404);
          next = [...rules];
          next[idx] = rule;
          if (oldHost && oldHost !== hostname) {
            removedDns = await removeTunnelDns(env, tunnelId, oldHost, zones).catch((e) => ({
              ok: false,
              warning: `تعذّر حذف سجل «${oldHost}» القديم: ${e.message}`,
            }));
          }
        }

        await putTunnelConfig(env, tunnelId, { ...config, ingress: buildIngress(next, fallback) });
        const dns = await syncTunnelDns(env, tunnelId, hostname, zones).catch((e) => ({
          ok: false,
          warning: `تم حفظ إعداد النفق، بس فشل ضبط سجل DNS: ${e.message}`,
        }));

        const warnings = [dns.warning, removedDns && removedDns.warning].filter(Boolean);
        return json({ ok: true, dns, warnings });
      }

      if (method === "DELETE") {
        const url = new URL(request.url);
        const host = String(url.searchParams.get("hostname") || "").trim().toLowerCase();
        const rulePath = String(url.searchParams.get("path") || "").trim();
        const idx = rules.findIndex((r) => sameRule(r, host, rulePath));
        if (idx < 0) return json({ error: "ما لقيت القاعدة المطلوب حذفها." }, 404);

        const next = rules.filter((_, i) => i !== idx);
        await putTunnelConfig(env, tunnelId, { ...config, ingress: buildIngress(next, fallback) });

        // نحذف سجل DNS فقط إذا لسا ما في قاعدة تانية بتستخدم نفس النطاق
        const stillUsed = next.some((r) => r.hostname === host);
        let dns = { ok: true, action: "kept" };
        if (!stillUsed) {
          const zones = await listZones(env);
          dns = await removeTunnelDns(env, tunnelId, host, zones).catch((e) => ({
            ok: false,
            warning: `انحذفت القاعدة، بس فشل حذف سجل DNS: ${e.message}`,
          }));
        }
        return json({ ok: true, dns, warnings: [dns.warning].filter(Boolean) });
      }
    }
  }

  return json({ error: "مسار غير معروف: " + method + " /" + segments.join("/") }, 404);
}

/** يبني حمولة سجل DNS ويشيل الحقول الفاضية حتى ما نبعت قيم null لكلاودفلير. */
function buildRecordPayload(body) {
  const type = String(body.type || "").toUpperCase();
  const payload = {
    type,
    name: String(body.name || "").trim(),
    content: String(body.content || "").trim(),
    ttl: Number(body.ttl) || 1,
  };
  if (body.comment !== undefined) payload.comment = String(body.comment || "");
  if (["A", "AAAA", "CNAME"].includes(type)) payload.proxied = !!body.proxied;
  if (["MX", "SRV", "URI"].includes(type)) payload.priority = Number(body.priority) || 0;
  return payload;
}

/* ------------------------------- نقطة الدخول ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    try {
      if (segments[0] === "api") {
        return await handleApi(request, env, segments);
      }

      const authed = await isSessionValid(env, readCookie(request, COOKIE_NAME));
      const asset = (path) => env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: "GET" }));

      if (authed) {
        if (url.pathname === "/login.html") return Response.redirect(url.origin + "/", 302);
        return asset(url.pathname === "/" ? "/index.html" : url.pathname);
      }
      if (PUBLIC_ASSETS.has(url.pathname)) return asset(url.pathname);

      // أي شي تاني بدون جلسة → صفحة الدخول
      const res = await asset("/login.html");
      return new Response(res.body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      return json({ error: err.message || "خطأ غير متوقع" }, status);
    }
  },
};
