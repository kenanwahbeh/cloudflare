/* cf-console — منطق الواجهة */

/* --------------------------------- أدوات --------------------------------- */

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.unauthenticated) {
    window.location.replace("/");
    throw new Error("انتهت الجلسة");
  }
  if (!res.ok) throw new Error(data.error || `فشل الطلب (${res.status})`);
  return data;
}

function toast(message, kind = "ok", ms = 4200) {
  const node = el("div", { class: "toast " + kind }, message);
  $("toasts").append(node);
  setTimeout(() => node.remove(), ms);
}

function showWarnings(list) {
  for (const warning of list || []) toast(warning, "warn", 9000);
}

function confirmAction(text, title = "تأكيد الحذف") {
  return new Promise((resolve) => {
    const dialog = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    const done = (value) => {
      dialog.close();
      $("confirmYes").onclick = null;
      $("confirmNo").onclick = null;
      resolve(value);
    };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
    dialog.showModal();
  });
}

async function copyText(value, label = "تم النسخ") {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    toast("تعذّر النسخ — انسخه يدوياً.", "warn");
  }
}

const relTime = (iso) => {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "الآن";
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
  return `منذ ${Math.floor(diff / 86400)} يوم`;
};

const ttlLabel = (ttl) => (ttl === 1 ? "تلقائي" : ttl >= 3600 ? `${ttl / 3600} ساعة` : `${ttl} ثانية`);

/* --------------------------------- الحالة -------------------------------- */

const state = {
  zones: [],
  zoneId: null,
  records: [],
  tunnels: [],
  tunnelId: null,
  hostnames: [],
  editingRecordId: null,
};

const currentZone = () => state.zones.find((z) => z.id === state.zoneId) || null;

/* -------------------------------- التبويبات ------------------------------- */

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.toggle("active", other === tab);
    $("view-dns").hidden = tab.dataset.view !== "dns";
    $("view-tunnels").hidden = tab.dataset.view !== "tunnels";
    if (tab.dataset.view === "tunnels" && !state.tunnels.length) loadTunnels();
  });
}

$("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  window.location.replace("/");
});

/* ================================== DNS ================================== */

async function loadZones() {
  const { zones } = await api("/api/zones");
  state.zones = zones;

  const select = $("zoneSelect");
  select.replaceChildren(
    ...zones.map((zone) => el("option", { value: zone.id }, zone.name + (zone.status === "active" ? "" : ` (${zone.status})`))),
  );

  const saved = localStorage.getItem("cfc.zone");
  state.zoneId = zones.some((z) => z.id === saved) ? saved : zones[0] && zones[0].id;
  if (state.zoneId) select.value = state.zoneId;
  if (!zones.length) toast("ما في نطاقات بهالحساب، أو التوكن ما إله صلاحية Zone:Read.", "warn", 9000);
}

async function loadRecords() {
  if (!state.zoneId) return;
  const body = $("recordsBody");
  body.replaceChildren(el("tr", {}, el("td", { colspan: "6" }, el("span", { class: "spinner" }), " جارٍ التحميل…")));
  try {
    const { records } = await api(`/api/zones/${state.zoneId}/records`);
    state.records = records;

    const types = [...new Set(records.map((r) => r.type))].sort();
    const filter = $("typeFilter");
    const previous = filter.value;
    filter.replaceChildren(el("option", { value: "" }, "الكل"), ...types.map((t) => el("option", { value: t }, t)));
    filter.value = types.includes(previous) ? previous : "";

    renderRecords();
  } catch (error) {
    body.replaceChildren();
    $("recordsEmpty").hidden = false;
    $("recordsEmpty").replaceChildren(el("strong", {}, "تعذّر تحميل السجلات"), error.message);
  }
}

function renderRecords() {
  const search = $("searchInput").value.trim().toLowerCase();
  const type = $("typeFilter").value;
  const rows = state.records.filter(
    (r) =>
      (!type || r.type === type) &&
      (!search || r.name.toLowerCase().includes(search) || String(r.content).toLowerCase().includes(search) || (r.comment || "").toLowerCase().includes(search)),
  );

  const body = $("recordsBody");
  body.replaceChildren(...rows.map(recordRow));

  const empty = $("recordsEmpty");
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.replaceChildren(
      el("strong", {}, state.records.length ? "ما في نتائج للبحث" : "ما في سجلات بهالنطاق"),
      state.records.length ? "جرّب كلمة بحث تانية أو شيل الفلتر." : "اضغط «+ سجل جديد» لتضيف أول سجل.",
    );
  }
}

