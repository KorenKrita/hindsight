import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type RawConfig } from "../core/config";
import { ReflectError, type HindsightClient } from "../core/hindsight";
import * as diagnostics from "../core/diag";
import { log } from "../core/log";
import { RuntimeCore } from "../core/runtime";
import * as sessionCache from "../core/session-cache";
import { createPiExtension, usesStablePiContext } from "./pi-extension";

interface Message {
  role: string;
  content: unknown;
  customType?: string;
  sections?: Record<string, string>;
  timestamp?: number;
}
interface Entry {
  id?: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  content?: string;
  message?: Message;
}

// Each session has its OWN branch, full entry tree and request messages. before_agent_start sees
// the previous leaf: the host appends system delta, user, returned custom message, in that order.
function session(copy: Entry[] = []) {
  const id = randomUUID();
  const branch = structuredClone(copy);
  const entries = [...branch];
  const messages: Message[] = [];
  const rebuild = () => {
    messages.splice(
      0,
      messages.length,
      ...branch.flatMap((e) =>
        e.type === "message" && e.message
          ? [e.message]
          : e.type === "custom_message"
            ? [{ role: "custom", content: e.content, customType: e.customType }]
            : []
      )
    );
  };
  rebuild();
  const append = (e: Entry) => {
    e.id ??= randomUUID();
    e.parentId = branch.at(-1)?.id ?? null;
    branch.push(e);
    entries.push(e);
    rebuild();
  };
  return {
    id,
    branch,
    entries,
    messages,
    append,
    rewind(length: number) {
      branch.splice(length);
      rebuild();
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => id,
        getBranch: () => branch,
        getEntries: () => entries,
      },
    },
  };
}

function fixture(config: RawConfig = {}, version: string | undefined = "1.4.0", harness = "pi") {
  const client = {
    listPages: vi.fn(async () => ({ items: [{ id: "p1", name: "Decisions" }] })),
    searchKnowledgePages: vi.fn(async (prompt: string) => [
      { id: "p1", name: "Decisions", snippet: `PAGE-HIT:${prompt}` },
    ]),
    reflect: vi.fn(async () => "REFLECT-ANSWER"),
    recallObservations: vi.fn(async () => ["RECALL-HIT"]),
  };
  function load(extra = "ORIGINAL-GUIDANCE") {
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
    const clear = vi.spyOn(core, "clearSessionState");
    const handlers: Record<string, (...args: any[]) => any> = {};
    createPiExtension(
      harness,
      () => core,
      version
    )({
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
      registerTool: () => {},
    } as never);
    return { core, handlers, onTranscript, clear };
  }
  let host = load();
  return {
    client,
    get host() {
      return host;
    },
    async reload(extra = "ORIGINAL-GUIDANCE") {
      await host.handlers.session_shutdown();
      host = load(extra);
    },
    async prompt(
      s: ReturnType<typeof session>,
      prompt: string | undefined = "Implement the decision"
    ) {
      const sections: Record<string, string> = { base: "Pi", other: "OTHER-EXTENSION" };
      const event = {
        prompt,
        messageType: prompt ? "user" : "custom",
        systemPrompt: "Pi",
        systemPromptOptions: { sections },
      };
      const result = await host.handlers.before_agent_start(event, s.ctx);
      const prior = s.branch.filter((e) => e.message?.role === "system").at(-1)?.message?.sections;
      if (JSON.stringify(prior) !== JSON.stringify(sections)) {
        s.append({ type: "message", message: { role: "system", content: "", sections } });
      }
      if (prompt) s.append({ type: "message", message: { role: "user", content: prompt } });
      if (result?.message) s.append({ type: "custom_message", ...result.message });
      return { sections, result };
    },
    request(s: ReturnType<typeof session>): Message[] {
      const messages = structuredClone(s.messages);
      return host.handlers.context?.({ messages }, s.ctx)?.messages ?? messages;
    },
    end: (s: ReturnType<typeof session>) =>
      host.handlers.agent_end({ messages: s.messages }, s.ctx),
  };
}

const recalls = (s: ReturnType<typeof session>) =>
  s.branch.filter((e) => e.customType === "hindsight-recall");

