/**
 * On-device “taste” from tags + media types (preview, collections, find-related).
 * Home feed (unfiltered): top ~3 long-form rows stay most relatable; below that, shuffled bands
 * so order gets looser and weaker matches drift toward the bottom — no separate “for you” UI.
 */

const STORAGE_KEY = "qooti_behavior_profile_v1";
const PROFILE_VERSION = 1;
const MAX_TAG_WEIGHT = 85;
const MAX_TYPE_WEIGHT = 60;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DECAY_FACTOR = 0.9;
const TYPE_WEIGHT_SCALE = 0.32;

/** @type {Record<string, { tag: number, type: number }>} */
const KIND_WEIGHTS = {
  preview: { tag: 1.15, type: 0.35 },
  collection: { tag: 4.25, type: 1.1 },
  similar_source: { tag: 2.1, type: 0.55 },
};

function emptyProfile() {
  return {
    v: PROFILE_VERSION,
    tagWeights: Object.create(null),
    typeWeights: Object.create(null),
    updatedAt: Date.now(),
  };
}

function decayProfile(p) {
  for (const k of Object.keys(p.tagWeights)) {
    const next = p.tagWeights[k] * DECAY_FACTOR;
    if (next < 0.2) delete p.tagWeights[k];
    else p.tagWeights[k] = next;
  }
  for (const k of Object.keys(p.typeWeights)) {
    const next = p.typeWeights[k] * DECAY_FACTOR;
    if (next < 0.12) delete p.typeWeights[k];
    else p.typeWeights[k] = next;
  }
}

export function loadBehaviorProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const p = JSON.parse(raw);
    if (!p || p.v !== PROFILE_VERSION) return emptyProfile();
    const now = Date.now();
    if (now - (p.updatedAt || 0) > DECAY_INTERVAL_MS) {
      decayProfile(p);
      p.updatedAt = now;
      persistBehaviorProfile(p);
    }
    return p;
  } catch {
    return emptyProfile();
  }
}

function persistBehaviorProfile(p) {
  p.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* quota / private mode */
  }
}

/**
 * @param {object} item inspiration row (tags optional)
 * @param {'preview'|'collection'|'similar_source'} kind
 */
export function recordItemEngagement(item, kind) {
  if (!item?.id) return;
  const w = KIND_WEIGHTS[kind] || KIND_WEIGHTS.preview;
  const p = loadBehaviorProfile();
  const tags = Array.isArray(item.tags) ? item.tags : [];
  for (const tag of tags) {
    const id = tag && typeof tag === "object" ? tag.id : tag;
    if (id == null || id === "") continue;
    const key = String(id);
    p.tagWeights[key] = Math.min(MAX_TAG_WEIGHT, (p.tagWeights[key] || 0) + w.tag);
  }
  const ty = item.type || "image";
  p.typeWeights[ty] = Math.min(MAX_TYPE_WEIGHT, (p.typeWeights[ty] || 0) + w.type);
  persistBehaviorProfile(p);
}

/**
 * @param {object} item
 * @param {ReturnType<typeof loadBehaviorProfile>} profile
 */
export function itemAffinityScore(item, profile) {
  let s = 0;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  for (const tag of tags) {
    const id = tag && typeof tag === "object" ? tag.id : tag;
    if (id == null) continue;
    s += profile.tagWeights[String(id)] || 0;
  }
  const ty = item.type || "image";
  s += (profile.typeWeights[ty] || 0) * TYPE_WEIGHT_SCALE;
  return s;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

const TAIL_BANDS = 3;

/**
 * First `headSize` items: strict relatability (score desc, then recency).
 * Rest: split into bands by remaining score (high → low); shuffle inside each band so the tail
 * feels varied while average relevance still drops toward the bottom.
 *
 * @param {object[]} items
 * @param {ReturnType<typeof loadBehaviorProfile>} [profile]
 * @param {number} [headSize] — e.g. 3 × long-form column count
 */
export function applyPersonalizedHomeOrder(items, profile, headSize) {
  if (!Array.isArray(items) || items.length <= 1) return items;
  const p = profile || loadBehaviorProfile();
  const enriched = items.map((it) => ({
    it,
    score: itemAffinityScore(it, p),
    created: Number(it.created_at) || 0,
  }));
  enriched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.created - a.created;
  });

  const H = Math.max(
    0,
    Math.min(enriched.length, Math.floor(headSize == null ? enriched.length : headSize))
  );
  const head = enriched.slice(0, H);
  const tail = enriched.slice(H);
  if (tail.length === 0) return head.map((x) => x.it);

  tail.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.created - a.created;
  });
  const bandSize = Math.max(1, Math.ceil(tail.length / TAIL_BANDS));
  const mergedTail = [];
  for (let b = 0; b < TAIL_BANDS; b++) {
    const chunk = tail.slice(b * bandSize, (b + 1) * bandSize);
    if (chunk.length === 0) break;
    shuffleInPlace(chunk);
    mergedTail.push(...chunk);
  }
  return [...head.map((x) => x.it), ...mergedTail.map((x) => x.it)];
}

/**
 * @param {{ view?: string, query?: string, colorFilter?: object | null, selectedTagId?: string | null, settings?: object }} viewState
 */
export function shouldPersonalizeHomeGrid(viewState) {
  const v = viewState || {};
  const view = String(v.view || "");
  if (view.startsWith("collection:")) return false;
  if (String(v.query || "").trim()) return false;
  if (v.colorFilter) return false;
  if (v.selectedTagId && String(v.selectedTagId).trim()) return false;
  if (v.settings?.personalizeHomeFeed === "false") return false;
  return true;
}
