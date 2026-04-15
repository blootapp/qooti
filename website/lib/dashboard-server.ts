import { redirect } from "@/i18n/navigation";
import { getLocale } from "next-intl/server";
import { getRequiredSession } from "./auth-server";
import { getDashboardUserByEmail, getDashboardUserByPublicId, getUserApps, getUserPayments } from "./dashboard";
import { upsertUserMirror } from "./users";

export async function getDashboardViewer() {
  const session = getRequiredSession();
  let user = getDashboardUserByEmail(session.email);

  if (!user && session.publicId && session.username) {
    try {
      upsertUserMirror({
        publicId: session.publicId,
        email: session.email,
        name: session.name || session.username,
        surname: session.surname || "User",
        username: session.username,
        language: session.language === "en" ? "en" : "uz",
      });
      user =
        getDashboardUserByEmail(session.email) || getDashboardUserByPublicId(session.publicId);
    } catch (_) {
      /* ignore bootstrap errors and fall through to redirect */
    }
  }
  if (!user) {
    const locale = await getLocale();
    redirect({ href: "/login", locale });
  }
  const u = user!;
  const apps = getUserApps(u.publicId);
  const payments = getUserPayments(u.publicId);
  return { user: u, apps, payments };
}
