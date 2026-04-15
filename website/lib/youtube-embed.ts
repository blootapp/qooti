/** Build YouTube embed URL from watch URL, youtu.be, or 11-char video ID */
export function toYouTubeEmbedUrl(urlOrId: string | undefined): string | null {
  if (!urlOrId?.trim()) return null;
  const s = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return `https://www.youtube.com/embed/${s}`;
  }
  const watch = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watch) return `https://www.youtube.com/embed/${watch[1]}`;
  const short = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return `https://www.youtube.com/embed/${short[1]}`;
  const embed = s.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embed) return `https://www.youtube.com/embed/${embed[1]}`;
  return null;
}
