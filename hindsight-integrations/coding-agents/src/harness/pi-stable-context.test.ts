import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type RawConfig } from "../core/config";
import type { HindsightClient } from "../core/hindsight";
import { RuntimeCore } from "../core/runtime";
import { createPiExtension } from "./pi-extension";

interface Message {
  role: string;
  content: unknown;
  customType?: string;
}
interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
  content?: string;
}

// Exercise the registered Pi handlers and real RuntimeCore/buildHookOutput, with only the bank
// client and host transport stubbed. No server, seed, installer or user configuration is touched.
function fixture(config: RawConfig = {}) {
  const client = {
    listPages: vi.fn(async () => ({ items: [{ id: "p1", name: "Decisions" }] })),
    searchKnowledgePages: vi.fn(async () => [{ id: "p1", name: "Decisions", snippet: "PAGE-HIT" }]),
    reflect: vi.fn(async () => "REFLECT-ANSWER"),
    recallObservations: vi.fn(async () => ["RECALL-HIT"]),
  };
  const branch: Entry[] = [];
  const messages: Message[] = [];
  const sessionId = randomUUID();
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  };
  function load(extra = "", harness = "pi") {
    const core = new RuntimeCore(
      client as unknown as HindsightClient,
      "offline-bank",
      resolveConfig({
        autoInject: "pages",
        retainSessions: false,
        ...config,
        toolGuideExtra: extra,
      }),
      harness
    );
    vi.spyOn(core, "seedIfCold").mockResolvedValue();
    const onTranscript = vi.spyOn(core, "onTranscript").mockResolvedValue();
    const handlers: Record<string, (...args: any[]) => any> = {};
    createPiExtension(
      harness,
      () => core
    )({
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
      registerTool: () => {},
      appendEntry: (customType: string, data: unknown) =>
        branch.push({ type: "custom", customType, data }),
    } as never);
    handlers.session_start({}, ctx);
    return { handlers, onTranscript };
  }
  let host = load("ORIGINAL-GUIDANCE");
  return {
    client,
    branch,
    messages,
    ctx,
    reload(extra = "CHANGED-GUIDANCE") {
      host = load(extra);
    },
    load,
    async prompt(prompt: string | undefined = "Implement the decision", context = ctx) {
      const sections: Record<string, string> = { base: "Pi", other: "OTHER-EXTENSION" };
      const event = {
        prompt,
        messageType: prompt ? "user" : "custom",
        systemPrompt: "Pi",
        systemPromptOptions: { sections },
      };
      const result = await host.handlers.before_agent_start(event, context);
      if (prompt) messages.push({ role: "user", content: prompt });
      if (result?.message) {
        branch.push({ type: "custom_message", ...result.message });
        messages.push({ role: "custom", ...result.message });
      }
      return { sections, result };
    },
    context(context = ctx) {
      return host.handlers.context({ messages }, context)?.messages ?? messages;
    },
    async end() {
      await host.handlers.agent_end({ messages }, ctx);
    },
  };
}

