import { redirect } from "@/i18n/navigation";
import { getLocale } from "next-intl/server";
import { getRequiredSession } from "./auth-server";
import { getDashboardUserByEmail, getDashboardUserByPublicId, getUserApps, getUserPayments } from "./dashboard";

export async function getDashboardViewer() {
  const session = await getRequiredSession();
  let user = await getDashboardUserByEmail(session.email);

  if (!user && session.publicId) {
    user = await getDashboardUserByPublicId(session.publicId);
  }
  if (!user) {
    const locale = await getLocale();
    redirect({ href: "/login", locale });
  }
  const u = user!;
  const apps = await getUserApps(u.publicId);
  const payments = await getUserPayments(u.publicId);
  return { user: u, apps, payments };
}
