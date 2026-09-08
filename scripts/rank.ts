import type { DigestArticle, RawArticle, ScoredArticle, SourcesFile } from './types.js';
import { getLlmConfig, type LlmConfig } from './llm-config.js';
import { loadFeedbackWeightsMerged } from './feedback-supabase.js';
import { formatRecentForLlm, type RecentStory } from './recent-digests.js';

const CURATION_SYSTEM = `You curate "Daily Three: Auto & Product Design" for an industrial product designer.
Pick exactly 3 articles. Prioritize: new model debuts, concept cars, CMF. Penalize: racing, celebrity.
Output JSON only:
{
  "leadJa": "2 sentences in Japanese, editorial tone",
  "leadEn": "2 sentences in English, editorial tone (write as native English, not a translation of leadJa)",
  "picks": [
    {
      "index": number,
      "titleJa": "...",
      "summaryJa": "3-5 lines Japanese with designer lens",
      "titleEn": "...",
      "summaryEn": "3-5 lines English with designer lens (native English, not translated from summaryJa)",
      "reason": "one line"
    }
  ]
}
Exactly 3 picks. Flexible car vs product ratio by quality.
Every pick must carry all four of titleJa, summaryJa, titleEn and summaryEn, each non-empty. Never omit one or leave it blank.
If the user message lists recently covered stories, do not pick the same news event again (including follow-ups or another outlet on the same product launch).`;

/** Job-listing titles often use "Designer – City" (legacy Form Trends-style feeds). */
export function jobListingTitlePenalty(title: string): number {
  if (/\bdesigner\s*[–-]\s*[A-Za-z]/i.test(title)) return 8;
  if (/\b(senior|junior|lead|principal|graduate)\s+.{0,48}\bdesigner\b/i.test(title) && !/\bconcept\b/i.test(title)) {
    return 8;
  }
  return 0;
}

export function ruleScore(articles: RawArticle[], config: SourcesFile, sourceWeights: Record<string, number>): ScoredArticle[] {
  const text = (a: RawArticle) => `${a.title} ${a.summary}`.toLowerCase();

  return articles
    .map((a) => {
      let score = (sourceWeights[a.sourceId] ?? 1) * 10;
      const t = text(a);

      score -= jobListingTitlePenalty(a.title);

      for (const kw of config.scoring.boost_keywords) {
        if (t.includes(kw.toLowerCase())) score += 3;
      }
      for (const kw of config.scoring.penalty_keywords) {
        if (t.includes(kw.toLowerCase())) score -= 8;
      }
      for (const kw of config.scoring.low_priority_keywords) {
        if (t.includes(kw.toLowerCase())) score -= 4;
      }

      const hours = (Date.now() - a.publishedAt.getTime()) / 3600000;
      if (hours < 12) score += 4;
      else if (hours < 24) score += 2;

      if (a.category === 'automotive') score += 2;

      return { ...a, score };
    })
    .sort((a, b) => b.score - a.score);
}

export async function loadFeedbackWeights(): Promise<Record<string, number>> {
  return loadFeedbackWeightsMerged();
}

export function buildSourceWeights(sources: SourcesFile['sources'], feedback: Record<string, number>) {
  const w: Record<string, number> = {};
  for (const s of sources) {
    w[s.id] = Math.max(0.3, Math.min(2.5, s.weight * (feedback[s.id] ?? 1)));
  }
  return w;
}

function buildPayload(top: ScoredArticle[]) {
  return top.map((a, i) => ({
    index: i,
    title: a.title,
    summary: a.summary.slice(0, 280),
    source: a.sourceName,
    url: a.url,
    category: a.category,
    score: a.score,
  }));
}

type LlmPick = {
  index: number;
  titleJa: string;
  summaryJa: string;
  titleEn: string;
  summaryEn: string;
};

type LlmJson = { leadJa: string; leadEn: string; picks: LlmPick[] };

export type DigestLocaleBundle = { lead: string; articles: DigestArticle[] };

export type BilingualDigest = { ja: DigestLocaleBundle; en: DigestLocaleBundle };

function mapPicks(top: ScoredArticle[], parsed: LlmJson, locale: 'ja' | 'en'): DigestLocaleBundle {
  const lead = locale === 'ja' ? parsed.leadJa : parsed.leadEn;
  const articles: DigestArticle[] = parsed.picks.slice(0, 3).map((p) => {
    const src = top[p.index];
    if (!src) throw new Error(`Invalid pick index: ${p.index}`);
    return {
      title: locale === 'ja' ? p.titleJa : p.titleEn,
      summary: locale === 'ja' ? p.summaryJa : p.summaryEn,
      source: src.sourceName,
      sourceId: src.sourceId,
      url: src.url,
      image: src.image,
    };
  });
  return { lead, articles };
}