describe("Pi stable system section", () => {
  it.each([1, 2, 3, 20])(
    "keeps one section and one recall across eight prompts and reload (cadence %i)",
    async (cadence) => {
      const f = fixture({ pageRefreshEveryTurns: cadence });
      let stable: string | undefined;
      const sections: string[] = [];
      for (let turn = 1; turn <= 8; turn++) {
        if (turn === 4) f.reload(); // fresh RuntimeCore and adapter, same durable session
        f.client.listPages.mockResolvedValue({
          items: Array.from({ length: turn }, (_, i) => ({ id: `p${i}`, name: `Page ${i}` })),
        });
        const out = await f.prompt();
        stable ??= out.sections.hindsight;
        sections.push(out.sections.hindsight);
        expect(out.sections).toEqual({ base: "Pi", other: "OTHER-EXTENSION", hindsight: stable });
        expect(stable).toContain("ORIGINAL-GUIDANCE");
        expect(stable).not.toMatch(
          /PAGE-HIT|hindsight_knowledge_refresh|\d knowledge pages|CHANGED-GUIDANCE/
        );
        expect(out.result?.systemPrompt).toBeUndefined();
        const request = f.context();
        expect(request.filter((m: Message) => m.customType === "hindsight-recall")).toHaveLength(1);
        // A repeated context callback (tool continuation/provider retry) gets one reminder, not an
        // accumulation. The host's original message list and its durable branch never get one.
        expect(f.context().map((m: Message) => [m.role, m.content])).toEqual(
          request.map((m: Message) => [m.role, m.content])
        );
        expect(f.messages.some((m) => m.customType === "hindsight-roster-refresh")).toBe(false);
        if (turn === 6) {
          expect(request.some((m: Message) => m.customType === "hindsight-roster-refresh")).toBe(
            6 % cadence === 0
          );
        }
        await f.end();
        expect(f.context()).toEqual(f.messages);
      }
      expect(new Set(sections).size).toBe(1);
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(1);
      expect(f.branch.filter((e) => e.customType === "hindsight-recall")).toHaveLength(1);
      expect(f.branch.filter((e) => e.customType === "hindsight-system-guidance")).toHaveLength(1);
      expect(f.branch.some((e) => e.customType === "hindsight-roster-refresh")).toBe(false);
    }
  );

  it.each(["reflect", "recall", "none"] as const)(
    "preserves %s auto-injection semantics",
    async (autoInject) => {
      const f = fixture({ autoInject });
      await f.prompt();
      f.reload();
      await f.prompt();
      expect(f.client.reflect).toHaveBeenCalledTimes(autoInject === "reflect" ? 1 : 0);
      expect(f.client.recallObservations).toHaveBeenCalledTimes(autoInject === "recall" ? 1 : 0);
      expect(f.client.searchKnowledgePages).not.toHaveBeenCalled();
      expect(f.messages.filter((m) => m.customType === "hindsight-recall")).toHaveLength(
        autoInject === "none" ? 0 : 1
      );
    }
  );

  it.each(["empty", "failure"])(
    "keeps bounded retry behavior after an %s first retrieval",
    async (outcome) => {
      const f = fixture();
      if (outcome === "empty") f.client.searchKnowledgePages.mockResolvedValueOnce([]);
      else f.client.searchKnowledgePages.mockRejectedValueOnce(new Error("offline"));
      const first = await f.prompt();
      expect(first.result?.message).toBeUndefined();
      f.reload();
      const second = await f.prompt();
      expect(second.sections.hindsight).toBe(first.sections.hindsight);
      expect(second.result?.message.content).toContain("PAGE-HIT");
      await f.prompt();
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
      expect(f.messages.filter((m) => m.customType === "hindsight-recall")).toHaveLength(1);
    }
  );

  it("isolates sessions and skips recall/stale reminders on custom-message runs", async () => {
    const f = fixture();
    const first = await f.prompt();
    const custom = await f.prompt("");
    expect(custom.sections.hindsight).toBe(first.sections.hindsight);
    expect(custom.result).toBeUndefined();
    expect(f.context()).toEqual(f.messages);
    const otherId = randomUUID();
    const other = {
      ...f.ctx,
      sessionManager: { getSessionId: () => otherId, getBranch: () => [] },
    };
    expect(f.context(other)).toEqual(f.messages);
    await f.prompt("A different goal", other);
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
  });

  it("keeps Prime Agent on its existing system-injection path", async () => {
    const f = fixture();
    const { handlers } = f.load("", "prime-agent");
    const sections: Record<string, string> = {};
    const result = await handlers.before_agent_start(
      { prompt: "hello", systemPrompt: "Pi", systemPromptOptions: { sections } },
      f.ctx
    );
    expect(sections.hindsight).toContain("PAGE-HIT");
    expect(result).toBeUndefined();
    expect(handlers.context).toBeUndefined();
    expect(f.branch).toEqual([]);
  });

  it("does not retain the persistent custom recall as user conversation", async () => {
    const f = fixture();
    const { handlers, onTranscript } = f.load();
    await handlers.agent_end(
      {
        messages: [
          { role: "user", content: "actual prompt" },
          { role: "custom", customType: "hindsight-recall", content: "PAGE-HIT" },
          { role: "assistant", content: "actual answer" },
        ],
      },
      { ...f.ctx, sessionManager: { getSessionId: () => "s" } }
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "s",
      [
        { role: "user", content: "actual prompt" },
        { role: "assistant", content: "actual answer" },
      ],
      true
    );
  });
});
