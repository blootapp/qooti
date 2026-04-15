import { NextRequest } from "next/server";
import { getSessionPayload, SESSION_COOKIE } from "./sessions";

export function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return getSessionPayload(token);
}
