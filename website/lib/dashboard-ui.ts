import { PlanType } from "./dashboard";

export function planToLabel(plan: PlanType): string {
  if (plan === "monthly") return "Monthly";
  if (plan === "biannual") return "Biannual";
  if (plan === "yearly") return "Yearly";
  return "Trial";
}

export function planBadgeClass(plan: PlanType): string {
  if (plan === "monthly") return "bg-[#4eabfb1f] text-[#4eabfb]";
  if (plan === "biannual") return "bg-[#a855f71f] text-[#c084fc]";
  if (plan === "yearly") return "bg-[#22c55e1f] text-[#4ade80]";
  return "bg-[#f59e0b1f] text-[#f59e0b]";
}

export function formatDate(ms: number, locale = "en"): string {
  const tag = locale === "uz" ? "uz-UZ" : "en-GB";
  return new Date(ms).toLocaleDateString(tag, { day: "2-digit", month: "short", year: "numeric" });
}
