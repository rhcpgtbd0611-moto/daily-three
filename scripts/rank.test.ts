import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jobListingTitlePenalty,
  parseLlmJson,
  pickWithRetry,
  ruleScore,
  validationProblem,
} from './rank.js';
import type { ModelCall, PickMessage } from './rank.js';
import type { RawArticle, SourcesFile } from './types.js';

const baseArticle = (overrides: Partial<RawArticle>): RawArticle => ({
  id: '1',
  title: 'Concept car reveal',
  summary: 'New model debut at studio',
  url: 'https://example.com/a',
  publishedAt: new Date(),
  sourceId: 'car-body-design',
  sourceName: 'Car Body Design',
  category: 'automotive',
  ...overrides,
});

const scoringConfig: SourcesFile = {
  sources: [],
  scoring: {
    boost_keywords: ['concept'],
    penalty_keywords: ['hiring', 'vacancy'],
    low_priority_keywords: [],
  },
};

test('jobListingTitlePenalty hits location-style designer listings', () => {
  assert.equal(jobListingTitlePenalty('Exterior Designer – Gothenburg, Sweden'), 8);
  assert.equal(jobListingTitlePenalty('Senior Colour Designer'), 8);
  assert.equal(jobListingTitlePenalty('Ferrari Amalfi Spider design story'), 0);
});

test('ruleScore applies recruitment keywords from sources.yaml', () => {
  const scored = ruleScore(
    [baseArticle({ title: 'Studio hiring: exterior designer', summary: 'vacancy open' })],
    scoringConfig,
    { 'car-body-design': 1 },
  );
  assert.ok(scored[0].score < 10);
});

const scored = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ...baseArticle({ id: String(i), url: `https://example.com/${i}` }),
    score: 10 - i,
  }));

const goodPick = (i: number) => ({
  index: i,
  titleJa: `見出し${i}`,
  summaryJa: `要約${i}`,
  titleEn: `Title ${i}`,
  summaryEn: `Summary ${i}`,
});

const goodJson = () =>
  JSON.stringify({
    leadJa: 'リード文。',
    leadEn: 'Lead sentence.',
    picks: [goodPick(0), goodPick(1), goodPick(2)],
  });

test('parseLlmJson maps a complete bilingual response', () => {
  const digest = parseLlmJson(goodJson(), scored(3));
  assert.equal(digest.ja.articles.length, 3);
  assert.equal(digest.ja.articles[0].title, '見出し0');
  assert.equal(digest.en.articles[0].title, 'Title 0');
});

test('validationProblem names the pick and field that is missing', () => {
  const parsed = JSON.parse(goodJson());
  delete parsed.picks[1].summaryEn;
  assert.equal(validationProblem(parsed), 'picks[1].summaryEn is missing or empty');
});

test('validationProblem rejects a field the model left blank', () => {
  const parsed = JSON.parse(goodJson());
  parsed.picks[2].titleJa = '   ';
  assert.equal(validationProblem(parsed), 'picks[2].titleJa is missing or empty');
});

test('validationProblem rejects a response with no picks', () => {
  const parsed = JSON.parse(goodJson());
  parsed.picks = [];
  assert.equal(validationProblem(parsed), 'picks is empty');
});

test('validationProblem passes a complete response', () => {
  assert.equal(validationProblem(JSON.parse(goodJson())), null);
});

/** Replays canned model replies and records what it was asked. */
function fakeModel(replies: { text: string; stopReason?: string | null }[]) {
  const seen: PickMessage[][] = [];
  let i = 0;
  const call: ModelCall = async (messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    const r = replies[Math.min(i++, replies.length - 1)];
    return { text: r.text, stopReason: r.stopReason ?? 'end_turn' };
  };
  return { call, seen, calls: () => i };
}

test('pickWithRetry asks again when a pick is missing an English field', async () => {
  const broken = JSON.parse(goodJson());
  delete broken.picks[1].summaryEn;
  const model = fakeModel([{ text: JSON.stringify(broken) }, { text: goodJson() }]);

  const digest = await pickWithRetry(scored(3), [], model.call);

  assert.equal(model.calls(), 2);
  assert.equal(digest.en.articles[1].summary, 'Summary 1');
  const retryPrompt = model.seen[1].at(-1);
  assert.equal(retryPrompt?.role, 'user');
  assert.ok(retryPrompt?.content.includes('picks[1].summaryEn is missing or empty'));
});

test('pickWithRetry recovers from a truncated response and says so', async () => {
  const model = fakeModel([
    { text: goodJson().slice(0, 60), stopReason: 'max_tokens' },
    { text: goodJson() },
  ]);

  const digest = await pickWithRetry(scored(3), [], model.call);

  assert.equal(digest.ja.articles.length, 3);
  assert.ok(model.seen[1].at(-1)?.content.includes('cut off at max_tokens'));
});

test('pickWithRetry gives up after three attempts', async () => {
  const model = fakeModel([{ text: '{"leadJa":"x"}' }]);

  await assert.rejects(() => pickWithRetry(scored(3), [], model.call), /leadEn is missing or empty/);
  assert.equal(model.calls(), 3);
});
