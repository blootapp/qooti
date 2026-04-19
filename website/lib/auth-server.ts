import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSessionPayload } from "./api-session";
import { SESSION_COOKIE } from "./bloot-session";

export async function getRequiredSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = await validateSessionPayload(token);
  if (!payload?.email) redirect("/login");
  return payload;
}
