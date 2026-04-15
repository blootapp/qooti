import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionPayload, SESSION_COOKIE } from "./sessions";

export function getRequiredSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = getSessionPayload(token);
  if (!payload?.email) redirect("/login");
  return payload;
}
