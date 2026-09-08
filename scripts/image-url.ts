/** Publisher square crops (OGP/RSS) — not the article's natural aspect ratio. */
export function isSquareCroppedImageUrl(url: string): boolean {
  const file = (url.split('/').pop() ?? url).toLowerCase();
  return (
    /_square/i.test(file) ||
    /_dezeen_\d+_sq/i.test(file) ||
    /_dezeen_\d+_col_sq/i.test(file) ||
    /(?:^|[-_])sq-\d+x\d+/i.test(file) ||
    /(?:^|[-_])sq\.[a-z]+$/i.test(file)
  );
}

/** Prefer higher-resolution image URLs when the publisher uses size suffixes in paths. */
export function normalizeImageUrl(url: string, sourceId?: string): string {
  let u = url.trim();
  if (!u) return u;

  // Dezeen thumbnails → drop square size suffix (keep full hero filenames intact)
  const isDezeenFull =
    /_dezeen_2364_col_hero|_dezeen_2364_hero|_dezeen_\d+_hero/i.test(u) || /designboom-large/i.test(u);
  u = u.replace(/_sq-\d+x\d+(?=\.[a-z]+$)/i, '');
  u = u.replace(/[-_]\d+x\d+(?=\.[a-z]+$)/i, '');
  u = u.replace(/_col_sq-\d+x\d+/i, '_col');
  if (!isDezeenFull) {
    u = u.replace(/_dezeen_\d+_col(?=\.[a-z]+$)/i, '_dezeen_hero_col');
    u = u.replace(/_dezeen_\d+_sq(?=\.[a-z]+$)/i, '_dezeen_hero');
  }

  // Designboom embedded sizes. Scoped to Designboom on purpose: other publishers put
  // the original dimensions in the real filename (Dezeen's "..._col_41-1704x1278-1.jpg"),
  // and stripping them there produces a 404 that costs the article its hero image.
  if (/designboom\.com/i.test(u)) {
    u = u.replace(/-700-500x400-/i, '-700-');
    u = u.replace(/-500x400-/i, '-');
    u = u.replace(/-(\d{3,4})x(\d{3,4})-(?=[^/]*\.[a-z]+$)/i, '-');
  }

  // Core77 — lead_400 is part of the real S3 filename, not a downscale suffix
  u = u.replace(/\/thumb\//i, '/');

  if (sourceId?.includes('dezeen') && u.includes('static.dezeen.com') && u.startsWith('http://')) {
    u = u.replace('http://', 'https://');
  }

  if (sourceId?.includes('designboom') && u.includes('designboom.com')) {
    u = u.replace(/-\d{3,4}x\d{3,4}-/gi, '-');
  }

  return u;
}

/** Raw and normalized variants for reachability probes (normalization can break some hosts). */
export function imageUrlCandidates(raw: string, sourceId?: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const normalized = normalizeImageUrl(trimmed, sourceId);
  return [...new Set([trimmed, normalized].filter(Boolean))];
}

export function scoreImageUrl(url: string): number {
  let score = 0;
  const dim = url.match(/(\d{3,4})x(\d{3,4})/);
  if (dim) score += parseInt(dim[1], 10) * parseInt(dim[2], 10);
  if (/2364_col_hero|2364_hero|designboom-large|designboom-1800/i.test(url)) score += 2_000_000;
  if (/hero|full|large|original|master/i.test(url)) score += 500_000;
  if (isSquareCroppedImageUrl(url)) score -= 3_500_000;
  if (/designboom-\d{3,4}-[a-z0-9]{6,}/i.test(url)) score -= 2_500_000;
  if (/thumb|small|sq-\d|500x400|411x411|_sq-|designboom-700-|designboom-500/i.test(url)) score -= 200_000;
  if (/designboom-600|[-_]600\./i.test(url)) score -= 150_000;
  return score;
}

export function pickLargestImageUrl(candidates: string[]): string | undefined {
  const normalized = candidates.map((c) => c.trim()).filter(Boolean);
  if (normalized.length === 0) return undefined;

  let best = normalized[0];
  let bestScore = scoreImageUrl(best);

  for (let i = 1; i < normalized.length; i++) {
    const n = normalized[i];
    const score = scoreImageUrl(n);
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/** Pick the higher-scoring of two URLs after normalization. */
export function pickBetterImageUrl(
  current: string | undefined,
  candidate: string | undefined,
  sourceId?: string,
): string | undefined {
  const candidates = [current, candidate].filter(Boolean) as string[];
  const normalized = candidates.map((c) => normalizeImageUrl(c, sourceId));
  return pickLargestImageUrl(normalized);
}
