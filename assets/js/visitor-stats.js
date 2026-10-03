(() => {
  const setting = document.querySelector('meta[name="self-hosted-analytics"]');
  const excluded = "wei-stats-excluded";
  try {
    if (location.hash === "#stats-exclude" || location.hash === "#stats-include") {
      localStorage.setItem(excluded, location.hash === "#stats-exclude" ? "yes" : "no");
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (localStorage.getItem(excluded) === "yes") return;
  } catch {
    // Storage may be disabled; the website still works.
  }
  if (!setting || navigator.doNotTrack === "1" || navigator.globalPrivacyControl) return;
  let endpoint;
  try {
    const address = new URL(setting.content);
    if (address.protocol !== "https:") return;
    endpoint = new URL("/api/collect", address).href;
  } catch {
    return;
  }

  function send(kind, path) {
    let referrer = "";
    try {
      referrer = document.referrer ? new URL(document.referrer).hostname : "";
    } catch {
      /* No source information. */
    }
    const data = JSON.stringify({ id: crypto.randomUUID(), kind, path, referrer });
    // No visitor cookies, credentials, third-party scripts, or identifying query strings.
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: data,
    }).catch(() => {});
  }
  let counted = false;
  function countPage() {
    if (counted || document.visibilityState !== "visible") return;
    counted = true;
    send("pageview", location.pathname);
  }
  countPage();
  document.addEventListener("visibilitychange", countPage);
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const address = new URL(link.href);
    if (address.origin === location.origin && address.pathname === "/assets/pdf/CV_academic.pdf") send("cv_download", address.pathname);
  });
})();
