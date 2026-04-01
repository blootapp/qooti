/**
 * Qooti License Admin - tabbed panel, optimized reads, one query per action
 */

const CONFIG_KEY = "qooti_admin_config";

function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { baseUrl: "", secret: "" };
    const c = JSON.parse(raw);
    return {
      baseUrl: (c.baseUrl || "").trim().replace(/\/+$/, ""),
      secret: c.secret || "",
    };
  } catch (_) {
    return { baseUrl: "", secret: "" };
  }
}

function saveConfig(baseUrl, secret) {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      baseUrl: (baseUrl || "").trim().replace(/\/+$/, ""),
      secret: secret || "",
    })
  );
}

function setStatus(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "status " + (type === "ok" ? "status--ok" : type === "err" ? "status--err" : "status--muted");
}

function adminFetch(path, options = {}) {
  const { baseUrl, secret } = getConfig();
  if (!baseUrl) return Promise.reject(new Error("Set Worker base URL in Settings."));
  if (!secret) return Promise.reject(new Error("Set Admin secret in Settings."));
  const url = baseUrl + path;
  const headers = { "Content-Type": "application/json", "X-Admin-Secret": secret, ...options.headers };
  return fetch(url, { ...options, headers });
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function formatExpires(ts) {
  if (!ts) return "—";
  const far = 253402300799;
  if (ts >= far - 86400) return "Never";
  return formatTimestamp(ts);
}

// --- Tab switching ---
const panels = {
  licenses: "panelLicenses",
  create: "panelCreate",
  notifications: "panelNotifications",
  details: "panelDetails",
  logs: "panelLogs",
  settings: "panelSettings",
};
let currentTab = "licenses";
let detailsLicenseKey = null;

document.querySelectorAll(".admin__tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (!tab || tab === "details") return;
    switchTab(tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".admin__tab").forEach((b) => b.classList.remove("is-active"));
  document.querySelectorAll(".admin__panel").forEach((p) => p.classList.remove("is-active"));
  const btn = document.querySelector(`.admin__tab[data-tab="${tab}"]`);
  const panel = document.getElementById(panels[tab]);
  if (btn) btn.classList.add("is-active");
  if (panel) panel.classList.add("is-active");
  if (tab === "details" && detailsLicenseKey) loadDetails(detailsLicenseKey);
  if (tab === "notifications") loadNotificationsSent();
}

function showDetails(key) {
  detailsLicenseKey = key;
  const tabDetails = document.getElementById("tabDetails");
  if (tabDetails) {
    tabDetails.style.display = "";
    tabDetails.setAttribute("aria-hidden", "false");
    tabDetails.classList.remove("hidden");
  }
  switchTab("details");
}

// --- Licenses list ---
let licensesPage = 1;
const licensesLimit = 20;

function loadLicenses() {
  const licenseKey = document.getElementById("licensesLicenseKey")?.value?.trim() || "";
  const status = document.getElementById("licensesStatus")?.value || "";
  const plan = document.getElementById("licensesPlan")?.value || "";
  const expirationWindow = document.getElementById("licensesExpirationWindow")?.value || "";
  const deviceLimitState = document.getElementById("licensesDeviceLimitState")?.value || "";
  const params = new URLSearchParams({ page: licensesPage, limit: licensesLimit });
  if (licenseKey) params.set("license_key", licenseKey);
  if (status) params.set("status", status);
  if (plan) params.set("plan_type", plan);
  if (expirationWindow) params.set("expiration_window", expirationWindow);
  if (deviceLimitState) params.set("device_limit_state", deviceLimitState);

  setStatus("licensesStatusMsg", "Loading…", "muted");
  adminFetch("/admin/licenses?" + params)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      renderLicensesTable(data);
      setStatus("licensesStatusMsg", data.too_many ? "Too many results. Refine filters." : "", "muted");
    })
    .catch((e) => setStatus("licensesStatusMsg", e.message || "Failed", "err"));
}

