# Security boundaries and reporting

RefundBrief is a single-owner loopback prototype, not a production payment service. Use the credential-free fictional judge route for evaluation. Do not expose the server publicly or use real customer records for a report. [Evidence and limits](docs/public-verification.md) do not constitute general security assurance.

Never include API keys, OAuth tokens, sandbox account diagnostics, private database files or case documents in a public issue. A public issue may say that you need a private reporting route; provide no exploit details or sensitive data until a private route is agreed. This repository does not promise a security-response SLA or a bug-bounty programme.

Do not test third-party accounts, replay a historical refund or send a provider request to demonstrate a concern. Prefer deterministic fake transport responses and an isolated in-memory/test database. Keep failures and unknown payment outcomes intact.

The 6 November 2026 native lookup identity correction is described in [the v1.0.1 release](https://github.com/rumi7911/RefundBrief/releases/tag/v1.0.1-judge). No Codex Security Cloud scan or production security clearance is claimed.
