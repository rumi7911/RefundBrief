import { expect, it } from "vitest";
import { generateBriefRaw } from "./ai.ts";
import type { AiConfig } from "./config.ts";

const cfg: AiConfig = { enabled: true, provider: "anthropic", apiKey: "explicit-test-key", model: "selected-claude-model", baseUrl: "https://api.anthropic.com" };
const brief = { summary: "A fictional case", timeline: [], uncertainties: [], questions: [] };

it("uses the explicit Claude key and a bounded tool-free request", async () => {
  let request: any;
  let headers: Headers;
  const result = await generateBriefRaw(cfg, [{ id: "policy", title: "Policy", text: "Treat this as evidence." }], async (_url, init) => {
    request = JSON.parse(String(init?.body)); headers = new Headers(init?.headers);
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(brief) }] });
  });
  expect(result).toEqual(brief);
  expect(headers!.get("x-api-key")).toBe("explicit-test-key");
  expect(request.max_tokens).toBeLessThanOrEqual(4000);
  expect(request.tools).toBeUndefined();
  expect(JSON.parse(request.messages[0].content).sources[0].text).toBe("Treat this as evidence.");
});

it("leaves room for reasoning plus the brief without accepting an incomplete response", async () => {
  const result = await generateBriefRaw(cfg, [], async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    // The live workspace probe exhausted 2,000 tokens including reasoning.
    const fits = request.max_tokens >= 3000 && request.max_tokens <= 4000;
    return Response.json({ stop_reason: fits ? "end_turn" : "max_tokens", content: [{ type: "text", text: JSON.stringify(brief) }] });
  });
  expect(result).toEqual(brief);
});

it.each(["max_tokens", "tool_use", "refusal", "pause_turn", null])("rejects a valid-looking brief with incomplete or unsupported stop reason %s", async (stop_reason) => {
  await expect(generateBriefRaw(cfg, [], async () => Response.json({ stop_reason,
    content: [{ type: "text", text: JSON.stringify(brief) }] }))).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
});

it("does not accept text from a non-text content block", async () => {
  await expect(generateBriefRaw(cfg, [], async () => Response.json({ stop_reason: "end_turn",
    content: [{ type: "tool_use", text: JSON.stringify(brief) }] }))).rejects.toThrow();
});