function renderLicensesTable(data) {
  const tbody = document.getElementById("licensesTableBody");
  if (!tbody) return;
  const licenses = data.licenses || [];
  const tooMany = !!data.too_many;

  if (licenses.length === 0) {
    const msg = tooMany
      ? "Too many results. Refine filters."
      : "No licenses found. Use Create License to add one, or adjust filters.";
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(msg)}</td></tr>`;
  } else {
    tbody.innerHTML = licenses.map((l) => {
      const statusClass = l.status === "valid" ? "badge--ok" : l.status === "expired" ? "badge--warn" : "badge--err";
      const keyDisplay = l.license_key_masked ?? l.license_key ?? "—";
      return `<tr>
        <td><code>${escapeHtml(keyDisplay)}</code></td>
        <td>${escapeHtml(l.plan_type)}</td>
        <td>${formatExpires(l.expires_at)}</td>
        <td>${l.device_count ?? 0} / ${l.device_limit ?? 3}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(l.status)}</span></td>
        <td>
          <button type="button" class="btn btn--small btn--secondary" data-action="view" data-key="${escapeAttr(l.license_key)}">View</button>
          <button type="button" class="btn btn--small btn--secondary" data-action="edit" data-key="${escapeAttr(l.license_key)}">Edit</button>
          ${l.status !== "revoked" ? `<button type="button" class="btn btn--small btn--secondary" data-action="reset" data-key="${escapeAttr(l.license_key)}">Reset devices</button>` : ""}
          ${l.status !== "revoked" ? `<button type="button" class="btn btn--small btn--danger" data-action="revoke" data-key="${escapeAttr(l.license_key)}">Revoke</button>` : ""}
          ${l.status === "revoked" ? `<button type="button" class="btn btn--small btn--danger" data-action="delete" data-key="${escapeAttr(l.license_key)}">Delete</button>` : ""}
        </td>
      </tr>`;
    }).join("");
  }

  if (licenses.length > 0) {
    tbody.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const key = btn.dataset.key;
        if (action === "view") showDetails(key);
        if (action === "edit") openEditModal(key);
        if (action === "reset") resetDevicesFromList(key);
        if (action === "revoke") revokeLicense(key);
        if (action === "delete") deleteLicense(key);
      });
    });
  }

  const total = data.total ?? 0;
  const page = data.page ?? 1;
  const limit = data.limit ?? 20;
  document.getElementById("licensesPaginationInfo").textContent = total > 0 ? `${total} total · Page ${page}` : "";
  document.getElementById("licensesPrev").disabled = page <= 1;
  document.getElementById("licensesNext").disabled = page * limit >= total;
}

document.getElementById("licensesFilterForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  licensesPage = 1;
  loadLicenses();
});
document.getElementById("licensesPrev")?.addEventListener("click", () => { licensesPage--; loadLicenses(); });
document.getElementById("licensesNext")?.addEventListener("click", () => { licensesPage++; loadLicenses(); });

function resetDevicesFromList(key) {
  if (!confirm("Reset all devices for this license? Users will need to re-activate.")) return;
  adminFetch("/admin/licenses/" + encodeURIComponent(key) + "/devices/reset", { method: "POST" })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok && data.error) throw new Error(data.error);
      return data;
    })
    .then(() => {
      loadLicenses();
      if (detailsLicenseKey === key) loadDetails(key);
      setStatus("licensesStatusMsg", "Devices reset.", "ok");
    })
    .catch((e) => setStatus("licensesStatusMsg", e.message || "Failed", "err"));
}

// --- Create License ---
document.getElementById("createPlanType")?.addEventListener("change", () => {
  const row = document.getElementById("createDurationRow");
  row.style.display = document.getElementById("createPlanType")?.value === "yearly" ? "" : "none";
});

document.getElementById("formCreate")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const planType = document.getElementById("createPlanType")?.value || "lifetime";
  const durationYears = parseInt(document.getElementById("createDurationYears")?.value || "1", 10);
  const deviceLimit = parseInt(document.getElementById("createDeviceLimit")?.value || "3", 10);
  const btn = document.getElementById("btnCreate");
  btn.disabled = true;
  setStatus("createStatus", "Generating…", "muted");
  document.getElementById("createResult")?.classList.add("hidden");
  try {
    const res = await adminFetch("/admin/licenses", {
      method: "POST",
      body: JSON.stringify({ planType, durationYears, deviceLimit }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");
    document.getElementById("createResultKey").textContent = data.license_key || "";
    document.getElementById("createResult")?.classList.remove("hidden");
    setStatus("createStatus", "License created. Use Search to see it in the list.", "ok");
  } catch (err) {
    setStatus("createStatus", err.message || "Failed", "err");
  } finally {
    btn.disabled = false;
  }
});

// --- Create Notification ---
document.getElementById("formNotification")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("notifyTitle")?.value?.trim() || "";
  const body = document.getElementById("notifyBody")?.value?.trim() || "";
  const youtube_url = document.getElementById("notifyYoutube")?.value?.trim() || "";
  const button_text = document.getElementById("notifyButtonText")?.value?.trim() || "";
  const button_link = document.getElementById("notifyButtonLink")?.value?.trim() || "";
  const is_active = (document.getElementById("notifyActive")?.value || "true") === "true";
  if (!body) {
    setStatus("notifyStatus", "Body is required.", "err");
    return;
  }
  const btn = document.getElementById("btnSendNotification");
  if (btn) btn.disabled = true;
  setStatus("notifyStatus", "Sending…", "muted");
  try {
    const res = await adminFetch("/admin/notifications", {
      method: "POST",
      body: JSON.stringify({
        title: title || null,
        body,
        youtube_url: youtube_url || null,
        button_text: button_text || null,
        button_link: button_link || null,
        is_active,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");
    document.getElementById("notifyTitle").value = "";
    document.getElementById("notifyBody").value = "";
    document.getElementById("notifyYoutube").value = "";
    document.getElementById("notifyButtonText").value = "";
    document.getElementById("notifyButtonLink").value = "";
    document.getElementById("notifyActive").value = "true";
    setStatus("notifyStatus", "Notification sent.", "ok");
    loadNotificationsSent();
  } catch (err) {
    setStatus("notifyStatus", err.message || "Failed", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

// --- Sent notifications (server list + delete) ---
function truncateText(s, max) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function loadNotificationsSent() {
  setStatus("notificationsSentStatus", "Loading…", "muted");
  adminFetch("/admin/notifications?include_inactive=1&limit=5")
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      renderNotificationsSent(data.notifications || []);
      setStatus("notificationsSentStatus", "", "muted");
    })
    .catch((e) => setStatus("notificationsSentStatus", e.message || "Failed", "err"));
}

function renderNotificationsSent(rows) {
  const tbody = document.getElementById("notificationsSentBody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="table-empty">No notifications on the server yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((n) => {
      const created = n.created_at != null ? formatTimestamp(Number(n.created_at)) : "—";
      const title = escapeHtml(n.title || "—");
      const body = escapeHtml(truncateText(n.body || "", 120));
      const active = n.is_active ? "Yes" : "No";
      const nid = escapeAttr(n.id);
      return `<tr>
        <td>${created}</td>
        <td>${title}</td>
        <td class="notifications-sent__body">${body}</td>
        <td>${active}</td>
        <td><button type="button" class="btn btn--small btn--danger" data-action="delete-notif" data-notif-id="${nid}">Delete</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-action='delete-notif']").forEach((btn) => {
    btn.addEventListener("click", () =>
      deleteNotificationById(btn.getAttribute("data-notif-id"))
    );
  });
}