function mapBilingualPicks(top: ScoredArticle[], parsed: LlmJson): BilingualDigest {
  return {
    ja: mapPicks(top, parsed, 'ja'),
    en: mapPicks(top, parsed, 'en'),
  };
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

/** Names the exact gap, so the log says what broke and a retry can quote it back. */
export function validationProblem(parsed: LlmJson): string | null {
  if (!parsed.leadJa?.trim()) return 'leadJa is missing or empty';
  if (!parsed.leadEn?.trim()) return 'leadEn is missing or empty';
  if (!Array.isArray(parsed.picks)) return 'picks is not an array';
  if (parsed.picks.length === 0) return 'picks is empty';

  const required = ['titleJa', 'summaryJa', 'titleEn', 'summaryEn'] as const;
  for (const [i, pick] of parsed.picks.slice(0, 3).entries()) {
    for (const field of required) {
      if (!pick?.[field]?.trim()) return `picks[${i}].${field} is missing or empty`;
    }
  }
  return null;
}

export function parseLlmJson(raw: string, top: ScoredArticle[]): BilingualDigest {
  const parsed = JSON.parse(extractJson(raw)) as LlmJson;
  const problem = validationProblem(parsed);
  if (problem) throw new Error(`Anthropic response invalid: ${problem}`);
  return mapBilingualPicks(top, parsed);
}

/** Haiku drops a field or runs long often enough that one shot is not a schedule. */
const MAX_PICK_ATTEMPTS = 3;

const CURATION_SYSTEM_JSON_ONLY = `${CURATION_SYSTEM}
Respond with JSON only, no markdown fences.`;

export type PickMessage = { role: 'user' | 'assistant'; content: string };
export type ModelReply = { text: string; stopReason: string | null };
export type ModelCall = (messages: PickMessage[]) => Promise<ModelReply>;

async function anthropicCall(config: LlmConfig): Promise<ModelCall> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return async (messages) => {
    const res = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 4096,
      temperature: 0.4,
      system: CURATION_SYSTEM_JSON_ONLY,
      messages,
    });
    const block = res.content.find((b) => b.type === 'text');
    return { text: block?.type === 'text' ? block.text : '', stopReason: res.stop_reason };
  };
}

/**
 * Ask again when the model returns something unusable, quoting the exact gap back at it.
 * One malformed field used to lose the whole edition.
 */
export async function pickWithRetry(
  top: ScoredArticle[],
  recent: RecentStory[],
  call: ModelCall,
): Promise<BilingualDigest> {
  const messages: PickMessage[] = [
    { role: 'user', content: JSON.stringify(buildPayload(top)) + formatRecentForLlm(recent) },
  ];

  let lastError = new Error('Anthropic pick never ran');

  for (let attempt = 1; attempt <= MAX_PICK_ATTEMPTS; attempt++) {
    const reply = await call(messages);

    try {
      if (!reply.text) throw new Error('Anthropic returned empty response');
      return parseLlmJson(reply.text, top);
    } catch (e) {
      const why =
        reply.stopReason === 'max_tokens'
          ? `${(e as Error).message} (response was cut off at max_tokens)`
          : (e as Error).message;
      lastError = new Error(why);
      console.warn(`[rank] attempt ${attempt}/${MAX_PICK_ATTEMPTS} unusable: ${why}`);
      console.warn(`[rank] raw response (first 800 chars): ${reply.text.slice(0, 800)}`);
      if (attempt === MAX_PICK_ATTEMPTS) break;

      messages.push(
        { role: 'assistant', content: reply.text || '(empty response)' },
        {
          role: 'user',
          content: `That response was unusable: ${why}. Send the whole JSON object again, complete and valid, with every field of every pick filled in. JSON only.`,
        },
      );
    }
  }

  throw lastError;
}

async function pickWithAnthropic(
  top: ScoredArticle[],
  config: LlmConfig,
  recent: RecentStory[],
): Promise<BilingualDigest> {
  return pickWithRetry(top, recent, await anthropicCall(config));
}

/** Pick top 3 with ja+en summaries (one Anthropic call). Requires ANTHROPIC_API_KEY. */
export async function pickTop3Bilingual(
  candidates: ScoredArticle[],
  config: LlmConfig = getLlmConfig(),
  recent: RecentStory[] = [],
): Promise<BilingualDigest> {
  const top = candidates.slice(0, 20);
  if (top.length === 0) {
    return {
      ja: { lead: '本日は候補がありませんでした。', articles: [] },
      en: { lead: 'No candidates today.', articles: [] },
    };
  }
  return pickWithAnthropic(top, config, recent);
}

/** @deprecated Use pickTop3Bilingual */
export async function pickTop3(
  candidates: ScoredArticle[],
  config: LlmConfig = getLlmConfig(),
): Promise<DigestLocaleBundle> {
  const { ja } = await pickTop3Bilingual(candidates, config);
  return ja;
}
