const form = document.getElementById("login-form");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("login-button");
  const error = document.getElementById("login-error");
  button.disabled = true;
  button.textContent = "正在登录…";
  error.textContent = "";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("password").value }),
    });
    if (!response.ok) {
      error.textContent = response.status === 429 ? "尝试次数过多，请在 15 分钟后重试。" : "密码不正确，请重新输入。";
      return;
    }
    location.replace("/");
  } catch {
    error.textContent = "暂时无法连接后台，请稍后重试。";
  } finally {
    button.disabled = false;
    button.textContent = "进入后台 →";
  }
});
