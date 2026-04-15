/** Resolve latest qooti release asset from blootapp/qooti-releases */

const REPO = "blootapp/qooti-releases";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export type LatestAssetResult =
  | { ok: true; url: string; name: string; tag: string }
  | { ok: false; error: string };

type GitHubRelease = {
  tag_name: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
};

export async function getLatestReleaseAsset(platform: "mac" | "win"): Promise<LatestAssetResult> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const res = await fetch(LATEST_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    next: { revalidate: 120 },
  });

  if (!res.ok) {
    if (res.status === 403) {
      return {
        ok: false,
        error:
          "GitHub API rate limit (set GITHUB_TOKEN for higher limits). Open releases on GitHub manually.",
      };
    }
    if (res.status === 404) {
      return { ok: false, error: "No release found for this repository." };
    }
    return { ok: false, error: `GitHub API error (${res.status}).` };
  }

  const data = (await res.json()) as GitHubRelease;
  const assets = data.assets ?? [];
  const ext = platform === "mac" ? ".dmg" : ".exe";
  const candidates = assets.filter((a) => a.name.toLowerCase().endsWith(ext));
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `No ${ext} asset found in the latest release. See https://github.com/${REPO}/releases`,
    };
  }

  const pick =
    candidates.length === 1
      ? candidates[0]
      : [...candidates].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0];

  return {
    ok: true,
    url: pick.browser_download_url,
    name: pick.name,
    tag: data.tag_name,
  };
}
