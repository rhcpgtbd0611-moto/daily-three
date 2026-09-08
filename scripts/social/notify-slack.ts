import type { GateIssue, SocialDraft } from './types.js';

const PICK_REASON_LABEL: Record<SocialDraft['pickReason'], string> = {
  feedback: 'Good が付いた記事',
  rotation: '曜日ローテーション',
  fallback: '繰り上げ（既出を回避）',
};

/** Prefilled X composer. The 2本目/3本目 are added with the composer's ＋ button. */
export function intentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/**
 * Slack rejects the whole message with `invalid_blocks` when image_url is not a valid
 * URI — publisher URLs with raw spaces (Auto Express) are the usual offender.
 * Percent-encode what can be encoded, drop what cannot.
 */
export function safeImageUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.href.length > 3000) return undefined;
  return url.href;
}

function codeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function section(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function statusOf(issues: GateIssue[]): string {
  return issues.some((i) => i.level === 'error') ? '⚠️ 要修正' : '✅ そのまま投稿可';
}

export function buildSlackPayload(draft: SocialDraft, issues: GateIssue[]) {
  const status = statusOf(issues);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Daily Three 下書き ${draft.digestDate}`, emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${status} ・ ${draft.source} ・ ${draft.articleIndex + 1}件目（${PICK_REASON_LABEL[draft.pickReason]}）`,
        },
      ],
    },
  ];

  const image = safeImageUrl(draft.image);
  if (image) {
    blocks.push({ type: 'image', image_url: image, alt_text: draft.source });
  }

  blocks.push(
    section(`*1本目（日本語）*\n${codeBlock(draft.jaText)}`),
    section(`*2本目（英語スレッド）*\n${codeBlock(draft.enText)}`),
    section(`*3本目（リプライ）*\n${codeBlock(draft.replyText)}`),
    section(
      `🐦 *<${intentUrl(draft.jaText)}|X の下書きを開く>* — 開いたら ＋ で2本目・3本目を足してスレッド投稿\n` +
        `📄 <${draft.digestUrl}|digest ページ> ・ 🔗 <${draft.articleUrl}|元記事>`,
    ),
  );

  if (issues.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: issues
            .map((i) => `${i.level === 'error' ? '🔴' : '🟡'} ${i.code}: ${i.message}`)
            .join('\n'),
        },
      ],
    });
  }

  return {
    text: `Daily Three 下書き ${draft.digestDate}（${status}）`,
    blocks,
  };
}

/** Last resort: no Block Kit at all, so nothing about formatting can reject it. */
export function buildPlainTextPayload(draft: SocialDraft, issues: GateIssue[]) {
  const lines = [
    `Daily Three 下書き ${draft.digestDate}（${statusOf(issues)}）`,
    `${draft.source} ・ ${draft.articleIndex + 1}件目（${PICK_REASON_LABEL[draft.pickReason]}）`,
    '',
    `1本目（日本語）\n${draft.jaText}`,
    '',
    `2本目（英語スレッド）\n${draft.enText}`,
    '',
    `3本目（リプライ）\n${draft.replyText}`,
    '',
    `X の下書き: ${intentUrl(draft.jaText)}`,
    `digest: ${draft.digestUrl}`,
    `元記事: ${draft.articleUrl}`,
  ];

  if (issues.length > 0) {
    lines.push('', ...issues.map((i) => `${i.level === 'error' ? '🔴' : '🟡'} ${i.code}: ${i.message}`));
  }

  return { text: lines.join('\n') };
}

async function post(webhookUrl: string, payload: unknown) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text() };
}

/** Drop the image block — the one block whose content comes from an outside publisher. */
function withoutImage(payload: ReturnType<typeof buildSlackPayload>) {
  return {
    ...payload,
    blocks: payload.blocks.filter((b) => (b as { type?: string }).type !== 'image'),
  };
}

export async function notifySlack(
  draft: SocialDraft,
  issues: GateIssue[],
  webhookUrl = process.env.SLACK_WEBHOOK_URL,
): Promise<void> {
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL is required. Set it in .env or GitHub Secrets.');
  }

  const payload = buildSlackPayload(draft, issues);
  const full = await post(webhookUrl, payload);
  if (full.ok) return;

  // The draft matters more than its decoration: never let one bad block swallow the
  // notification. Step down to a version Slack is more likely to accept.
  console.warn(`[social] Slack rejected the message: ${full.status} ${full.body}`);

  const stripped = withoutImage(payload);
  if (stripped.blocks.length !== payload.blocks.length) {
    const retry = await post(webhookUrl, stripped);
    if (retry.ok) {
      console.warn('[social] Sent without the image block');
      return;
    }
    console.warn(`[social] Slack rejected it without the image too: ${retry.status} ${retry.body}`);
  }

  const plain = await post(webhookUrl, buildPlainTextPayload(draft, issues));
  if (!plain.ok) {
    throw new Error(`Slack webhook failed: ${plain.status} ${plain.body}`);
  }
  console.warn('[social] Sent as plain text');
}