describe("Pi stable system section", () => {
  it.each([1, 2, 3, 20])(
    "preserves EVERY request prefix across turns, tool loops and reload (cadence %i)",
    async (cadence) => {
      const f = fixture({ pageRefreshEveryTurns: cadence });
      const s = session();
      let previous: Message[] = [];
      let stable: string | undefined;
      for (let turn = 1; turn <= 8; turn++) {
        if (turn === 4) await f.reload();
        f.client.listPages.mockResolvedValue({
          items: Array.from({ length: turn }, (_, i) => ({ id: `p${i}`, name: `Page ${i}` })),
        });
        const out = await f.prompt(s, `turn ${turn}`);
        stable ??= out.sections.hindsight;
        expect(out.sections).toEqual({ base: "Pi", other: "OTHER-EXTENSION", hindsight: stable });
        expect(stable).not.toMatch(/PAGE-HIT|hindsight_knowledge_refresh|\d knowledge page/);
        // Three tool continuations, plus the final text-only request in EVERY user turn.
        for (let loop = 0; loop < 4; loop++) {
          const request = f.request(s);
          expect(request.slice(0, previous.length)).toEqual(previous);
          expect(request).toEqual(s.messages);
          previous = request;
          s.append({
            type: "message",
            message: {
              role: "assistant",
              content:
                loop < 3
                  ? [
                      {
                        type: "toolCall",
                        id: `${turn}-${loop}`,
                        name: "read",
                        arguments: { path: "a" },
                      },
                    ]
                  : [{ type: "text", text: "Done" }],
            },
          });
          if (loop < 3)
            s.append({
              type: "message",
              message: { role: "toolResult", content: `result ${turn}-${loop}` },
            });
        }
        await f.end(s);
        // Retry/recovery after agent_end must not remove any extension context either.
        expect(f.request(s).slice(0, previous.length)).toEqual(previous);
      }
      expect(f.host.handlers.context).toBeUndefined();
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(1);
      expect(f.client.listPages).toHaveBeenCalledTimes(1);
      expect(recalls(s)).toHaveLength(1);
      expect(s.messages[1].role).toBe("user");
      expect(s.messages[2].customType).toBe("hindsight-recall");
      expect(s.messages[2].content).toContain("1 knowledge page.");
      expect(s.branch.filter((e) => e.message?.role === "system")).toHaveLength(1);
      expect(s.branch.some((e) => e.type === "custom")).toBe(false);
    }
  );

  it("derives sections only from config, including changed config after reload and on another branch", async () => {
    const f = fixture();
    const a = session();
    const first = await f.prompt(a);
    a.rewind(0);
    await f.reload("NEW-GUIDANCE");
    const changed = await f.prompt(a);
    expect(changed.sections.hindsight).toContain("NEW-GUIDANCE");
    expect(changed.sections.hindsight).not.toBe(first.sections.hindsight);
    expect((await f.prompt(a)).sections.hindsight).toBe(changed.sections.hindsight);
    expect((await f.prompt(session())).sections.hindsight).toBe(changed.sections.hindsight);
  });

  it("uses branch entries, not temp cache, after fork, compaction and reload", async () => {
    const read = vi.spyOn(sessionCache, "readSessionCache");
    const write = vi.spyOn(sessionCache, "writeSessionCache");
    try {
      const f = fixture();
      const a = session();
      await f.prompt(a);
      const fork = session(a.branch);
      await f.reload();
      await f.prompt(fork);
      // Raw branch still includes recall even when normal compaction removes it from projection.
      fork.append({ type: "compaction" });
      await f.reload();
      await f.prompt(fork);
      expect(recalls(fork)).toHaveLength(1);
      expect(recalls(a)).toHaveLength(1);
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("retrieves for an edited opening goal after tree rewind and reload", async () => {
    const f = fixture();
    const a = session();
    await f.prompt(a, "original goal");
    const content = recalls(a)[0].content;
    a.rewind(1); // /tree chooses the first user entry; Pi sets leaf to its parent (system).
    await f.reload();
    await f.prompt(a, "edited goal");
    expect(recalls(a)).toHaveLength(1);
    expect(recalls(a)[0].content).not.toBe(content);
    expect(recalls(a)[0].content).toContain("PAGE-HIT:edited goal");
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
    // A /fork at the same point copies only that branch, not the abandoned recall. Re-query once.
    const fork = session(a.branch.slice(0, 1));
    await f.prompt(fork, "forked goal");
    expect(recalls(fork)[0].content).toContain("PAGE-HIT:forked goal");
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(3);
  });

  it("recovers a missing recall after the first user node, but does not inject into unrelated old history", async () => {
    const f = fixture();
    const a = session();
    await f.prompt(a);
    a.rewind(2); // SDK branch retaining the user but not its following recall
    await f.prompt(a);
    expect(recalls(a)).toHaveLength(1);
    const old = session(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        type: "message",
        message: { role: "user", content: "old prompt" },
      }))
    );
    old.entries.push(...a.entries); // unrelated saved recall must not bypass the history budget
    await f.prompt(old);
    expect(recalls(old)).toHaveLength(0);
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(1);
  });

  it("isolates full histories for concurrent sessions and ignores custom-message runs", async () => {
    const f = fixture();
    const a = session();
    const b = session();
    await f.prompt(a, ""); // custom run is not the first user prompt
    expect(recalls(a)).toHaveLength(0);
    await Promise.all([f.prompt(a, "GOAL-A"), f.prompt(b, "GOAL-B")]);
    expect(recalls(a)[0].content).toContain("GOAL-A");
    expect(recalls(a)[0].content).not.toContain("GOAL-B");
    expect(recalls(b)[0].content).toContain("GOAL-B");
    expect(recalls(b)[0].content).not.toContain("GOAL-A");
    expect(a.branch).not.toBe(b.branch);
    expect(f.request(a)).not.toEqual(f.request(b));
    await f.prompt(a, "");
    expect(recalls(a)).toHaveLength(1);
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
  });

  it.each(["reflect", "recall", "none"] as const)(
    "honors autoInject=%s without later re-injection",
    async (autoInject) => {
      const f = fixture({ autoInject });
      const a = session();
      await f.prompt(a);
      await f.reload();
      await f.prompt(a);
      expect(f.client.reflect).toHaveBeenCalledTimes(autoInject === "reflect" ? 1 : 0);
      expect(f.client.recallObservations).toHaveBeenCalledTimes(autoInject === "recall" ? 1 : 0);
      expect(f.client.searchKnowledgePages).not.toHaveBeenCalled();
      expect(recalls(a)).toHaveLength(autoInject === "none" ? 0 : 1);
    }
  );

  it.each(["empty", "failure"])(
    "retries an %s opening retrieval on the next prompt after reload",
    async (outcome) => {
      const f = fixture();
      const a = session();
      if (outcome === "empty") f.client.searchKnowledgePages.mockResolvedValueOnce([]);
      else f.client.searchKnowledgePages.mockRejectedValueOnce(new Error("offline"));
      await f.prompt(a);
      await f.reload();
      await f.prompt(a);
      expect(recalls(a)).toHaveLength(1);
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
      expect(recalls(a)[0].parentId).toBe(a.branch.filter((e) => e.message?.role === "user")[1].id);
      await f.prompt(a);
      expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["pages", "recall"] as const)(
    "bounds empty %s retrievals to five user turns",
    async (autoInject) => {
      const f = fixture({ autoInject });
      f.client.searchKnowledgePages.mockResolvedValue([]);
      f.client.recallObservations.mockResolvedValue([]);
      const a = session();
      for (let turn = 1; turn <= 8; turn++) {
        if (turn === 3 || turn === 6) await f.reload();
        await f.prompt(a, `turn ${turn}`);
      }
      const source =
        autoInject === "pages" ? f.client.searchKnowledgePages : f.client.recallObservations;
      expect(source).toHaveBeenCalledTimes(5);
      expect(recalls(a)).toHaveLength(0);
    }
  );

  it.each(["pages", "recall", "reflect"] as const)(
    "bounds failed %s retrievals to two attempts",
    async (autoInject) => {
      const f = fixture({ autoInject });
      f.client.searchKnowledgePages.mockRejectedValue(new Error("offline"));
      f.client.recallObservations.mockRejectedValue(new Error("offline"));
      f.client.reflect.mockRejectedValue(new Error("offline"));
      const a = session();
      for (let i = 0; i < 8; i++) await f.prompt(a);
      const source =
        autoInject === "pages"
          ? f.client.searchKnowledgePages
          : autoInject === "recall"
            ? f.client.recallObservations
            : f.client.reflect;
      expect(source).toHaveBeenCalledTimes(2);
    }
  );

  it.each([undefined, 503])(
    "retries reflect timeout/5xx (%s), then persists a fallback exactly once",
    async (status) => {
      const f = fixture({ autoInject: "reflect" });
      f.client.reflect.mockRejectedValue(
        new ReflectError("unavailable", status, status === undefined)
      );
      f.client.searchKnowledgePages.mockResolvedValueOnce([]);
      f.client.recallObservations.mockResolvedValueOnce([]);
      const a = session();
      await f.prompt(a);
      expect(recalls(a)).toHaveLength(0);
      await f.prompt(a, "real goal");
      await f.prompt(a);
      expect(f.client.reflect).toHaveBeenCalledTimes(2);
      expect(recalls(a)[0].content).toContain("PAGE-HIT:real goal");
    }
  );

  it.each(["empty", "permanent"])("stops immediately after reflect %s", async (outcome) => {
    const f = fixture({ autoInject: "reflect" });
    if (outcome === "empty") f.client.reflect.mockResolvedValue("");
    else f.client.reflect.mockRejectedValue(new ReflectError("unauthorized", 401, false));
    const a = session();
    for (let i = 0; i < 6; i++) await f.prompt(a);
    expect(f.client.reflect).toHaveBeenCalledTimes(1);
    expect(f.client.searchKnowledgePages).not.toHaveBeenCalled();
  });

  it("allows at most one more failed retrieval after losing process state, never after five user turns", async () => {
    const f = fixture();
    f.client.searchKnowledgePages.mockRejectedValue(new Error("offline"));
    const a = session();
    await f.prompt(a);
    await f.prompt(a);
    await f.reload();
    for (let i = 0; i < 6; i++) await f.prompt(a);
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(3);
    await f.reload();
    await f.prompt(a);
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(3);
  });

  it.each(["pages", "reflect"] as const)(
    "consumes cold-start defer for %s, then retries with a stable prefix",
    async (autoInject) => {
      const f = fixture({ autoInject });
      // The seed is isolated; exercise the real RuntimeCore's handoff of its cold-bank decision.
      Object.assign(f.host.core, { deferInitialReflect: true });
      const a = session();
      await f.prompt(a, "turn 1");
      expect(f.client.searchKnowledgePages).not.toHaveBeenCalled();
      expect(f.client.reflect).not.toHaveBeenCalled();
      expect(recalls(a)).toHaveLength(0);
      const previous = f.request(a);
      await f.prompt(a, "turn 2");
      expect(f.request(a).slice(0, previous.length)).toEqual(previous);
      expect(recalls(a)).toHaveLength(1);
      expect((f.host.core as unknown as { deferInitialReflect: boolean }).deferInitialReflect).toBe(
        false
      );
    }
  );

  it("logs reflect goal notices and inject_empty without changing the stable section", async () => {
    const f = fixture();
    const info = vi.spyOn(log, "info");
    const diag = vi.spyOn(diagnostics, "diag");
    const a = session();
    f.client.searchKnowledgePages.mockResolvedValueOnce([]);
    await f.prompt(a);
    expect(diag).toHaveBeenCalledWith("pi", "inject_empty", { session: a.id });
    await f.prompt(a, "real goal");
    expect(info).toHaveBeenCalledWith("pi", "reflect goal", { preview: expect.any(String) });
  });

  it("logs the rejected version only once per workspace", async () => {
    const diag = vi.spyOn(diagnostics, "diag");
    const f = fixture({}, "1.3.9");
    const a = session();
    await f.prompt(a);
    await f.prompt(a);
    expect(diag.mock.calls.filter((c) => c[1] === "stable_context_disabled")).toEqual([
      ["pi", "stable_context_disabled", { version: "1.3.9" }],
    ]);
  });

  it("does not let a failed sibling stop an edited opening goal", async () => {
    const f = fixture({ autoInject: "reflect" });
    f.client.reflect.mockResolvedValueOnce("");
    const a = session();
    await f.prompt(a, "original goal");
    a.rewind(1);
    await f.prompt(a, "edited goal");
    expect(f.client.reflect).toHaveBeenCalledTimes(2);
    expect(recalls(a)).toHaveLength(1);
  });

  it("does not reuse a saved recall at a later user turn even if its original user survives", async () => {
    const f = fixture();
    const a = session();
    await f.prompt(a, "original goal");
    a.rewind(2);
    a.append({ type: "message", message: { role: "user", content: "another branch goal" } });
    await f.prompt(a, "current goal");
    expect(recalls(a)[0].content).toContain("PAGE-HIT:current goal");
    expect(f.client.searchKnowledgePages).toHaveBeenCalledTimes(2);
  });

  it("honors a later autoInject=none even when an abandoned branch has a saved recall", async () => {
    const f = fixture();
    const a = session();
    await f.prompt(a);
    a.rewind(1);
    const disabled = fixture({ autoInject: "none" });
    await disabled.prompt(a);
    expect(recalls(a)).toHaveLength(0);
    expect(disabled.client.searchKnowledgePages).not.toHaveBeenCalled();
  });

  it("does not guess delivery state when getBranch is unavailable", async () => {
    const f = fixture();
    const sections: Record<string, string> = {};
    const result = await f.host.handlers.before_agent_start(
      { prompt: "hello", systemPrompt: "Pi", systemPromptOptions: { sections } },
      { sessionManager: { getSessionId: () => "unknown-branch" } }
    );
    expect(sections.hindsight).toContain("ORIGINAL-GUIDANCE");
    expect(result).toBeUndefined();
    expect(f.client.searchKnowledgePages).not.toHaveBeenCalled();
  });

  it("does not turn an inventory failure into a false zero-page report", async () => {
    const f = fixture();
    const a = session();
    f.client.listPages.mockRejectedValue(new Error("offline"));
    await f.prompt(a);
    expect(recalls(a)[0].content).toContain("PAGE-HIT");
    expect(recalls(a)[0].content).not.toContain("knowledge_inventory");
  });

  it.each(["0.80.10", "0.87.1", "1.3.9", "unknown"])(
    "keeps Pi %s on the legacy path even with sections",
    async (version) => {
      const f = fixture({}, version);
      const out = await f.prompt(session());
      expect(out.sections.hindsight).toContain("PAGE-HIT");
      expect(out.result).toBeUndefined();
    }
  );

  it("keeps Prime Agent on the legacy path even with a modern version and sections", async () => {
    const f = fixture({}, "1.4.0", "prime-agent");
    const out = await f.prompt(session());
    expect(out.sections.hindsight).toContain("PAGE-HIT");
    expect(out.result).toBeUndefined();
  });

  it.each([undefined, "", "1.4", "0.87.1", "1.3.99"])("fails closed for version %s", (version) => {
    expect(usesStablePiContext(version)).toBe(false);
  });
  it.each([
    "1.4.0",
    "1.4.1",
    "1.14.0",
    "2.0.0",
    "1.4.0+bolt",
    "v1.4.0",
    "1.4.0-rc.1",
    "v1.4.0-beta+bolt",
  ])("accepts version %s", (version) => {
    expect(usesStablePiContext(version)).toBe(true);
  });

  it("preserves bounded legacy counters across shutdown and same-process resume", async () => {
    const f = fixture({ pageRefreshEveryTurns: 20 }, "0.87.1");
    const a = session();
    await f.prompt(a);
    expect(f.host.core.getInjection(a.id)).toBeTruthy();
    const old = f.host;
    await old.handlers.session_shutdown();
    expect(old.clear).toHaveBeenCalledOnce();
    expect(old.core.getInjection(a.id)).toBeFalsy();
    const resumed = await f.prompt(a);
    expect(resumed.sections.hindsight).toBeUndefined();
    for (let i = 0; i < 300; i++) await old.core.onPrompt(`bounded-${i}`, "hello");
    expect(
      Object.values(old.core)
        .filter((v) => v instanceof Map)
        .every((v) => v.size <= 256)
    ).toBe(true);
  });

  it.each([true, false])(
    "excludes all custom messages and old guidance snapshots from retain (branch=%s)",
    async (branchAvailable) => {
      const f = fixture();
      const a = session();
      await f.prompt(a, "actual prompt");
      a.append({
        type: "custom",
        customType: "hindsight-system-guidance",
        content: "old snapshot",
      });
      a.append({
        type: "custom_message",
        customType: "hindsight-future",
        content: "future injected data",
      });
      a.append({ type: "message", message: { role: "assistant", content: "actual answer" } });
      const ctx = branchAvailable ? a.ctx : { sessionManager: { getSessionId: () => a.id } };
      await f.host.handlers.agent_end({ messages: a.messages }, ctx);
      expect(f.host.onTranscript).toHaveBeenCalledWith(
        a.id,
        [
          { role: "user", content: "actual prompt" },
          { role: "assistant", content: "actual answer" },
        ],
        true
      );
    }
  );
});
