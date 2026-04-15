import { getTranslations } from "next-intl/server";
import { QOOTI_PACKAGES } from "./qooti-subscription";

export type QootiPackDisplay = {
  id: string;
  packageLine: string;
  popular: boolean;
  title: string;
  subtitle: string;
  priceLabel: string;
};

export async function getQootiPacksForLocale(): Promise<{
  packs: QootiPackDisplay[];
  benefits: string[];
}> {
  const t = await getTranslations("Billing");
  const titleSubPrice = {
    "1m": { title: t("pack1mTitle"), subtitle: t("pack1mSub"), price: t("price1m") },
    "1y": { title: t("pack1yTitle"), subtitle: t("pack1ySub"), price: t("price1y") },
    "6m": { title: t("pack6mTitle"), subtitle: t("pack6mSub"), price: t("price6m") },
  } as const;

  const packs = QOOTI_PACKAGES.map((p) => {
    const x = titleSubPrice[p.id];
    return {
      id: p.id,
      packageLine: p.packageLine,
      popular: p.popular,
      title: x.title,
      subtitle: x.subtitle,
      priceLabel: x.price,
    };
  });

  const benefits = [t("feat1"), t("feat2"), t("feat3"), t("feat4")];

  return { packs, benefits };
}
