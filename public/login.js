const form = document.getElementById("loginForm");
const errorBox = document.getElementById("error");
const submitBtn = document.getElementById("submitBtn");

// لو الأسرار لسا ما انضافت (شائع بعد النشر من Git)، وضّح الخطوة الناقصة فوراً
// بدل ما يجرّب المستخدم كلمة سر ما إلها وجود.
(async function checkSetup() {
  try {
    const res = await fetch("/api/setup-status");
    const data = await res.json();
    if (data.configured) return;

    submitBtn.disabled = true;
    errorBox.hidden = false;
    errorBox.innerHTML = "";
    errorBox.append(
      Object.assign(document.createElement("strong"), { textContent: "اللوحة لسا ما انضبطت" }),
      Object.assign(document.createElement("p"), {
        style: "margin:8px 0 0;font-weight:600",
        textContent: "ناقص: " + data.missing.join("، "),
      }),
      Object.assign(document.createElement("p"), {
        style: "margin:8px 0 0;font-weight:400;line-height:1.7",
        textContent:
          "ضيفها من لوحة كلاودفلير: Workers & Pages ← اختر الـ Worker ← Settings ← Variables and Secrets ← Add، والنوع Secret. بعدها اعمل تحديث للصفحة.",
      }),
    );
  } catch {
    /* ما بيمنع تسجيل الدخول إذا فشل الفحص */
  }
})();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "جارٍ التحقق…";

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("password").value }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
      window.location.replace("/");
      return;
    }
    errorBox.textContent = data.error || "تعذّر تسجيل الدخول.";
    errorBox.hidden = false;
  } catch {
    errorBox.textContent = "تعذّر الاتصال بالخادم. تحقق من اتصالك.";
    errorBox.hidden = false;
  }

  submitBtn.disabled = false;
  submitBtn.textContent = "دخول";
  document.getElementById("password").select();
});
