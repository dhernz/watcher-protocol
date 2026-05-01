/**
 * Watcher — agents-day demo backend
 *
 * Flow: PagerDuty webhook (incident.resolved) →
 *   fetch incident detail + log entries →
 *   find github.com/.../pull/N URL →
 *   fetch PR author from GitHub →
 *   Claude reasons: tip? amount? skip? →
 *   if tip: send USDC from agent's EconomyOS-provisioned wallet via viem →
 *   post PagerDuty note with tx hash →
 *   append Fire to fires.jsonl
 *
 * Hits: PagerDuty bounty (incident lifecycle, REST writeback) +
 *       Virtuals bounty (real autonomous tx from agent's own wallet, Claude as brain).
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { writeFileSync, appendFileSync, existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

// ------------------------------------------------------------------ env
const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) throw new Error(`missing env var: ${k}`);
  return v ?? '';
};

const PAGERDUTY_TOKEN = env('PAGERDUTY_TOKEN');
const PAGERDUTY_USER_EMAIL = env('PAGERDUTY_USER_EMAIL');
const GITHUB_TOKEN = env('GITHUB_TOKEN', false);
const AGENT_PRIVATE_KEY = env('AGENT_PRIVATE_KEY') as Hex;
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');
const RPC_URL = env('RPC_URL', false) || 'https://mainnet.base.org';
const DEMO_FALLBACK_RECIPIENT = env('DEMO_FALLBACK_RECIPIENT') as Hex;
const VIRTUALS_BUILDER_CODE = env('VIRTUALS_BUILDER_CODE', false);
const PORT = parseInt(env('PORT', false) || '3000');

// USDC on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex;
const USDC_DECIMALS = 6;
const TIP_AMOUNT_USDC = '1'; // $1 cap on mainnet to keep demo cost low; Claude can decide smaller

// Hardcoded github username → wallet for the demo. Add more as you like.
const WALLET_MAP: Record<string, Hex> = {
  // 'sasha-dev': '0x...',
};

// ------------------------------------------------------------------ chain
const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Watcher — agents-day demo backend');
console.log('───────────────────────────────────────────────────────────────');
console.log(`  Agent identity:  Virtuals EconomyOS`);
console.log(`  Wallet address:  ${account.address}`);
console.log(`  Builder code:    ${VIRTUALS_BUILDER_CODE || '(not set)'}`);
console.log(`  Chain:           Base mainnet (8453) — REAL MONEY`);
console.log(`  Brain:           Claude (Anthropic)`);
console.log('═══════════════════════════════════════════════════════════════');

// ------------------------------------------------------------------ Claude
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

interface AgentDecision {
  action: 'tip' | 'skip';
  amount_usdc?: number;
  reasoning: string;
}

async function decideTip(input: {
  incidentTitle: string;
  incidentSummary: string;
  prTitle: string;
  prAuthor: string;
  maxAmount: number;
}): Promise<AgentDecision> {
  const prompt = `You are an autonomous tipping agent. A PagerDuty incident was resolved by a contributor's pull request. Decide whether to tip them in USDC and how much.

INCIDENT:
- Title: ${input.incidentTitle}
- Summary: ${input.incidentSummary}

PULL REQUEST:
- Title: ${input.prTitle}
- Author: @${input.prAuthor}

CONSTRAINTS:
- Max tip per fire: $${input.maxAmount} USDC
- You may tip the full amount, a smaller amount, or skip entirely.

Respond with a single JSON object on one line, no prose, no markdown fences:
{"action":"tip|skip","amount_usdc":NUMBER,"reasoning":"one sentence"}`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content[0] as any).text.trim();
  // strip markdown fences if Claude added them despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      action: parsed.action === 'tip' ? 'tip' : 'skip',
      amount_usdc: typeof parsed.amount_usdc === 'number' ? parsed.amount_usdc : 0,
      reasoning: String(parsed.reasoning || '').slice(0, 280),
    };
  } catch (err) {
    return {
      action: 'skip',
      reasoning: `Claude returned unparseable response: ${text.slice(0, 120)}`,
    };
  }
}

// ------------------------------------------------------------------ logging
const LOG_FILE = './fires.jsonl';
const log = (event: string, data: any) => {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n';
  process.stdout.write(line);
  appendFileSync(LOG_FILE, line);
};

// ------------------------------------------------------------------ pagerduty rest
const PD_BASE = 'https://api.pagerduty.com';
const pdHeaders = {
  Accept: 'application/vnd.pagerduty+json;version=2',
  Authorization: `Token token=${PAGERDUTY_TOKEN}`,
  'Content-Type': 'application/json',
  From: PAGERDUTY_USER_EMAIL,
};

async function getIncident(id: string) {
  const r = await fetch(`${PD_BASE}/incidents/${id}`, { headers: pdHeaders });
  if (!r.ok) throw new Error(`pd getIncident ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.incident;
}

async function getIncidentLogEntries(id: string) {
  const r = await fetch(`${PD_BASE}/incidents/${id}/log_entries?include[]=channels`, {
    headers: pdHeaders,
  });
  if (!r.ok) throw new Error(`pd logEntries ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.log_entries as any[];
}

async function postIncidentNote(id: string, content: string) {
  const r = await fetch(`${PD_BASE}/incidents/${id}/notes`, {
    method: 'POST',
    headers: pdHeaders,
    body: JSON.stringify({ note: { content } }),
  });
  if (!r.ok) throw new Error(`pd postNote ${r.status}: ${await r.text()}`);
  return r.json();
}

// ------------------------------------------------------------------ github
async function getPullRequest(owner: string, repo: string, n: string) {
  const headers: any = { Accept: 'application/vnd.github+json' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}`, { headers });
  if (!r.ok) throw new Error(`github getPR ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return { author: j.user.login as string, title: j.title as string };
}

// ------------------------------------------------------------------ on-chain tip
const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

async function sendTipUsdc(recipient: Hex, amountStr: string) {
  const amount = parseUnits(amountStr, USDC_DECIMALS);
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient, amount] });
  const hash = await walletClient.sendTransaction({ to: USDC_ADDRESS, data, value: 0n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status };
}

// ------------------------------------------------------------------ extraction
const PR_URL_RE = /github\.com\/([^\/\s"'<>]+)\/([^\/\s"'<>]+)\/pull\/(\d+)/i;

function findPrUrl(text: string): { owner: string; repo: string; n: string } | null {
  if (!text) return null;
  const m = text.match(PR_URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], n: m[3] };
}

async function extractPrFromIncident(incidentId: string) {
  const inc = await getIncident(incidentId);
  let pr =
    findPrUrl(inc.title || '') ||
    findPrUrl(inc.summary || '') ||
    findPrUrl(inc?.body?.details || '') ||
    findPrUrl(JSON.stringify(inc));
  if (pr) return { incident: inc, pr };

  const entries = await getIncidentLogEntries(incidentId);
  for (const e of entries) {
    const blob = JSON.stringify(e);
    const found = findPrUrl(blob);
    if (found) return { incident: inc, pr: found };
  }
  return { incident: inc, pr: null };
}

// ------------------------------------------------------------------ agent
async function runAgent(incidentId: string) {
  log('agent.start', { incidentId });

  const { incident, pr } = await extractPrFromIncident(incidentId);
  if (!pr) {
    log('agent.skip', { incidentId, reason: 'no PR url found' });
    await postIncidentNote(
      incidentId,
      `🤖 watcher-agent: incident resolved but no GitHub PR URL was found in the incident body or log entries. No tip sent.\n\nAgent identity: Virtuals EconomyOS\nWallet: ${account.address}`,
    );
    return;
  }
  log('agent.pr_found', { incidentId, ...pr });

  const { author, title: prTitle } = await getPullRequest(pr.owner, pr.repo, pr.n);
  log('agent.author', { incidentId, author, prTitle });

  // Claude reasoning step — the brain
  const decision = await decideTip({
    incidentTitle: incident.title || '',
    incidentSummary: incident.summary || incident?.body?.details || '',
    prTitle,
    prAuthor: author,
    maxAmount: parseFloat(TIP_AMOUNT_USDC),
  });
  log('agent.decision', { incidentId, ...decision });

  if (decision.action === 'skip') {
    await postIncidentNote(
      incidentId,
      `🤖 watcher-agent: skipped tipping @${author}.\n\nClaude's reasoning: ${decision.reasoning}\n\nAgent identity: Virtuals EconomyOS\nWallet: ${account.address}`,
    );
    log('agent.done', { incidentId, action: 'skipped' });
    return;
  }

  const recipient = WALLET_MAP[author] ?? DEMO_FALLBACK_RECIPIENT;
  if (!recipient) {
    log('agent.skip', { incidentId, reason: `no wallet for ${author} and no fallback set` });
    return;
  }

  const amount = String(Math.min(decision.amount_usdc || parseFloat(TIP_AMOUNT_USDC), parseFloat(TIP_AMOUNT_USDC)));
  const tx = await sendTipUsdc(recipient, amount);
  log('agent.tx', { incidentId, ...tx, recipient, amount });

  const txUrl = `https://basescan.org/tx/${tx.hash}`;
  await postIncidentNote(
    incidentId,
    [
      `🤖 watcher-agent autonomously tipped @${author} **${amount} USDC** for resolving via PR #${pr.n}.`,
      ``,
      `**Claude's reasoning:** ${decision.reasoning}`,
      ``,
      `**Tx:** ${txUrl}`,
      `**From wallet:** ${account.address} (provisioned via Virtuals EconomyOS)`,
      `**To:** ${recipient}`,
      ``,
      `_Triggered by Watcher. No human in the loop between resolve and tip._`,
    ].join('\n'),
  );
  log('agent.done', { incidentId, author, tx: tx.hash, amount });
}

// ------------------------------------------------------------------ http
const app = new Hono();
app.use(logger());

app.get('/', (c) =>
  c.json({
    ok: true,
    agent: { wallet: account.address, identity: 'Virtuals EconomyOS', brain: 'Claude' },
    endpoints: ['POST /webhook/pagerduty', 'POST /test/fire/:id'],
  }),
);

app.post('/webhook/pagerduty', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  log('webhook.received', { body });

  // PagerDuty Webhooks v3 payload: { event: { event_type, data: { id, ... } } }
  const event = body?.event;
  if (!event) {
    return c.json({ ok: true, ignored: 'no event field; check log for payload shape' });
  }

  if (event.event_type === 'incident.resolved') {
    const incidentId = event.data?.id;
    if (!incidentId) return c.json({ ok: true, ignored: 'no incident id' });
    runAgent(incidentId).catch((err) => log('agent.error', { incidentId, error: String(err) }));
    return c.json({ ok: true, accepted: incidentId });
  }

  return c.json({ ok: true, ignored: event.event_type });
});

// manual trigger for testing without the webhook wired up
app.post('/test/fire/:id', async (c) => {
  const id = c.req.param('id');
  runAgent(id).catch((err) => log('agent.error', { incidentId: id, error: String(err) }));
  return c.json({ ok: true, fired: id });
});

if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '');
console.log(`[server] http://localhost:${PORT}`);
console.log(`         POST /webhook/pagerduty   ← PagerDuty webhook target`);
console.log(`         POST /test/fire/:id       ← manual trigger by incident id`);
console.log('═══════════════════════════════════════════════════════════════\n');

export default { port: PORT, fetch: app.fetch };