function recordRow(record) {
  const proxyable = ["A", "AAAA", "CNAME"].includes(record.type);
  const toggle = el(
    "button",
    {
      class: "proxy-toggle" + (record.proxied ? " on" : ""),
      type: "button",
      disabled: !proxyable || !record.proxiable,
      title: proxyable ? "اضغط للتبديل" : "غير متاح لهذا النوع",
      onclick: () => toggleProxy(record),
    },
    record.proxied ? "☁ مفعّل" : proxyable ? "⛅ متوقف" : "—",
  );

  return el(
    "tr",
    {},
    el("td", {}, el("span", { class: "badge badge-type" }, record.type)),
    el(
      "td",
      { class: "cell-name ltr" },
      record.name,
      record.comment ? el("div", { class: "cell-comment" }, record.comment) : null,
    ),
    el(
      "td",
      { class: "cell-content ltr" },
      record.content,
      record.tunnel ? el("div", {}, el("span", { class: "badge badge-muted" }, "نفق")) : null,
    ),
    el("td", {}, toggle),
    el("td", { class: "cell-comment" }, ttlLabel(record.ttl)),
    el(
      "td",
      { class: "actions" },
      el("button", { class: "btn btn-sm", type: "button", onclick: () => editRecord(record) }, "تعديل"),
      el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => deleteRecord(record) }, "حذف"),
    ),
  );
}

async function toggleProxy(record) {
  try {
    await api(`/api/zones/${state.zoneId}/records/${record.id}`, {
      method: "PATCH",
      body: {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.proxied ? record.ttl : 1,
        proxied: !record.proxied,
        comment: record.comment,
        priority: record.priority,
      },
    });
    toast(record.proxied ? "انطفأ البروكسي." : "اشتغل البروكسي.");
    loadRecords();
  } catch (error) {
    toast(error.message, "err", 8000);
  }
}

async function deleteRecord(record) {
  const ok = await confirmAction(`رح ينحذف السجل ${record.type} على «${record.name}». ما فيك ترجع عن هالخطوة.`);
  if (!ok) return;
  try {
    await api(`/api/zones/${state.zoneId}/records/${record.id}`, { method: "DELETE" });
    toast("انحذف السجل.");
    loadRecords();
  } catch (error) {
    toast(error.message, "err", 8000);
  }
}

/* --- نموذج السجل --- */

function syncRecordForm() {
  const type = $("rType").value;
  const proxyable = ["A", "AAAA", "CNAME"].includes(type);
  $("rProxiedWrap").hidden = !proxyable;
  $("rPriorityField").hidden = !["MX", "SRV"].includes(type);

  const proxied = proxyable && $("rProxied").checked;
  $("rTtl").disabled = proxied;
  if (proxied) $("rTtl").value = "1";
  $("rTtlHint").textContent = proxied ? "لما البروكسي مفعّل، الـ TTL بيصير تلقائي إجبارياً." : "";

  const placeholders = {
    A: "192.0.2.1",
    AAAA: "2001:db8::1",
    CNAME: "example.com",
    TXT: "v=spf1 include:_spf.example.com ~all",
    MX: "mail.example.com",
    NS: "ns1.example.com",
    SRV: "10 5 443 target.example.com",
    CAA: '0 issue "letsencrypt.org"',
  };
  $("rContent").placeholder = placeholders[type] || "";

  const zone = currentZone();
  $("rNameHint").textContent = zone ? `اكتب «@» للجذر (${zone.name}) أو اسماً فرعياً مثل www` : "";
}

for (const id of ["rType", "rProxied"]) $(id).addEventListener("change", syncRecordForm);

