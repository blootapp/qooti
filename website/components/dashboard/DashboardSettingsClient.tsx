"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SettingsUser = {
  username: string;
  email: string;
  publicId: string;
  language: "uz" | "en";
};

export function DashboardSettingsClient({ initialUser }: { initialUser: SettingsUser }) {
  const router = useRouter();
  const [user, setUser] = useState(initialUser);
  const [editingUsername, setEditingUsername] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [usernameInput, setUsernameInput] = useState(initialUser.username);
  const [emailInput, setEmailInput] = useState(initialUser.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [pwdCurrent, setPwdCurrent] = useState("");
  const [pwdNext, setPwdNext] = useState("");
  const [dangerName, setDangerName] = useState("");
  const [message, setMessage] = useState("");

  async function copyId() {
    await navigator.clipboard.writeText(user.publicId);
    setMessage("ID nusxalandi.");
  }

  async function saveUsername() {
    const res = await fetch("/api/dashboard/username", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameInput }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "Username update failed.");
      return;
    }
    setUser((prev) => ({ ...prev, username: data.user.username }));
    setEditingUsername(false);
    setMessage("Username yangilandi.");
    router.refresh();
  }

  async function saveEmail() {
    const res = await fetch("/api/dashboard/email", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailInput, currentPassword: emailPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "Email update failed.");
      return;
    }
    setUser((prev) => ({ ...prev, email: data.user.email }));
    setEditingEmail(false);
    setEmailPassword("");
    setMessage("Email yangilandi.");
    router.refresh();
  }

  async function savePassword() {
    const res = await fetch("/api/dashboard/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: pwdCurrent, newPassword: pwdNext }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "Password update failed.");
      return;
    }
    setPwdCurrent("");
    setPwdNext("");
    setEditingPassword(false);
    setMessage("Password yangilandi.");
  }

  async function setLanguage(language: "uz" | "en") {
    const res = await fetch("/api/dashboard/language", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
    if (!res.ok) return;
    setUser((prev) => ({ ...prev, language }));
    router.refresh();
  }

  async function destroyAccount() {
    const res = await fetch("/api/dashboard/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: dangerName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "Delete failed.");
      return;
    }
    router.replace("/signup");
  }

  return (
    <div className="section-spacing space-y-8">
      {message && <p className="text-[13px] text-[var(--muted)]">{message}</p>}
      <div className="dashboard-card relative overflow-hidden">
        <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--accent)]" aria-hidden="true" />
        <p className="section-label">Sizning ID raqamingiz</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="max-w-full truncate rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-[16px] font-medium text-[var(--white)]">
            {user.publicId}
          </code>
          <button onClick={copyId} className="btn btn-secondary">
            Copy
          </button>
        </div>
        <p className="mt-3 text-[12px] text-[var(--muted2)]">
          Litsenziya sotib olishda bu ID ni @blootsupport ga yuboring
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-[13px] font-medium text-[var(--white)]">Account</h2>
        <div className="overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-col gap-3 border-b border-[var(--border)] px-6 py-4 md:flex-row md:items-center md:justify-between">
            <p className="text-[13px] text-[var(--muted)]">Username</p>
            {editingUsername ? (
              <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto">
                <input
                  className="h-[34px] min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 text-[13px]"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                />
                <button onClick={saveUsername} className="btn btn-primary">
                  Save
                </button>
                <button onClick={() => setEditingUsername(false)} className="btn btn-ghost">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-[var(--white)]">{user.username}</span>
                <button onClick={() => setEditingUsername(true)} className="btn btn-ghost">
                  Edit
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-b border-[var(--border)] px-6 py-4 md:flex-row md:items-center md:justify-between">
            <p className="text-[13px] text-[var(--muted)]">Email</p>
            {editingEmail ? (
              <div className="w-full space-y-2 md:w-[360px]">
                <input
                  className="h-[34px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 text-[13px]"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="New email"
                />
                <input
                  type="password"
                  className="h-[34px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 text-[13px]"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  placeholder="Current password"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={saveEmail} className="btn btn-primary">
                    Save
                  </button>
                  <button onClick={() => setEditingEmail(false)} className="btn btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-[var(--white)]">{user.email}</span>
                <button onClick={() => setEditingEmail(true)} className="btn btn-ghost">
                  Edit
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
            <p className="text-[13px] text-[var(--muted)]">Password</p>
            {editingPassword ? (
              <div className="w-full space-y-2 md:w-[360px]">
                <input
                  type="password"
                  className="h-[34px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 text-[13px]"
                  value={pwdCurrent}
                  onChange={(e) => setPwdCurrent(e.target.value)}
                  placeholder="Current password"
                />
                <input
                  type="password"
                  className="h-[34px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 text-[13px]"
                  value={pwdNext}
                  onChange={(e) => setPwdNext(e.target.value)}
                  placeholder="New password"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={savePassword} className="btn btn-primary">
                    Save
                  </button>
                  <button onClick={() => setEditingPassword(false)} className="btn btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-[var(--white)]">********</span>
                <button onClick={() => setEditingPassword(true)} className="btn btn-ghost">
                  Edit
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-medium text-[var(--white)]">Language</h2>
        <div className="dashboard-card">
          <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface2)] p-1">
            <div className="flex gap-1">
              <button
                onClick={() => setLanguage("uz")}
                className={`btn !h-8 !rounded-full !px-4 ${user.language === "uz" ? "btn-primary" : "btn-ghost"}`}
              >
                O'zbek
              </button>
              <button
                onClick={() => setLanguage("en")}
                className={`btn !h-8 !rounded-full !px-4 ${user.language === "en" ? "btn-primary" : "btn-ghost"}`}
              >
                English
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="mb-3 text-[13px] font-medium text-[#d05555]">Xavfli zona</h2>
        <div className="rounded-[14px] border border-[rgba(208,85,85,0.2)] bg-[rgba(208,85,85,0.08)] px-6 py-5">
          <p className="text-[13px] text-[var(--muted)]">Hisob o'chirilsa barcha ma'lumotlar qayta tiklanmaydi.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              className="h-[34px] rounded-lg border border-[rgba(208,85,85,0.3)] bg-[rgba(0,0,0,0.22)] px-3 text-[13px]"
              value={dangerName}
              onChange={(e) => setDangerName(e.target.value)}
              placeholder="Type your username"
            />
            <button onClick={destroyAccount} className="btn btn-danger">
              Delete account
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
