# Connect RefundBrief to PayPal sandbox

This connection uses test accounts and test money. Sample cases in the app are separate simulations; they are not PayPal sandbox transactions.

1. Open the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) and sign in or create your developer account. Complete any account agreement yourself.
2. Follow PayPal's [sandbox account guide](https://developer.paypal.com/tools/sandbox/accounts/) to create or select a **business** sandbox account (merchant) and a **personal** sandbox account (test buyer).
3. In the dashboard's apps and credentials area, select **Sandbox** and create a REST application associated with the business sandbox account. Record its client ID and secret locally. Never use live credentials.
4. Open the sandbox business account's settings to obtain its merchant ID. This identifies the merchant whose captured payment may be refunded; it is distinct from the application client ID and buyer identity.
5. Copy the project's `app.env.example` to `app.env.local`. Fill the PayPal sandbox client ID, secret and merchant ID there. Keep that file private; do not paste its contents into chat or commit it.
6. Restart RefundBrief. Its connection screen should distinguish configured credentials from a verified connection. Configuration alone does not prove access.
7. Establish a real **sandbox** captured payment for the same business account using PayPal's [standard checkout integration](https://developer.paypal.com/checkout/standard/integrate/). Approve it with the personal sandbox buyer. Use the resulting capture ID in an owner-created case. A fabricated sample capture ID cannot be refunded through PayPal.
8. Verify the initial capture, refundable balance and currency, then test an explicitly approved partial refund. Check the returned refund ID and actual status in the sandbox. A pending refund must remain pending in the UI.

The refund API is documented at [Refund captured payment](https://developer.paypal.com/api/payments/v2/captures-refund). Follow PayPal's current dashboard labels if they differ from these instructions. Use your own sandbox fixtures; no credentials or working data directory ships in the source release.

## Dated evidence and local judge mode

The original GB compliance restriction remains unexplained. A separate US sandbox configuration completed a technical capture/refund on 3 November. On 4 November the upgraded ledger app captured GBP10 and explicitly approved GBP1, independently confirmed COMPLETED; an earlier pre-send refusal in that run remains preserved with an UNKNOWN cause. See [public verification](public-verification.md). These are agent-controlled sandbox checks, not bank receipt or human acceptance.

No extra transaction is needed for judging or recording. `npm run demo` uses stored fictional AI output and simulated payments, with external credentials/accounts/generation disabled. Never reset a completed payment history. Connected testing requires separate authorisation; it is not part of the credential-free judge walkthrough.