function openRecordForm(record = null) {
  state.editingRecordId = record ? record.id : null;
  $("recordFormTitle").textContent = record ? "تعديل السجل" : "سجل جديد";
  $("recordSaveBtn").textContent = record ? "حفظ التعديل" : "إضافة";

  const zone = currentZone();
  $("rType").value = record ? record.type : "A";
  $("rName").value = record ? (record.name === (zone && zone.name) ? "@" : record.name) : "";
  $("rContent").value = record ? record.content : "";
  $("rTtl").value = record ? String(record.ttl) : "1";
  $("rComment").value = record ? record.comment || "" : "";
  $("rPriority").value = record && record.priority !== undefined ? record.priority : 10;
  $("rProxied").checked = record ? record.proxied : true;

  syncRecordForm();
  $("recordForm").hidden = false;
  $("rName").focus();
}

const editRecord = (record) => openRecordForm(record);

$("addRecordBtn").addEventListener("click", () => openRecordForm(null));
$("recordCancelBtn").addEventListener("click", () => {
  $("recordForm").hidden = true;
  state.editingRecordId = null;
});

/** يحوّل «www» أو «@» لاسم كامل ضمن النطاق. */
function fullName(input, zone) {
  const value = input.trim().replace(/\.$/, "");
  if (!zone) return value;
  if (!value || value === "@") return zone.name;
  if (value === zone.name || value.endsWith("." + zone.name)) return value;
  return value + "." + zone.name;
}

$("recordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const zone = currentZone();
  const type = $("rType").value;
  const proxied = ["A", "AAAA", "CNAME"].includes(type) && $("rProxied").checked;

  const payload = {
    type,
    name: fullName($("rName").value, zone),
    content: $("rContent").value.trim(),
    ttl: proxied ? 1 : Number($("rTtl").value),
    proxied,
    comment: $("rComment").value.trim(),
  };
  if (["MX", "SRV"].includes(type)) payload.priority = Number($("rPriority").value);

  const saveBtn = $("recordSaveBtn");
  saveBtn.disabled = true;
  try {
    if (state.editingRecordId) {
      await api(`/api/zones/${state.zoneId}/records/${state.editingRecordId}`, { method: "PATCH", body: payload });
      toast("انحفظ التعديل.");
    } else {
      await api(`/api/zones/${state.zoneId}/records`, { method: "POST", body: payload });
      toast("انضاف السجل.");
    }
    $("recordForm").hidden = true;
    state.editingRecordId = null;
    loadRecords();
  } catch (error) {
    toast(error.message, "err", 9000);
  }
  saveBtn.disabled = false;
});

$("zoneSelect").addEventListener("change", (event) => {
  state.zoneId = event.target.value;
  localStorage.setItem("cfc.zone", state.zoneId);
  $("recordForm").hidden = true;
  $("searchInput").value = "";
  loadRecords();
});
$("searchInput").addEventListener("input", renderRecords);
$("typeFilter").addEventListener("change", renderRecords);
$("refreshRecordsBtn").addEventListener("click", loadRecords);

/* ================================= الأنفاق ================================ */

const TUNNEL_STATUS = {
  healthy: { label: "شغّال", cls: "badge-ok" },
  degraded: { label: "متذبذب", cls: "badge-warn" },
  down: { label: "مفصول", cls: "badge-danger" },
  inactive: { label: "ما اشتغل بعد", cls: "badge-muted" },
};

const statusBadge = (status) => {
  const info = TUNNEL_STATUS[status] || { label: status || "—", cls: "badge-muted" };
  return el("span", { class: "badge " + info.cls }, info.label);
};

async function loadTunnels() {
  const list = $("tunnelList");
  list.replaceChildren(el("div", { class: "empty" }, el("span", { class: "spinner" })));
  try {
    const { tunnels } = await api("/api/tunnels");
    state.tunnels = tunnels;
    renderTunnelList();
    if (state.tunnelId && tunnels.some((t) => t.id === state.tunnelId)) selectTunnel(state.tunnelId);
    else if (tunnels.length) selectTunnel(tunnels[0].id);
    else $("tunnelDetail").replaceChildren(el("div", { class: "empty" }, el("strong", {}, "ما في أنفاق"), "اضغط «+ نفق جديد» لتعمل أول نفق."));
  } catch (error) {
    list.replaceChildren(el("div", { class: "empty" }, el("strong", {}, "تعذّر التحميل"), error.message));
  }
}

