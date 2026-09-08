import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { collectArticles, markSeen } from './collect.js';
import { buildSourceWeights, loadFeedbackWeights, pickTop3Bilingual, ruleScore } from './rank.js';
import { applyRecentTopicPenalty, loadRecentStories } from './recent-digests.js';
import { filterDuplicateStories } from './story-dedup.js';
import { getLlmConfig } from './llm-config.js';
import {
  digestEditionCalendarDate,
  digestPublishDate,
  isDigestEditionWeekday,
} from './digest-schedule.js';
import { publishDigest } from './publish.js';
import { enrichImages } from './ogp.js';
import type { SourcesFile } from './types.js';
import type { DigestLocaleBundle } from './rank.js';

const dryRun = process.argv.includes('--dry-run');
const forceRun = process.argv.includes('--force');

/** How many times to swap out an article whose hero image cannot be resolved. */
const MAX_IMAGE_REPICKS = 2;

async function main() {
  const now = new Date();
  if (!dryRun && !forceRun && !isDigestEditionWeekday(now)) {
    console.log('[digest] Skipping: weekend edition in Asia/Tokyo (pass --force to override)');
    return;
  }

  const config = parse(readFileSync('sources.yaml', 'utf-8')) as SourcesFile;
  const feedback = await loadFeedbackWeights();
  const sourceWeights = buildSourceWeights(config.sources, feedback);

  console.log('[digest] Collecting…');
  const raw = await collectArticles(config.sources, config.collection);
  console.log(`[digest] ${raw.length} new candidates`);

  const recent = loadRecentStories(7);
  if (recent.length > 0) {
    console.log(`[digest] ${recent.length} recent story(ies) for duplicate avoidance`);
  }

  const penalized = applyRecentTopicPenalty(ruleScore(raw, config, sourceWeights), recent);
  const scored = filterDuplicateStories(penalized, recent);
  console.log(`[digest] ${scored.length} candidates after duplicate filter`);
  const llmConfig = getLlmConfig();
  console.log(`[digest] Picker: anthropic bilingual (model: ${llmConfig.anthropicModel})`);

  // The site needs a hero image per article, but one unreachable image used to cost the
  // whole edition. Drop the offender from the pool and let the picker choose again.
  const unusable = new Set<string>();
  let ja: DigestLocaleBundle | undefined;
  let en: DigestLocaleBundle | undefined;

  for (let round = 0; round <= MAX_IMAGE_REPICKS; round++) {
    const pool = scored.filter((a) => !unusable.has(a.url));
    ({ ja, en } = await pickTop3Bilingual(pool, llmConfig, recent));

    if (ja.articles.length === 0) {
      console.log('[digest] No articles to publish');
      return;
    }

    await enrichImages(ja.articles);
    for (let i = 0; i < en.articles.length; i++) {
      en.articles[i].image = ja.articles[i]?.image;
      en.articles[i].images = ja.articles[i]?.images;
      en.articles[i].video = ja.articles[i]?.video;
    }
    for (const a of ja.articles) {
      const n = a.images?.length ?? (a.image ? 1 : 0);
      console.log(`[digest] media ${a.sourceId}: ${n} image(s)${a.image ? '' : ' — MISSING'}`);
    }

    const missingImages = ja.articles.filter((a) => !a.image);
    if (missingImages.length === 0) break;

    for (const a of missingImages) {
      console.warn(`[digest] no reachable hero image: ${a.title} (${a.url})`);
      unusable.add(a.url);
    }

    if (round === MAX_IMAGE_REPICKS) {
      const titles = missingImages.map((a) => a.title).join('; ');
      throw new Error(
        `[digest] still no reachable hero image after ${MAX_IMAGE_REPICKS} re-pick(s): ${titles}`,
      );
    }
    console.warn(`[digest] re-picking without ${unusable.size} article(s) that have no image`);
  }

  if (!ja || !en) throw new Error('[digest] Picker produced no result');

  const edition = digestEditionCalendarDate(now);
  const publishDate = digestPublishDate(now);
  console.log(`[digest] Edition date (JST): ${edition}`);

  if (dryRun) {
    console.log(JSON.stringify({ ja, en }, null, 2));
    return;
  }

  const pathJa = publishDigest(publishDate, 'ja', ja.lead, ja.articles);
  console.log('[digest] Wrote', pathJa);

  if (en.articles.length === 3 && en.lead?.trim()) {
    try {
      const pathEn = publishDigest(publishDate, 'en', en.lead, en.articles);
      console.log('[digest] Wrote', pathEn);
    } catch (e) {
      console.warn('[digest] English publish skipped:', e);
    }
  } else {
    console.warn('[digest] English publish skipped (incomplete en content)');
  }

  markSeen(ja.articles.map((a) => a.url));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
