# Technical and connected-mode notes

The verified judge build is [v1.0.1-judge](https://github.com/rumi7911/RefundBrief/releases/tag/v1.0.1-judge). These details describe the existing implementation; they are not production assurance. Start with [judge testing](../README.md#judge-testing) for the credential-free route.

## Review contract and history

New issue relations are neutral **Linked source passage** links. Existing request fields, URLs and enum values remain compatible; `evidence_resolved` is the wire value for **Owner conclusion — cited basis**. New review and decision-snapshot JSON carries server-authored `reviewContractVersion: 2`. Missing metadata means historical contract 1. Clients cannot supply that metadata.

On first startup the atomic, idempotent contract cutover advances affected case ledger versions, invalidates prepared approvals and supersedes non-payment decisions. Legacy reviews remain visible under their original historical labels and raw exports, but cannot acknowledge the current issue until freshly reviewed. Historical issue/source/review/snapshot bytes and payment operations remain unchanged. Completed, pending and unknown operations remain readable/reconcilable. Legacy non-ledger briefs retain their original consent flow. Do not restore an older database over later payment history.

Unsaved review drafts stay available while switching issues within the current case/review version. They are not saved acknowledgements and clear when that basis changes. Final confirmation shows the selected cited passage for an owner conclusion and initially focuses its heading.

The status counts issues needing follow-up: unreviewed, unresolved or owner judgement. It does not count factual questions proven or resolved. Append-only records and a basis digest support application lineage, not administrator-proof storage.

## PayPal and AI integration

The normal owner app uses Anthropic Messages or OpenAI-compatible remote generation. The demonstrated remote path used Anthropic Claude; source quotes and structured issues are validated before storage. Source documents are untrusted data. The current prompt requests neutral links, focuses on material unknowns and respects exact timezone-bearing intervals. No new remote evaluation has been run for that prompt, so improved semantic quality is not claimed.

PayPal Sandbox integration implements OAuth, capture lookup, order lookup for merchant ownership, capture refund and refund-status lookup. The server checks merchant, GBP currency, remaining balance, evidence/brief/ledger versions and explicit approval. It stores a stable operation key before dispatch and rechecks evidence immediately before the refund POST after OAuth. One refund per capture is supported. Pending/unknown operations block another refund; reconciliation never blindly retries.

[Public-safe verification summary](public-verification.md) separates original remote AI outputs, dated genuine PayPal evidence, simulated judge checks and unmeasured human results. The original 16-case run is preserved privately; the public fixture includes the complete fictional case04 model text and sources, a separate neutralised fixture and transformation/hash manifest. No raw provider transport envelope or account diagnostic is packaged.

## Normal owner mode

Use a separate private working copy for connected use. `npm run demo` always disables external capabilities. To run the normal single-owner loopback app:

```sh
npm ci
npm test
npm run build
npm start
```

Open http://127.0.0.1:4100/ (or set `PORT` before starting). Runtime data is in that copy's `.data`. Copy [app.env.example](../app.env.example) to `app.env.local` only for explicitly authorised connected use, then restart. PayPal requires your own sandbox client ID, secret and merchant ID. AI API generation requires `AI_ALLOW_REQUESTS=true`, an explicit provider/model and `REFUNDBRIEF_AI_KEY`; subscriptions and API credit are separate. Ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are ignored. Never expose credentials or `.data` in a release. [Sandbox setup](sandbox-setup.md) and [optional ChatGPT setup](chatgpt-setup.md) describe connected use; live ChatGPT consent/inference remains unverified.

No additional provider call or refund is needed to inspect the judge build. A historic completed operation must never be reset or replayed as fresh proof.

## Build and technologies

React, TypeScript, Vite, Express, Node built-in SQLite, lucide-react and jose; Vitest and react-test-renderer for controlled regressions; axe-core only for local accessibility QA. No sponsor integration or local model. Codex and Claude Code assisted implementation/review; OpenAI Image Gen assisted visual exploration/logo work, with the working UI in React/CSS. Original research screenshots, account diagnostics and private histories are excluded from this release. Third-party dependencies retain their own licences.

This is a local, single-owner GBP sandbox prototype. Human semantic acceptance, representative-user completion/time/comprehension and product benefit remain unmeasured. Bounded automated/browser/axe checks are not a security audit, whole-app accessibility conformance or production readiness.