function renderTunnelList() {
  $("tunnelList").replaceChildren(
    ...state.tunnels.map((tunnel) =>
      el(
        "button",
        {
          class: "tunnel-item" + (tunnel.id === state.tunnelId ? " active" : ""),
          type: "button",
          onclick: () => selectTunnel(tunnel.id),
        },
        el("div", { class: "name" }, el("span", {}, tunnel.name), statusBadge(tunnel.status)),
        el("div", { class: "sub" }, `${tunnel.connections} اتصال · ${relTime(tunnel.conns_active_at)}`),
      ),
    ),
  );
  if (!state.tunnels.length) $("tunnelList").replaceChildren(el("div", { class: "empty" }, "ما في أنفاق."));
}

async function selectTunnel(tunnelId) {
  state.tunnelId = tunnelId;
  renderTunnelList();
  const tunnel = state.tunnels.find((t) => t.id === tunnelId);
  if (!tunnel) return;

  $("tunnelDetail").replaceChildren(el("div", { class: "empty" }, el("span", { class: "spinner" })));
  let hostnames = [];
  let configError = null;
  try {
    const data = await api(`/api/tunnels/${tunnelId}/hostnames`);
    hostnames = data.hostnames || [];
  } catch (error) {
    configError = error.message;
  }
  state.hostnames = hostnames;
  renderTunnelDetail(tunnel, hostnames, configError);
}

function renderTunnelDetail(tunnel, hostnames, configError) {
  const target = tunnel.id + ".cfargotunnel.com";

  const head = el(
    "div",
    { class: "detail-head" },
    el("h2", {}, tunnel.name),
    statusBadge(tunnel.status),
    el("span", { class: "grow", style: "flex:1" }),
    el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => copyText(tunnel.id, "انتسخ معرّف النفق") }, "نسخ المعرّف"),
    el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => deleteTunnel(tunnel) }, "حذف النفق"),
  );

  const hostSection = el(
    "div",
    { class: "detail-section" },
    el("h4", {}, "النطاقات العامة"),
    el("p", { class: "desc" }, "كل نطاق هون بيوصل لخدمة شغّالة على سيرفرك. الواجهة بتضبط إعداد النفق وسجل الـ DNS سوا بضغطة وحدة."),
  );

  if (configError) {
    hostSection.append(el("div", { class: "notice notice-warn" }, "تعذّر قراءة إعدادات النفق: " + configError));
  } else if (!hostnames.length) {
    hostSection.append(el("div", { class: "notice notice-info" }, "ما في نطاقات مربوطة بهالنفق بعد."));
  } else {
    for (const rule of hostnames) hostSection.append(hostRow(tunnel, rule));
  }

  hostSection.append(
    el("button", { class: "btn btn-primary btn-sm", type: "button", style: "margin-top:8px", onclick: () => openHostForm(tunnel, null) }, "+ إضافة نطاق"),
    el("div", { id: "hostFormSlot" }),
  );

  const runSection = el(
    "div",
    { class: "detail-section" },
    el("h4", {}, "تشغيل النفق على سيرفرك"),
    el("p", { class: "desc" }, "نزّل cloudflared على السيرفر وشغّل أمر التثبيت. التوكن سرّي — لا تنشره."),
    el("button", { class: "btn btn-sm", type: "button", onclick: (event) => showInstallCommand(tunnel, event.target) }, "أظهر أمر التثبيت"),
    el("div", { id: "installSlot" }),
  );

  const kv = (label, value, mono = true) =>
    el("div", { class: "kv" }, el("span", { class: "k" }, label), el("span", { class: mono ? "v" : "" }, value));

  const infoSection = el(
    "div",
    { class: "detail-section" },
    el("h4", {}, "معلومات"),
    el(
      "div",
      { class: "card", style: "padding:6px 14px" },
      kv("معرّف النفق", tunnel.id),
      kv("وجهة الـ CNAME", target),
      kv("عدد الاتصالات", String(tunnel.connections), false),
      kv("أُنشئ في", tunnel.created_at ? new Date(tunnel.created_at).toLocaleString("ar-SY-u-nu-latn") : "—", false),
    ),
  );

  $("tunnelDetail").replaceChildren(head, el("div", { class: "detail-body" }, hostSection, runSection, infoSection));
}

