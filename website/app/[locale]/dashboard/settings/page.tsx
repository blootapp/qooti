import { DashboardSettingsClient } from "@/components/dashboard/DashboardSettingsClient";
import { getDashboardViewer } from "@/lib/dashboard-server";

export default async function DashboardSettingsPage() {
  const { user } = await getDashboardViewer();
  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <DashboardSettingsClient
        initialUser={{
          username: user.username,
          email: user.email,
          publicId: user.publicId,
          language: user.language,
        }}
      />
    </div>
  );
}
