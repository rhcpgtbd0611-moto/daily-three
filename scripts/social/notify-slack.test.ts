import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSlackPayload, notifySlack, safeImageUrl } from './notify-slack.js';
import type { GateIssue, SocialDraft } from './types.js';

const DRAFT: SocialDraft = {
  digestDate: '2026-09-07',
  articleIndex: 0,
  articleUrl: 'https://www.autoexpress.co.uk/audi/a2/370376/new-audi-a2-e-tron-revealed-2026-pictures',
  digestUrl: 'https://example.test/ja/digest/2026-09-07/',
  source: 'Auto Express',
  pickReason: 'rotation',
  image:
    'https://media.autoexpress.co.uk/image/private/s--X-WVjvBW--/f_auto/v1788518214/autoexpress/2026/09/Audi A2 e-tron 2026-24.jpg',
  jaBody: '本文',
  enBody: 'body',
  jaText: '【Daily Three】9/7(月)\n新型アウディA2 e-tron\n\n本文\n\n出典: Auto Express',
  enText: 'New Audi A2 e-tron\n\nbody\n\nSource: Auto Express',
  replyText: 'https://example.test/ja/digest/2026-09-07/',
};

const NO_ISSUES: GateIssue[] = [];

function imageBlock(payload: ReturnType<typeof buildSlackPayload>) {
  return payload.blocks.find((b) => (b as { type?: string }).type === 'image') as
    | { image_url: string }
    | undefined;
}

test('safeImageUrl percent-encodes spaces publishers leave in image URLs', () => {
  assert.equal(
    safeImageUrl('https://media.example/2026/09/Audi A2 e-tron 2026-24.jpg'),
    'https://media.example/2026/09/Audi%20A2%20e-tron%202026-24.jpg',
  );
});

test('safeImageUrl leaves an already-encoded URL alone', () => {
  const url = 'https://media.example/2026/09/Audi%20A2%20e-tron.jpg';
  assert.equal(safeImageUrl(url), url);
});

test('safeImageUrl drops anything Slack could not fetch', () => {
  assert.equal(safeImageUrl(undefined), undefined);
  assert.equal(safeImageUrl('   '), undefined);
  assert.equal(safeImageUrl('/relative/hero.jpg'), undefined);
  assert.equal(safeImageUrl('ftp://media.example/hero.jpg'), undefined);
});

test('buildSlackPayload emits an encoded image_url', () => {
  const block = imageBlock(buildSlackPayload(DRAFT, NO_ISSUES));
  assert.ok(block);
  assert.ok(!/ /.test(block.image_url), 'image_url must not contain raw spaces');
});

test('buildSlackPayload omits the image block when the URL is unusable', () => {
  const payload = buildSlackPayload({ ...DRAFT, image: 'not a url' }, NO_ISSUES);
  assert.equal(imageBlock(payload), undefined);
});

/** Replace global fetch for one call; returns the bodies Slack was sent. */
function stubSlack(responses: { ok: boolean; status: number; body?: string }[]) {
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const r = responses[Math.min(call++, responses.length - 1)];
    return { ok: r.ok, status: r.status, text: async () => r.body ?? '' };
  }) as unknown as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = original) };
}

test('notifySlack retries without the image when Slack rejects the blocks', async () => {
  const slack = stubSlack([
    { ok: false, status: 400, body: 'invalid_blocks' },
    { ok: true, status: 200 },
  ]);
  try {
    await notifySlack(DRAFT, NO_ISSUES, 'https://hooks.slack.test/x');
  } finally {
    slack.restore();
  }

  assert.equal(slack.sent.length, 2);
  const retry = slack.sent[1] as { blocks: { type: string }[] };
  assert.ok(!retry.blocks.some((b) => b.type === 'image'));
});

test('notifySlack falls back to plain text when blocks keep failing', async () => {
  const slack = stubSlack([
    { ok: false, status: 400, body: 'invalid_blocks' },
    { ok: false, status: 400, body: 'invalid_blocks' },
    { ok: true, status: 200 },
  ]);
  try {
    await notifySlack(DRAFT, NO_ISSUES, 'https://hooks.slack.test/x');
  } finally {
    slack.restore();
  }

  assert.equal(slack.sent.length, 3);
  const plain = slack.sent[2] as { text: string; blocks?: unknown };
  assert.equal(plain.blocks, undefined);
  assert.ok(plain.text.includes(DRAFT.jaText));
  assert.ok(plain.text.includes(DRAFT.enText));
});

test('notifySlack throws when even plain text is rejected', async () => {
  const slack = stubSlack([{ ok: false, status: 500, body: 'server_error' }]);
  try {
    await assert.rejects(
      () => notifySlack(DRAFT, NO_ISSUES, 'https://hooks.slack.test/x'),
      /Slack webhook failed: 500/,
    );
  } finally {
    slack.restore();
  }
});