function deleteNotificationById(id) {
  if (!id) return;
  if (
    !confirm(
      "Delete this notification from the server? It will disappear from users’ apps after their next sync."
    )
  ) {
    return;
  }
  setStatus("notificationsSentStatus", "Deleting…", "muted");
  adminFetch("/admin/notifications/" + encodeURIComponent(id), { method: "DELETE" })
    .then(async (res) => {
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        /* non-JSON body */
      }
      if (!res.ok) {
        const msg = data.error || res.statusText || "Failed";
        if (res.status === 404) {
          setStatus("notificationsSentStatus", "Already deleted on server. Refreshing list…", "muted");
          loadNotificationsSent();
          return { ok: true, alreadyDeleted: true };
        }
        throw new Error(msg);
      }
      return data;
    })
    .then(() => {
      if (!document.getElementById("notificationsSentStatus")?.textContent?.includes("Already deleted")) {
        setStatus("notificationsSentStatus", "Deleted.", "ok");
        loadNotificationsSent();
      }
    })
    .catch((e) => setStatus("notificationsSentStatus", e.message || "Failed", "err"));
}

document.getElementById("notificationsRefresh")?.addEventListener("click", () => {
  loadNotificationsSent();
});

document.getElementById("createCopyKey")?.addEventListener("click", () => {
  const key = document.getElementById("createResultKey")?.textContent;
  if (key) {
    navigator.clipboard.writeText(key);
    setStatus("createStatus", "Copied to clipboard.", "ok");
  }
});

// --- License Details ---
function loadDetails(key) {
  if (!key) return;
  document.getElementById("detailsEmpty")?.classList.add("hidden");
  document.getElementById("detailsContent")?.classList.remove("hidden");
  setStatus("detailsStatusMsg", "Loading…", "muted");
  adminFetch("/admin/licenses/" + encodeURIComponent(key))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      renderDetails(data);
      setStatus("detailsStatusMsg", "", "muted");
    })
    .catch((e) => {
      setStatus("detailsStatusMsg", e.message || "Failed", "err");
      document.getElementById("detailsEmpty")?.classList.remove("hidden");
      document.getElementById("detailsContent")?.classList.add("hidden");
    });
}