function hostRow(tunnel, rule) {
  return el(
    "div",
    { class: "host-row" },
    el("span", { class: "host" }, rule.hostname + (rule.path ? rule.path : "")),
    el("span", { class: "arrow" }, "←"),
    el("span", { class: "svc" }, rule.service),
    el("span", { class: "grow" }),
    el("button", { class: "btn btn-sm", type: "button", onclick: () => openHostForm(tunnel, rule) }, "تعديل"),
    el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => deleteHostname(tunnel, rule) }, "حذف"),
  );
}

/** يفصل «http://localhost:3000» لـ (البروتوكول، العنوان). */
function splitService(service) {
  const match = /^([a-z0-9+]+):\/\/(.*)$/i.exec(service || "");
  if (match) return { scheme: match[1].toLowerCase() + "://", address: match[2] };
  return { scheme: "http://", address: "" };
}

function openHostForm(tunnel, rule) {
  const zone = rule ? state.zones.find((z) => rule.hostname === z.name || rule.hostname.endsWith("." + z.name)) : null;
  const sub = rule && zone ? (rule.hostname === zone.name ? "@" : rule.hostname.slice(0, -(zone.name.length + 1))) : "";
  const parts = splitService(rule && rule.service);

  const subInput = el("input", { type: "text", class: "ltr", placeholder: "app", value: sub });
  const zoneSelect = el(
    "select",
    {},
    ...state.zones.map((z) => el("option", { value: z.id, selected: zone && z.id === zone.id }, z.name)),
  );
  const schemeSelect = el(
    "select",
    { class: "ltr" },
    ...["http://", "https://", "tcp://", "ssh://", "rdp://", "unix://"].map((s) =>
      el("option", { value: s, selected: s === parts.scheme }, s),
    ),
  );
  const addressInput = el("input", { type: "text", class: "ltr", placeholder: "localhost:3000", value: parts.address, required: true });
  const pathInput = el("input", { type: "text", class: "ltr", placeholder: "/admin", value: (rule && rule.path) || "" });
  const noTlsInput = el("input", { type: "checkbox", checked: !!(rule && rule.originRequest && rule.originRequest.noTLSVerify) });

  const form = el(
    "form",
    { class: "card panel", style: "margin-top:12px" },
    el("h3", {}, rule ? "تعديل النطاق" : "إضافة نطاق للنفق"),
    el(
      "div",
      { class: "form-grid" },
      el("div", { class: "field" }, el("label", {}, "الاسم الفرعي"), subInput, el("span", { class: "hint" }, "اكتب «@» لجذر النطاق")),
      el("div", { class: "field" }, el("label", {}, "النطاق"), zoneSelect),
      el("div", { class: "field" }, el("label", {}, "البروتوكول"), schemeSelect),
      el(
        "div",
        { class: "field" },
        el("label", {}, "عنوان الخدمة على سيرفرك"),
        addressInput,
        el("span", { class: "hint" }, "مثال: localhost:3000 أو 192.168.1.50:8080"),
      ),
      el("div", { class: "field" }, el("label", {}, "المسار (اختياري)"), pathInput, el("span", { class: "hint" }, "اتركه فاضي ليشمل كل المسارات")),
    ),
    el("label", { class: "checkline" }, noTlsInput, el("span", {}, "تجاهل التحقق من شهادة SSL على السيرفر (لما تكون الشهادة self-signed)")),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, rule ? "حفظ التعديل" : "إضافة"),
      el("button", { class: "btn", type: "button", onclick: () => form.remove() }, "إلغاء"),
    ),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedZone = state.zones.find((z) => z.id === zoneSelect.value);
    const hostname = fullName(subInput.value, selectedZone);
    const address = addressInput.value.trim();
    if (!address) return toast("اكتب عنوان الخدمة.", "err");

    const payload = {
      hostname,
      service: schemeSelect.value + address,
      path: pathInput.value.trim(),
      noTLSVerify: noTlsInput.checked,
    };
    if (rule) {
      payload.originalHostname = rule.hostname;
      payload.originalPath = rule.path || "";
    }

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const result = await api(`/api/tunnels/${tunnel.id}/hostnames`, { method: rule ? "PUT" : "POST", body: payload });
      toast(rule ? "انحفظ التعديل." : `انضاف «${hostname}» وانعمل سجل الـ DNS.`);
      showWarnings(result.warnings);
      form.remove();
      selectTunnel(tunnel.id);
      if (state.zoneId === zoneSelect.value) loadRecords();
    } catch (error) {
      toast(error.message, "err", 9000);
      submitBtn.disabled = false;
    }
  });

  const slot = $("hostFormSlot");
  slot.replaceChildren(form);
  subInput.focus();
}

