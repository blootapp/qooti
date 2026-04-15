import { AppCard } from "@/components/dashboard/AppCard";
import { getDashboardViewer } from "@/lib/dashboard-server";

export default async function DashboardAppsPage() {
  const { apps } = await getDashboardViewer();
  return (
    <div>
      <h1 className="page-title">My Apps</h1>
      <div className="app-grid-page section-spacing">
        {apps.map((app) => (
          <AppCard key={app.appId} app={app} />
        ))}
        <div className="dashboard-card flex min-h-[252px] flex-col items-center justify-center border-dashed text-center opacity-60">
          <div className="text-2xl text-[var(--muted)]">?</div>
          <h3 className="mt-3 text-[15px] font-medium text-[var(--white)]">Coming soon</h3>
          <p className="mt-2 text-[13px] text-[var(--muted)]">New bloot product</p>
          <a
            href="https://t.me/blootapp"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary mt-4"
          >
            Xabardor bo'lish
          </a>
        </div>
      </div>
    </div>
  );
}
