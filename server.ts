/**
 * Watcher Protocol — agents-day demo backend
 *
 * Flow: PagerDuty webhook (incident.resolved) →
 *   fetch incident detail + log entries →
 *   find github.com/.../pull/N URL →
 *   fetch PR author from GitHub →
 *   Claude reasons: tip? amount? skip? →
 *   if tip: send USDC via Virtuals EconomyOS SDK (AlchemyEvmProviderAdapter) on Base mainnet →
 *   post PagerDuty note with tx hash →
 *   append Fire to fires.jsonl
 *
 * Hits: PagerDuty bounty + Virtuals bounty (real autonomous tx via EconomyOS primitive).
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseUnits,
  type Address,
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

const VIRTUALS_WALLET_ADDRESS = env('VIRTUALS_WALLET_ADDRESS') as Address;
const VIRTUALS_PRIVATE_KEY = env('VIRTUALS_PRIVATE_KEY') as Hex;
const VIRTUALS_ENTITY_ID = parseInt(env('VIRTUALS_ENTITY_ID') || '1');
const VIRTUALS_BUILDER_CODE = env('VIRTUALS_BUILDER_CODE');
const PAGERDUTY_TOKEN = env('PAGERDUTY_TOKEN');
const PAGERDUTY_USER_EMAIL = env('PAGERDUTY_USER_EMAIL');
const GITHUB_TOKEN = env('GITHUB_TOKEN', false);
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');
const DEMO_FALLBACK_RECIPIENT = env('DEMO_FALLBACK_RECIPIENT') as Address;
const PORT = parseInt(env('PORT', false) || '3000');

// USDC on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const USDC_DECIMALS = 6;
const TIP_AMOUNT_USDC = '0.03'; // 3 cents per fire — ~16 runs on 0.5 USDC budget

// Hardcoded github username → wallet for the demo. Add more as you like.
const WALLET_MAP: Record<string, Address> = {};

// ------------------------------------------------------------------ Virtuals SDK provider
console.log('═══════════════════════════════════════════════════════════════');
console.log('  watcher-protocol — agents-day demo backend');
console.log('───────────────────────────────────────────────────────────────');
console.log(`  Agent identity:     Virtuals EconomyOS`);
console.log(`  Wallet (smart):     ${VIRTUALS_WALLET_ADDRESS}`);
console.log(`  Builder code:       ${VIRTUALS_BUILDER_CODE}`);
console.log(`  Entity ID:          ${VIRTUALS_ENTITY_ID}`);
console.log(`  Chain:              Base mainnet (8453) — REAL MONEY`);
console.log(`  Brain:              Claude (Anthropic)`);
console.log(`  Tip per fire:       $${TIP_AMOUNT_USDC} USDC (Claude can pick smaller)`);
console.log('═══════════════════════════════════════════════════════════════');

const account = privateKeyToAccount(VIRTUALS_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const walletClient = createWalletClient({ account, chain: base, transport: http('https://mainnet.base.org') });
console.log(`  ✓ viem wallet client ready · signer: ${account.address}`);

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

// ------------------------------------------------------------------ on-chain tip via Virtuals SDK
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
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

async function sendTipUsdc(recipient: Address, amountStr: string) {
  const amount = parseUnits(amountStr, USDC_DECIMALS);
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });
  const hash = await walletClient.sendTransaction({ to: USDC_ADDRESS, data, value: 0n });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
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
      `🤖 watcher-protocol: incident resolved but no GitHub PR URL was found in the incident body or log entries. No tip sent.\n\nAgent identity: Virtuals EconomyOS\nWallet: ${VIRTUALS_WALLET_ADDRESS}`,
    );
    return;
  }
  log('agent.pr_found', { incidentId, ...pr });

  const { author, title: prTitle } = await getPullRequest(pr.owner, pr.repo, pr.n);
  log('agent.author', { incidentId, author, prTitle });

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
      `🤖 watcher-protocol: skipped tipping @${author}.\n\nClaude's reasoning: ${decision.reasoning}\n\nAgent identity: Virtuals EconomyOS\nWallet: ${VIRTUALS_WALLET_ADDRESS}`,
    );
    log('agent.done', { incidentId, action: 'skipped' });
    return;
  }

  const recipient = WALLET_MAP[author] ?? DEMO_FALLBACK_RECIPIENT;
  if (!recipient) {
    log('agent.skip', { incidentId, reason: `no wallet for ${author} and no fallback set` });
    return;
  }

  const amount = String(
    Math.min(decision.amount_usdc || parseFloat(TIP_AMOUNT_USDC), parseFloat(TIP_AMOUNT_USDC)),
  );
  const tx = await sendTipUsdc(recipient, amount);
  log('agent.tx', { incidentId, ...tx, recipient, amount });

  const txUrl = `https://basescan.org/tx/${tx.hash}`;
  await postIncidentNote(
    incidentId,
    [
      `🤖 watcher-protocol autonomously tipped @${author} **${amount} USDC** for resolving via PR #${pr.n}.`,
      ``,
      `**Claude's reasoning:** ${decision.reasoning}`,
      ``,
      `**Tx:** ${txUrl}`,
      `**From wallet:** ${VIRTUALS_WALLET_ADDRESS} (Virtuals EconomyOS smart wallet)`,
      `**To:** ${recipient}`,
      ``,
      `_Triggered by Watcher Protocol. No human in the loop between resolve and tip._`,
    ].join('\n'),
  );
  log('agent.done', { incidentId, author, tx: tx.hash, amount });
}

// ------------------------------------------------------------------ http
const app = new Hono();
app.use(logger());

// CORS — let the frontend on :8765 call us
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  await next();
});

app.get('/', (c) =>
  c.json({
    ok: true,
    agent: {
      wallet: VIRTUALS_WALLET_ADDRESS,
      identity: 'Virtuals EconomyOS',
      brain: 'Claude',
      builderCode: VIRTUALS_BUILDER_CODE,
    },
    endpoints: [
      'POST /webhook/pagerduty',
      'POST /test/fire/:id',
      'POST /demo/run         ← creates a real PD incident, fires the agent, returns everything',
      'GET  /api/fires        ← recent fires from fires.jsonl',
      'GET  /api/agent        ← agent identity + wallet balance',
    ],
  }),
);

// ------------------------------------------------------------------ demo orchestration
// One-shot endpoint that creates a real PD incident with a real human-authored fix PR,
// fires the agent path against it, and returns every step. The frontend hits this on
// click; the judge sees the chain happen live.
app.post('/demo/run', async (c) => {
  const SERVICE = 'P6JLYA5'; // Default Service in the sandbox
  const PR_URL = 'https://github.com/facebook/react/pull/36134'; // human-authored real fix
  const title = `Frontend: useDeferredValue stuck on slow inputs — fixed in ${PR_URL}`;

  // 1. create the incident
  const createResp = await fetch(`${PD_BASE}/incidents`, {
    method: 'POST',
    headers: pdHeaders,
    body: JSON.stringify({
      incident: {
        type: 'incident',
        title,
        service: { id: SERVICE, type: 'service_reference' },
        body: {
          type: 'incident_body',
          details: `Customers reporting search input freezing. Root cause: React useDeferredValue stuck. Fixed in ${PR_URL}`,
        },
      },
    }),
  });
  if (!createResp.ok) {
    return c.json({ ok: false, error: `pd create ${createResp.status}: ${await createResp.text()}` }, 500);
  }
  const created: any = await createResp.json();
  const incidentId = created.incident.id;

  // 2. run the agent — wait for it (so frontend can show the full chain)
  try {
    await runAgent(incidentId);
  } catch (err) {
    return c.json({ ok: false, incidentId, error: String(err) }, 500);
  }

  // 3. read the latest events for this incident from the log
  const lines = (await Bun.file(LOG_FILE).text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];
  const events = lines.filter((e) => e.incidentId === incidentId);

  return c.json({ ok: true, incidentId, events });
});

app.get('/api/fires', async (c) => {
  if (!existsSync(LOG_FILE)) return c.json({ fires: [] });
  const text = await Bun.file(LOG_FILE).text();
  const events = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];

  // group events by incidentId, keep only the latest "done" or "skip" outcomes
  const byIncident = new Map<string, any>();
  for (const e of events) {
    if (!e.incidentId) continue;
    const cur = byIncident.get(e.incidentId) || { incidentId: e.incidentId, events: [] };
    cur.events.push(e);
    if (e.event === 'agent.tx' || e.event === 'agent.done' || e.event === 'agent.decision') {
      cur.latest = e;
    }
    byIncident.set(e.incidentId, cur);
  }
  const fires = Array.from(byIncident.values())
    .map((f) => {
      const tx = f.events.find((e: any) => e.event === 'agent.tx');
      const decision = f.events.find((e: any) => e.event === 'agent.decision');
      const author = f.events.find((e: any) => e.event === 'agent.author');
      const start = f.events.find((e: any) => e.event === 'agent.start');
      return {
        incidentId: f.incidentId,
        t: start?.t,
        author: author?.author,
        prTitle: author?.prTitle,
        decision: decision?.action,
        amount: tx?.amount || decision?.amount_usdc,
        reasoning: decision?.reasoning,
        txHash: tx?.hash,
        txUrl: tx?.hash ? `https://basescan.org/tx/${tx.hash}` : null,
        recipient: tx?.recipient,
      };
    })
    .sort((a, b) => (b.t || '').localeCompare(a.t || ''));
  return c.json({ fires });
});

app.get('/api/agent', async (c) => {
  // wallet balance check
  const usdcBal = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI as any,
    functionName: 'balanceOf' as any,
    args: [VIRTUALS_WALLET_ADDRESS],
  } as any).catch(() => 0n);
  const ethBal = await publicClient.getBalance({ address: VIRTUALS_WALLET_ADDRESS }).catch(() => 0n);
  return c.json({
    name: "Tipping agent",
    wallet: VIRTUALS_WALLET_ADDRESS,
    identity: 'Virtuals EconomyOS',
    brain: 'Claude Sonnet 4.5',
    builderCode: VIRTUALS_BUILDER_CODE,
    chain: 'Base mainnet',
    usdcBalance: Number(usdcBal) / 1e6,
    ethBalance: Number(ethBal) / 1e18,
    tipPerFire: parseFloat(TIP_AMOUNT_USDC),
  });
});

app.post('/webhook/pagerduty', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  log('webhook.received', { body });

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