async function deleteHostname(tunnel, rule) {
  const ok = await confirmAction(`رح ينحذف «${rule.hostname}» من النفق، ومعه سجل الـ CNAME التابع إله.`);
  if (!ok) return;
  try {
    const query = new URLSearchParams({ hostname: rule.hostname, path: rule.path || "" });
    const result = await api(`/api/tunnels/${tunnel.id}/hostnames?${query}`, { method: "DELETE" });
    toast("انحذف النطاق.");
    showWarnings(result.warnings);
    selectTunnel(tunnel.id);
    loadRecords();
  } catch (error) {
    toast(error.message, "err", 9000);
  }
}

async function showInstallCommand(tunnel, button) {
  button.disabled = true;
  try {
    const { token } = await api(`/api/tunnels/${tunnel.id}/token`);
    const command = `cloudflared service install ${token}`;
    $("installSlot").replaceChildren(
      el("div", { class: "notice notice-warn", style: "margin-top:12px" }, "هالتوكن بيعطي صلاحية تشغيل النفق — لا تشاركه مع حدا."),
      el("div", { class: "codeblock" }, command),
      el("button", { class: "btn btn-sm", type: "button", style: "margin-top:8px", onclick: () => copyText(command, "انتسخ الأمر") }, "نسخ الأمر"),
    );
  } catch (error) {
    toast(error.message, "err", 9000);
  }
  button.disabled = false;
}

async function deleteTunnel(tunnel) {
  const ok = await confirmAction(
    `رح ينحذف النفق «${tunnel.name}» نهائياً. سجلات الـ DNS التابعة إله ما بتنحذف تلقائياً — احذفها من تبويب DNS.`,
    "حذف النفق",
  );
  if (!ok) return;
  try {
    await api(`/api/tunnels/${tunnel.id}`, { method: "DELETE" });
    toast("انحذف النفق.");
    state.tunnelId = null;
    loadTunnels();
  } catch (error) {
    toast(error.message, "err", 9000);
  }
}

$("addTunnelBtn").addEventListener("click", () => {
  $("tunnelForm").hidden = false;
  $("tName").focus();
});
$("tunnelCancelBtn").addEventListener("click", () => ($("tunnelForm").hidden = true));

$("tunnelForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const { tunnel } = await api("/api/tunnels", { method: "POST", body: { name: $("tName").value.trim() } });
    toast("انعمل النفق. ضيف إله نطاقاً وشغّل أمر التثبيت على سيرفرك.");
    $("tunnelForm").hidden = true;
    $("tName").value = "";
    state.tunnelId = tunnel.id;
    loadTunnels();
  } catch (error) {
    toast(error.message, "err", 9000);
  }
  button.disabled = false;
});

$("refreshTunnelsBtn").addEventListener("click", loadTunnels);

/* ================================= الإقلاع ================================ */

(async function boot() {
  try {
    const health = await api("/api/health");
    $("accountMeta").textContent = `الحساب ${health.account_id.slice(0, 8)}… · التوكن ${health.token_status === "active" ? "فعّال" : health.token_status}`;
  } catch (error) {
    toast("مشكلة بالتوكن: " + error.message, "err", 12000);
  }

  try {
    await loadZones();
    syncRecordForm();
    await loadRecords();
  } catch (error) {
    toast(error.message, "err", 12000);
  }
})();
