# Connect a ChatGPT plan to the local RefundBrief app

This uses OpenAI's documented public-client flow for locally hosted apps. The
account must allow ChatGPT plan usage. Availability and limits are determined by
OpenAI and your workspace; a successful local test does not establish eligibility.

1. Keep RefundBrief running at `http://127.0.0.1:4100/`.
2. Open Settings and choose **Continue with ChatGPT**. Sign in on OpenAI's own
   website, review the app name (RefundBrief), requested permissions and plan usage
   limits, then approve only if they match your intent. Do not purchase credits.
3. OpenAI returns to the local Settings screen. Click **Load available models**.
4. Choose a model from your own account's catalog and click **Use selected model**.
5. Return to the workspace. **Generate review brief** sends that case's source
   documents to OpenAI and uses your plan allowance. Start with fictional sample
   evidence. No inference starts merely from signing in or selecting a model.

The password is entered only at OpenAI. This app's own tokens are stored in
`.data/chatgpt.json`, with owner-only file permissions and atomic writes. They are
never placed in browser storage, status responses or exports. Do not share the
`.data` directory, cookie files, authorization URLs containing identity hints, or
environment files. Only one ChatGPT account registration is supported by this MVP;
reauthorisation must validate the same identity. The host ID persists across
restarts and disconnects.

**Disconnect ChatGPT** stops new plan requests and clears local tokens. It attempts
remote refresh-session revocation; if that cannot be confirmed, the screen
explicitly tells you to remove RefundBrief's access in ChatGPT Settings. Existing
briefs remain in your local case records. A request already in flight may still
finish. API configuration, if explicitly enabled separately, remains separate.

If sign-in is denied or fails, start again from Settings. If your plan is exhausted
or streaming fails, no partial brief is stored. There is no automatic paid API
fallback. A hosted multi-user deployment requires separate supported access
arrangements; this local connection is not a public deployment approval.

PayPal approval is independent. The separate US sandbox integration has dated technical evidence; this does not verify ChatGPT consent/inference. The free `npm run demo` build disables every ChatGPT connection route and ignores credentials. Use normal private owner mode only for separately authorised connected use.

This optional integration was implemented against the documented flow at the original November checkpoint. Account access and provider behaviour may change; live consent and inference are not established by the controlled tests.
