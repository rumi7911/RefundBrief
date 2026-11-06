# RefundBrief

RefundBrief helps a small-business owner inspect refund evidence before choosing an outcome. AI organises attributed source passages and proposes material questions. The owner records an interpretation, chooses any amount and explicitly approves the action. PayPal processes sandbox refunds. The model has no payment tools and does not recommend amounts.

## Judge testing

**For small service-business owners comparing cancellation messages, booking records and conflicting policies.** AI organises cited passages and questions; the owner interprets them, chooses any amount and approves the action. PayPal processes sandbox refunds in connected owner mode—the model has no payment tools.

**This downloadable local judge build uses stored AI output and simulated payments.** It is not a hosted app or a fresh AI/PayPal transaction. No funded AI or PayPal account is needed.

Download the source-release archive supplied with the submission, extract it, and open a terminal in the folder containing `package.json`. The public repository’s Releases section is the intended download location.

The free local test build needs **Node.js 22.13+ (22.x) or 24+**, npm and a browser. No AI or PayPal account, credentials, local model, Docker or database service is needed. Run these commands from the extracted source directory:

```sh
npm ci
npm test
npm run build
npm run demo
```

`npm ci` downloads locked packages and requires registry internet access. Open **http://127.0.0.1:4184/** locally. The app says **Stored AI output · payments simulated**. Demo runtime disables fresh inference, ChatGPT connections, external accounts and real-case creation, even if provider environment variables or saved credentials exist. It makes no model/payment/account requests. Node's experimental SQLite warning is expected. If port 4184 is occupied, check which local process owns it. Stop your own earlier demo if that is the cause; do not terminate an unrelated process.

**The demo opens “Policy conflict — stored AI review fixture” automatically.** If you switch away, use **Cases in the left rail** to choose it again; the top navigation’s Cases button returns to the workspace. Older examples remain available and use the original consent flow. Disabled generation controls are intentional: the judge build does not send sources to an AI provider.

1. Inspect the linked 48-hour and 24-hour passages. They are attributed source claims; a quote match proves provenance, not correctness. Open a source to see its exact location.
2. Consider every listed passage and save your own interpretation for each issue. Try **Reviewed, still unresolved** for missing accepted terms. The original redundant interval issue is deliberately retained; you may mark it **Not material to this decision** with a reason. These are your choices, not supplied ground truth.
3. **Owner conclusion — cited basis** may select any considered linked passage. The selected reference does not prove every part of your conclusion. Without a passage that option is unavailable. **Owner judgement** keeps facts uncertain; **Not material** means excluded by you.
4. Choose **Prepare a refund**, enter a fictional amount (for example 1.00) and reason, check review consent, then review and explicitly confirm the **simulated** refund. Inspect the labelled receipt and export JSON/text. No money moves.
5. Stop with Ctrl+C and run `npm run demo` again. Each launch prints a new OS temporary workspace and restores the original fictional inputs, with no reviews or operations. It does not erase the owner's `.data` or run new AI inference. Old demo workspaces are retained for inspection.
6. In a fresh demo, save a clarification outcome; it sends no message or payment. Edit a source: its stored brief becomes stale and old acknowledgements cannot approve a refund. Restart restores the original fixture; edited evidence is never described as freshly analysed by AI.

Full steps and payment-state meanings: [judge runbook](docs/judge-runbook.md). The intended public testing URL is the eventual public repository's `#judge-testing` link, with a downloadable source-release link. This local candidate does not establish public availability.

## Review contract and history

New issue relations are neutral **Linked source passage** links. Existing request fields, URLs and enum values remain compatible; `evidence_resolved` is the wire value for **Owner conclusion — cited basis**. New review and decision-snapshot JSON carries server-authored `reviewContractVersion: 2`. Missing metadata means historical contract 1. Clients cannot supply that metadata.

