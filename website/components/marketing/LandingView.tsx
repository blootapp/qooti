"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { DownloadSection } from "@/components/marketing/DownloadSection";
import { PricingSection, type PlanUserMini } from "@/components/marketing/PricingSection";
import "@/styles/marketing.css";

type AuthMeResponse = { user?: { username?: string; publicId?: string; blootUserId?: string } };

export function LandingView() {
  const t = useTranslations("Home");
  const tNav = useTranslations("Nav");
  const [dashHref, setDashHref] = useState("/login");
  const [navLoggedIn, setNavLoggedIn] = useState(false);
  const [profileInitial, setProfileInitial] = useState("");
  const [planUser, setPlanUser] = useState<PlanUserMini | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.07, rootMargin: "0px 0px -32px 0px" }
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: AuthMeResponse) => {
        const user = data?.user;
        if (user?.username) {
          setDashHref("/dashboard");
          setNavLoggedIn(true);
          setProfileInitial((user.username.charAt(0) || "?").toUpperCase());
          setPlanUser({ username: user.username, publicId: user.publicId || user.blootUserId || null });
        } else {
          setDashHref("/login");
          setNavLoggedIn(false);
          setProfileInitial("");
          setPlanUser(null);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onHashChange = () => setMobileMenuOpen(false);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <>
      <nav className="marketing-nav" aria-label="Primary">
        <Link href="/" className="nav-logo">
          <img src="/assets/bloot.png" alt="bloot" />
        </Link>
        <div className="nav-center">
          <ul className="nav-links">
            <li>
              <a href="#top">{tNav("home")}</a>
            </li>
            <li>
              <a href="#download">{tNav("download")}</a>
            </li>
            <li>
              <a href="#pricing">{tNav("pricing")}</a>
            </li>
            <li>
              <Link href={dashHref}>{tNav("dashboard")}</Link>
            </li>
          </ul>
        </div>
        <div className="nav-right">
          <div className={`nav-actions${navLoggedIn ? " logged-in" : ""}`} id="navActions">
            <Link href="/login" className="nav-ghost">
              {tNav("login")}
            </Link>
            <Link href="/signup" className="nav-solid">
              {tNav("signup")}
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path
                  d="M1.5 5.5h8M5.5 1.5l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>
          <Link
            href={dashHref}
            className={`nav-profile ${navLoggedIn ? "show" : ""}`}
            title="Dashboard"
            aria-label="Open dashboard"
          >
            {navLoggedIn ? profileInitial : null}
          </Link>
          <button
            type="button"
            className={`nav-menu-btn${mobileMenuOpen ? " open" : ""}`}
            aria-label="Open navigation menu"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((prev) => !prev)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </nav>

      <div className={`mobile-nav-panel${mobileMenuOpen ? " open" : ""}`} aria-hidden={!mobileMenuOpen}>
        <a href="#top" onClick={() => setMobileMenuOpen(false)}>
          {tNav("home")}
        </a>
        <a href="#download" onClick={() => setMobileMenuOpen(false)}>
          {tNav("download")}
        </a>
        <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>
          {tNav("pricing")}
        </a>
        <Link href={dashHref} onClick={() => setMobileMenuOpen(false)}>
          {tNav("dashboard")}
        </Link>
        {!navLoggedIn ? (
          <div className="mobile-nav-auth">
            <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
              {tNav("login")}
            </Link>
            <Link href="/signup" onClick={() => setMobileMenuOpen(false)}>
              {tNav("signup")}
            </Link>
          </div>
        ) : null}
      </div>

      <div className="hero" id="top">
        <div className="hero-glow" />
        <h1 className="hero-h1">
          {t("heroLine1")}
          <br />
          <em>{t("heroEm")}</em>
          <br />
          {t("heroLine2")}
        </h1>
        <p className="hero-p">{t("heroP")}</p>
        <div className="hero-actions">
          <a href="#download" className="btn-dl">
            {t("downloadFree")}
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
              <path
                d="M6.5 1.5v7M3.5 6l3 3 3-3M1.5 11h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <a href="#pricing" className="btn-text">
            {t("howItWorks")}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path
                d="M2.5 6h7M6 2.5l3.5 3.5L6 9.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        </div>
        <p className="hero-meta">{t("heroMeta")}</p>
      </div>

      <DownloadSection />

      <hr className="div" />

      <PricingSection planUser={planUser} />

      <hr className="div" />

      <div className="footer-wrap">
        <div className="footer-top">
          <div>
            <Link href="/" className="footer-logo">
              <img src="/assets/bloot.png" alt="bloot" />
            </Link>
            <p className="footer-tagline">{t("footerTag")}</p>
          </div>
          <div>
            <p className="footer-heading">{t("footerProduct")}</p>
            <ul className="footer-links">
              <li>
                <a href="#download">{tNav("download")}</a>
              </li>
              <li>
                <a href="#pricing">{tNav("pricing")}</a>
              </li>
              <li>
                <a href="https://github.com/blootapp/qooti-releases/releases">{t("changelog")}</a>
              </li>
            </ul>
          </div>
          <div>
            <p className="footer-heading">{t("footerCompany")}</p>
            <ul className="footer-links">
              <li>
                <a href="https://t.me/blootsupport" target="_blank" rel="noopener noreferrer">
                  {t("footerContact")}
                </a>
              </li>
              <li>
                <Link href="/help">{tNav("help")}</Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="footer-heading">{t("footerLegal")}</p>
            <ul className="footer-links">
              <li>
                <Link href="/privacy">{t("privacy")}</Link>
              </li>
              <li>
                <Link href="/terms">{t("terms")}</Link>
              </li>
              <li>
                <Link href="/dashboard/billing#plans">{t("license")}</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <p className="footer-copy">© 2026 bloot. All rights reserved.</p>
          <div className="footer-social">
            <a href="https://t.me/blootapp" target="_blank" rel="noopener noreferrer">
              {t("telegram")}
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
