import { expect, it } from "vitest";
import { generateBriefRaw } from "./ai.ts";
import type { AiConfig } from "./config.ts";

const cfg: AiConfig = { enabled: true, provider: "openai", apiKey: "app-owned-token", model: "selected-model", baseUrl: "https://api.openai.com", stream: true };
const brief = { summary: "Café receipt", timeline: [], uncertainties: [], questions: [] };
function streaming(events: object[]): Response {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
it("accepts OAuth inference only after terminal completion, including chunked UTF-8", async () => {
  let body: any;
  const result = await generateBriefRaw(cfg, [], async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return streaming([{ type: "response.output_text.delta", delta: JSON.stringify(brief) }, { type: "response.completed", response: { status: "completed" } }]);
  });
  expect(result).toEqual(brief);
  expect(body).toMatchObject({ stream: true, store: false, model: "selected-model" });
  expect(body.tools).toBeUndefined();
});
it.each(["response.failed", "response.incomplete", "error", "interrupted"])("rejects complete-looking JSON followed by %s", async (type) => {
  const events: object[] = [{ type: "response.output_text.delta", delta: JSON.stringify(brief) }];
  if (type !== "interrupted") events.push({ type, response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } });
  await expect(generateBriefRaw(cfg, [], async () => streaming(events))).rejects.toThrow();
});