function renderDetails(data) {
  const statusClass = data.status === "valid" ? "badge--ok" : data.status === "expired" ? "badge--warn" : "badge--err";
  document.getElementById("detailsKey").textContent = data.license_key;
  document.getElementById("detailsStatus").textContent = data.status;
  document.getElementById("detailsStatus").className = "badge " + statusClass;
  document.getElementById("detailsPlan").textContent = data.plan_type || "—";
  document.getElementById("detailsExpires").textContent = formatExpires(data.expires_at);
  document.getElementById("detailsDevices").textContent = `${(data.devices || []).length} / ${data.device_limit ?? 3}`;

  const tbody = document.getElementById("detailsDevicesBody");
  tbody.innerHTML = (data.devices || []).map((d) => `
    <tr>
      <td><code>${escapeHtml(d.device_hash || "—")}</code></td>
      <td>${formatTimestamp(d.first_seen)}</td>
      <td>${formatTimestamp(d.last_seen)}</td>
      <td><button type="button" class="btn btn--small btn--danger btn-revoke-device" data-fp="${escapeAttr(d.device_fingerprint)}">Revoke</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".btn-revoke-device").forEach((btn) => {
    btn.addEventListener("click", () => revokeDevice(data.license_key, btn.dataset.fp));
  });

  const detailsRevoke = document.getElementById("detailsRevoke");
  const detailsDelete = document.getElementById("detailsDelete");
  if (detailsRevoke) detailsRevoke.disabled = data.status === "revoked";
  if (detailsDelete) {
    detailsDelete.classList.toggle("hidden", data.status !== "revoked");
  }
}

document.getElementById("detailsEdit")?.addEventListener("click", () => {
  if (detailsLicenseKey) openEditModal(detailsLicenseKey);
});

document.getElementById("detailsResetDevices")?.addEventListener("click", () => {
  if (!detailsLicenseKey) return;
  if (!confirm("Reset all devices for this license? Users will need to re-activate.")) return;
  adminFetch("/admin/licenses/" + encodeURIComponent(detailsLicenseKey) + "/devices/reset", { method: "POST" })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok && data.error) throw new Error(data.error);
      return data;
    })
    .then((data) => {
      loadDetails(detailsLicenseKey);
      loadLicenses();
      setStatus("detailsStatusMsg", "Devices reset.", "ok");
    })
    .catch((e) => setStatus("detailsStatusMsg", e.message || "Failed", "err"));
});

document.getElementById("detailsRevoke")?.addEventListener("click", () => {
  if (!detailsLicenseKey) return;
  if (!confirm("Revoke this license? It cannot be undone.")) return;
  revokeLicense(detailsLicenseKey);
});

document.getElementById("detailsDelete")?.addEventListener("click", () => {
  if (detailsLicenseKey) deleteLicense(detailsLicenseKey);
});

function deleteLicense(key) {
  if (!confirm("Permanently delete this revoked license from the database? This cannot be undone.")) return;
  adminFetch("/admin/licenses/" + encodeURIComponent(key), { method: "DELETE" })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok && data.error) throw new Error(data.error);
      return data;
    })
    .then(() => {
      if (detailsLicenseKey === key) {
        detailsLicenseKey = null;
        document.getElementById("tabDetails")?.classList.add("hidden");
        switchTab("licenses");
      }
      loadLicenses();
      setStatus("licensesStatusMsg", "License deleted.", "ok");
      setStatus("detailsStatusMsg", "License deleted.", "ok");
    })
    .catch((e) => {
      setStatus("licensesStatusMsg", e.message || "Failed", "err");
      setStatus("detailsStatusMsg", e.message || "Failed", "err");
    });
}

function revokeLicense(key) {
  adminFetch("/admin/licenses/" + encodeURIComponent(key) + "/revoke", { method: "POST" })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok && data.error) throw new Error(data.error);
      return data;
    })
    .then((data) => {
      if (detailsLicenseKey === key) loadDetails(key);
      loadLicenses();
      setStatus("detailsStatusMsg", "License revoked.", "ok");
    })
    .catch((e) => setStatus("detailsStatusMsg", e.message || "Failed", "err"));
}

function revokeDevice(licenseKey, fp) {
  if (!confirm("Revoke this device?")) return;
  adminFetch("/admin/licenses/" + encodeURIComponent(licenseKey) + "/devices/revoke", {
    method: "POST",
    body: JSON.stringify({ device_fingerprint: fp }),
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok && data.error) throw new Error(data.error);
      return data;
    })
    .then((data) => {
      loadDetails(licenseKey);
      loadLicenses();
      setStatus("detailsStatusMsg", "Device revoked.", "ok");
    })
    .catch((e) => setStatus("detailsStatusMsg", e.message || "Failed", "err"));
}

// --- Edit modal ---
function openEditModal(key) {
  adminFetch("/admin/licenses/" + encodeURIComponent(key))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      document.getElementById("editLicenseKey").value = key;
      document.getElementById("editPlanType").value = data.plan_type || "lifetime";
      document.getElementById("editDeviceLimit").value = data.device_limit ?? 3;
      const years = data.plan_type === "yearly" && data.issued_at && data.expires_at
        ? Math.round((data.expires_at - data.issued_at) / 31536000)
        : 1;
      document.getElementById("editDurationYears").value = Math.max(1, years);
      document.getElementById("editDurationRow").style.display = data.plan_type === "yearly" ? "" : "none";
      document.getElementById("editModal").classList.remove("hidden");
    })
    .catch((e) => setStatus("licensesStatusMsg", e.message || "Failed", "err"));
}

document.getElementById("editPlanType")?.addEventListener("change", () => {
  document.getElementById("editDurationRow").style.display =
    document.getElementById("editPlanType").value === "yearly" ? "" : "none";
});

document.getElementById("editCancel")?.addEventListener("click", () => {
  document.getElementById("editModal").classList.add("hidden");
});

document.getElementById("editModal")?.querySelector(".modal__backdrop")?.addEventListener("click", () => {
  document.getElementById("editModal").classList.add("hidden");
});

document.getElementById("formEdit")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = document.getElementById("editLicenseKey").value;
  const planType = document.getElementById("editPlanType").value;
  const durationYears = parseInt(document.getElementById("editDurationYears").value || "1", 10);
  const deviceLimit = parseInt(document.getElementById("editDeviceLimit").value || "3", 10);
  try {
    const res = await adminFetch("/admin/licenses/" + encodeURIComponent(key), {
      method: "PATCH",
      body: JSON.stringify({ planType, durationYears, deviceLimit }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");
    document.getElementById("editModal").classList.add("hidden");
    loadDetails(key);
    loadLicenses();
    setStatus("detailsStatusMsg", "License updated.", "ok");
  } catch (err) {
    setStatus("detailsStatusMsg", err.message || "Failed", "err");
  }
});

// --- Admin Logs ---
let logsPage = 1;
const logsLimit = 50;

function loadLogs() {
  const params = new URLSearchParams({ page: logsPage, limit: logsLimit });
  adminFetch("/admin/logs?" + params)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      const tbody = document.getElementById("logsTableBody");
      const logs = data.logs || [];
      if (logs.length === 0 && !data.total) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Click <strong>Load logs</strong> to fetch audit log.</td></tr>';
      } else {
        tbody.innerHTML = logs.map((l) => `
        <tr>
          <td>${formatTimestamp(l.created_at)}</td>
          <td>${escapeHtml(l.action)}</td>
          <td><code>${escapeHtml(l.license_key || "—")}</code></td>
          <td>${escapeHtml(l.details || "—")}</td>
        </tr>
      `).join("");
      }
      const total = data.total ?? 0;
      const page = data.page ?? 1;
      const limit = data.limit ?? 50;
      document.getElementById("logsPaginationInfo").textContent = `${total} total · Page ${page}`;
      document.getElementById("logsPrev").disabled = page <= 1;
      document.getElementById("logsNext").disabled = page * limit >= total;
    })
    .catch((e) => setStatus("logsStatusMsg", e.message || "Failed", "err"));
}

document.getElementById("logsSearch")?.addEventListener("click", () => { logsPage = 1; loadLogs(); });
document.getElementById("logsPrev")?.addEventListener("click", () => { logsPage--; loadLogs(); });
document.getElementById("logsNext")?.addEventListener("click", () => { logsPage++; loadLogs(); });
// Logs: no auto-fetch on tab switch — user must click Refresh

// --- Settings ---
document.getElementById("btnSaveConfig")?.addEventListener("click", () => {
  const baseUrl = document.getElementById("configBaseUrl")?.value?.trim() || "";
  const secret = document.getElementById("configSecret")?.value?.trim() || "";
  saveConfig(baseUrl, secret);
  setStatus("configStatus", "Config saved.", "ok");
});

document.getElementById("btnResetConfig")?.addEventListener("click", () => {
  saveConfig("", "");
  document.getElementById("configBaseUrl").value = "";
  document.getElementById("configSecret").value = "";
  setStatus("configStatus", "Config reset.", "ok");
});

// --- Init ---
function applyConfigToForm() {
  const c = getConfig();
  document.getElementById("configBaseUrl").value = c.baseUrl;
  document.getElementById("configSecret").value = c.secret;
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  if (s == null) return "";
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

applyConfigToForm();
