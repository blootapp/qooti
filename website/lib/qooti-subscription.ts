/** qooti subscription packages + Telegram deep link for @blootsupport */

export function buildTelegramUrl(
  username: string | null,
  publicId: string | null,
  packageLine: string
) {
  const u = username?.trim() || "—";
  const id = publicId?.trim() || "—";
  const body = `Assalomu alaykum, bloot support jamoasi!

Men bloot akkauntim orqali qooti uchun to‘lov qilmoqchiman.

bloot username: ${u}
bloot id: ${id}

Tanlangan paket: ${packageLine}

Iltimos, to‘lov bo‘yicha yo‘riqnoma yoki keyingi qadamlarni yuboring.

Rahmat!`;
  return `https://t.me/blootsupport?text=${encodeURIComponent(body)}`;
}

/** Display order: 1 month, 1 year (featured), 6 months */
export const QOOTI_PACKAGES = [
  {
    id: "1m" as const,
    packageLine: "1 oy — 49 000 so‘m",
    popular: false,
  },
  {
    id: "1y" as const,
    packageLine: "1 yil — 299 000 so‘m",
    popular: true,
  },
  {
    id: "6m" as const,
    packageLine: "6 oy — 199 000 so‘m",
    popular: false,
  },
];

export type QootiPackageId = (typeof QOOTI_PACKAGES)[number]["id"];