On first startup the atomic, idempotent contract cutover advances affected case ledger versions, invalidates prepared approvals and supersedes non-payment decisions. Legacy reviews remain visible under their original historical labels and raw exports, but cannot acknowledge the current issue until freshly reviewed. Historical issue/source/review/snapshot bytes and payment operations remain unchanged. Completed, pending and unknown operations remain readable/reconcilable. Legacy non-ledger briefs retain their original consent flow. Do not restore an older database over later payment history.

Unsaved review drafts stay available while switching issues within the current case/review version. They are not saved acknowledgements and clear when that basis changes. Final confirmation shows the selected cited passage for an owner conclusion and initially focuses its heading.

The status counts issues needing follow-up: unreviewed, unresolved or owner judgement. It does not count factual questions proven or resolved. Append-only records and a basis digest support application lineage, not administrator-proof storage.

## PayPal and AI integration

The normal owner app uses Anthropic Messages or OpenAI-compatible remote generation. The demonstrated remote path used Anthropic Claude; source quotes and structured issues are validated before storage. Source documents are untrusted data. The current prompt requests neutral links, focuses on material unknowns and respects exact timezone-bearing intervals. No new remote evaluation has been run for that prompt, so improved semantic quality is not claimed.

PayPal Sandbox integration implements OAuth, capture lookup, order lookup for merchant ownership, capture refund and refund-status lookup. The server checks merchant, GBP currency, remaining balance, evidence/brief/ledger versions and explicit approval. It stores a stable operation key before dispatch and rechecks evidence immediately before the refund POST after OAuth. One refund per capture is supported. Pending/unknown operations block another refund; reconciliation never blindly retries.

[Public-safe verification summary](docs/public-verification.md) separates original remote AI outputs, dated genuine PayPal evidence, simulated judge checks and unmeasured human results. The original 16-case run is preserved privately; the public fixture includes the complete fictional case04 model text and sources, a separate neutralised fixture and transformation/hash manifest. No raw provider transport envelope or account diagnostic is packaged.

## Normal owner mode

Use a separate private working copy for connected use. `npm run demo` always disables external capabilities. To run the normal single-owner loopback app:

```sh
npm ci
npm test
npm run build
npm start
```

Open http://127.0.0.1:4100/ (or set `PORT` before starting). Runtime data is in that copy's `.data`. Copy [app.env.example](app.env.example) to `app.env.local` only for explicitly authorised connected use, then restart. PayPal requires your own sandbox client ID, secret and merchant ID. AI API generation requires `AI_ALLOW_REQUESTS=true`, an explicit provider/model and `REFUNDBRIEF_AI_KEY`; subscriptions and API credit are separate. Ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are ignored. Never expose credentials or `.data` in a release. [Sandbox setup](docs/sandbox-setup.md) and [optional ChatGPT setup](docs/chatgpt-setup.md) describe connected use; live ChatGPT consent/inference remains unverified.

No additional provider call or refund is needed to inspect the judge build. A historic completed operation must never be reset or replayed as fresh proof.

## Build and technologies

React, TypeScript, Vite, Express, Node built-in SQLite, lucide-react and jose; Vitest and react-test-renderer for controlled regressions; axe-core only for local accessibility QA. No sponsor integration or local model. Codex and Claude Code assisted implementation/review; OpenAI Image Gen assisted visual exploration/logo work, with the working UI in React/CSS. Original research screenshots, account diagnostics and private histories are excluded from this release. Third-party dependencies retain their own licences.

This is a local, single-owner GBP sandbox prototype. Human semantic acceptance, representative-user completion/time/comprehension and product benefit remain unmeasured. Bounded automated/browser/axe checks are not a security audit, whole-app accessibility conformance or production readiness.

## Release maintainer checklist

Public repository, source-release and video links require owner-approved publication and anonymous verification before submission. This local package does not establish public availability. Keep the repository/release free to judges through **15 December 2026**. The intended submission testing link ends `#judge-testing`; verify the exact fragment and download destination after publication. Owner declarations, asset rights and actual submission receipt remain separate checks.

## Licence

[MIT](LICENSE).
