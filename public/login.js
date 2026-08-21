const form = document.getElementById("loginForm");
const errorBox = document.getElementById("error");
const submitBtn = document.getElementById("submitBtn");

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
