# RefundBrief judge runbook — release candidate

The credential-free path is `npm ci`, `npm test`, `npm run build`, `npm run demo`, then http://127.0.0.1:4184/ on your own machine. Node 22.13+ (22.x) or 24+ and npm are required. Package installation needs internet; demo runtime needs no model, payment or account access. No hosted application is claimed. The intended public field 28787 value is the published repository URL ending `#judge-testing` plus its downloadable source release; owner approval/publication is still required.

## Structured review fixture

The demo opens **Policy conflict — stored AI review fixture** automatically. To return after switching away, open the left-rail **Cases** chooser and select it. The top Cases button returns to the workspace. Legacy examples remain available and demonstrate the original consent flow. Confirm **Stored AI output · payments simulated** and **Sample case — simulated**.

The policy versions say 48h and 24h, the case describes 30h and no accepted version is supplied. These are fictional source claims. The complete original AI output and source packet are in `fixtures/judge-policy-conflict/`; the separate neutral fixture remaps source IDs and normalises roles only. The manifest names every transformation and hashes the inputs. The redundant second issue is retained rather than silently dropped. No output is newly inferred in this build.

1. Inspect both passages and open their originals. Exact quote offsets/digests identify provenance; they do not verify truth or completeness.
2. Record a rationale for every issue; consider every linked passage. **Reviewed, still unresolved** and **Owner judgement** preserve uncertainty. **Owner conclusion — cited basis** selects any considered passage, without proving every part of the conclusion. No passage means that option is unavailable. **Not material** excludes an issue by owner choice; it establishes no fact.
3. For a fictional technical walkthrough, choose **Prepare a refund**, enter 1.00 and a reason, check review consent, and choose **Review refund**. No amount is proposed by the assistant. Confirm the separate simulated modal, inspect the simulated receipt and export. Export includes immutable source/issue/review snapshots and distinguishes owner conclusions from payment state.
4. A completed operation blocks another refund on the same capture. Ctrl+C and `npm run demo` creates a different fresh temporary workspace and restores only fictional cases, not owner data or fresh inference. Every path is printed; previous workspaces remain inspectable.
5. In a fresh launch, review all issues and record **clarification needed** with a reason. Reload/export to inspect it. No customer message or payment is sent. Edit a source and save: the brief becomes stale and approvals/current acknowledgements cannot use the earlier basis. Restart for original inputs; fresh generation is deliberately disabled.

## Payment state is separate

| State | Meaning/action |
|---|---|
| preparing | Operation persisted; do not submit another request. |
| pending | Provider has not completed it; retain the hold. |
| unknown | Outcome ambiguous; inspect/reconcile the existing request. Never reset/retry with a new key. |
| refused | This attempt was refused; inspect its recorded detail. A later success does not explain an earlier refusal. |
| completed | Operation recorded completed; bank receipt is not implied. |
| simulated | Local fictional operation; no PayPal request or money movement. |

The current workflow status counts issues **needing follow-up**, not facts proven. Not-material issues were excluded by the owner. New reviews use contract 2; contract 1 review labels remain in history and require a fresh acknowledgement for current structured decisions. Completed/pending/unknown receipt access and reconciliation are preserved.

## Genuine evidence, separately dated

A4 November upgraded owner run capturedGBP 10 and separately approved aGBP 1 sandbox refund, independently confirmed COMPLETED by PayPal. An earlier pre-send refusal from that run is preserved without a refund ID; its exact cause is unknown.3 November US sandbox proof is a separate older run. No further refund was sent for this candidate or recording. Raw account/provider diagnostics remain private. See [public verification](public-verification.md).

Normal owner integrations remain in source; demo blocks them before credential/OAuth/transport work. It ignores configured provider credentials and does not initialise ChatGPT. Controlled direct-route tests use counting/rejecting transports; browser checks inspect actual navigation and same-origin traffic. Fresh live inference/PayPal evaluation needs separately authorised owned accounts and available credit, and is unnecessary for judge inspection. No secrets are supplied as judge credentials.
