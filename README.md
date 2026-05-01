# awake

> Watchers keep your agent awake.

Eyes for AI agents. **awake** listens for signals from the services you already use, then wakes your agent the moment something changes — so the agent can act before you'd even open your laptop.

Built for the talent.app **agents-day** hackathon. Targets the **PagerDuty** + **Virtuals (EconomyOS)** + **Tripadvisor (Viator)** bounties.

## The pitch

Your agent is as powerful as the information you give it. Agents execute faster than humans, but only if they know *when* to execute. **awake** is the missing trigger layer for the agent economy.

Three primitives:

- **Connector** — adapter to a signal source (PagerDuty, Viator, Gmail, GitHub, ...).
- **Watcher** — a filter on the connector's live state. Fires when conditions match.
- **Agent** — the thing that acts on the fire. Has its own brain (Claude) and body (Virtuals EconomyOS wallet + virtual card + inbox).

```
Connect agent  →  Add watcher  →  Automate
```

## What's in this repo (hackathon demo)

A **live demo** that proves the concept end-to-end:

1. PagerDuty incident gets resolved with a linked GitHub PR
2. **awake** receives the webhook, finds the PR author
3. Claude (the agent's brain) reasons: *should we tip them? how much?*
4. The agent autonomously sends USDC on **Base mainnet** from its **Virtuals EconomyOS-provisioned wallet**
5. A note posts back to the PagerDuty incident with the tx hash

No human in the loop between resolve and tip.

## Bounties hit

| Bounty | How |
|---|---|
| **PagerDuty** | Webhook receiver + REST API writeback (notes on the incident). Integrates with the incident lifecycle. |
| **Virtuals (EconomyOS)** | Agent's wallet was provisioned at app.virtuals.io. Real autonomous USDC tx on Base mainnet, no human intervention. |
| **Tripadvisor (Viator)** | (Roadmap) Same primitive, different connector — Viator product-search → agent generates an affiliate-linked trip plan. |

## Stack

- Bun + Hono (server)
- viem (Base mainnet USDC transfer)
- Anthropic SDK (Claude as the agent's brain)
- PagerDuty REST API + Webhooks v3
- GitHub REST API
- ngrok (public tunnel for the webhook)

## Run it locally

```bash
bun install
cp .env.example .env
# fill in PAGERDUTY_TOKEN, PAGERDUTY_USER_EMAIL, ANTHROPIC_API_KEY,
# AGENT_PRIVATE_KEY (from your Virtuals EconomyOS wallet), DEMO_FALLBACK_RECIPIENT
bun run dev
```

In another shell:
```bash
ngrok http 3000
```

In PagerDuty UI: Integrations → Generic Webhooks v3 → New Webhook → URL = `https://<your-ngrok>/webhook/pagerduty`, scope your service, event = `incident.resolved`.

Then resolve a test incident whose title contains a real GitHub PR URL. Watch the terminal:
- `webhook.received`
- `agent.pr_found`
- `agent.author`
- `agent.decision` ← Claude's reasoning
- `agent.tx` ← Base mainnet tx hash

Check the incident in PagerDuty — there's now an autonomous note with the tx link.

## Manual trigger (without ngrok)

```bash
curl -X POST http://localhost:3000/test/fire/PXXXXXX
```

Where `PXXXXXX` is the PagerDuty incident ID.

## Architecture

```
PagerDuty                                     awake server
─────────                                     ────────────
  incident.resolved
  (webhook v3)        ────────►       POST /webhook/pagerduty
                                              │
                                      ┌───────▼───────┐
                                      │  match watcher │
                                      └───────┬───────┘
                                              │
                                ┌─────────────▼─────────────┐
                                │  fetch incident + log     │
                                │  find github PR URL       │
                                │  fetch PR author          │
                                └─────────────┬─────────────┘
                                              │
                                ┌─────────────▼─────────────┐
                                │  Claude (Anthropic API)   │  ◄── brain
                                │  decide: tip? amount?     │
                                └─────────────┬─────────────┘
                                              │
                                ┌─────────────▼─────────────┐
                                │  Virtuals EconomyOS wallet │  ◄── body
                                │  send USDC (Base mainnet)  │
                                └─────────────┬─────────────┘
                                              │
                                              ▼
                                  POST /incidents/{id}/notes
                                  ◄────── Tipped @author $X
                                          Tx: basescan.org/...
```

## License

MIT
