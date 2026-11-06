// Entry point. Binds ONLY to the loopback interface (127.0.0.1). A remote bind
// is refused by construction — the host is never 0.0.0.0.

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app } = createApp({ config });

const server = app.listen(config.port, config.host, () => {
  console.log(`RefundBrief backend on http://${config.host}:${config.port}`);
  console.log(`PayPal sandbox: ${config.paypal.configured ? "configured" : "NOT configured (sample mode)"}`);
  console.log(`API AI adapter: ${config.ai.enabled ? `${config.ai.provider}/${config.ai.model}` : "disabled; ChatGPT plan connection is managed separately in Settings"}`);
});

server.on("error", (err) => {
  console.error("Server failed to start:", err.message);
  process.exit(1);
});
