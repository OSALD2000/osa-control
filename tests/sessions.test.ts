import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { loadDashboardData } from "../lib/sessions.ts";
import { loadWorkStates, saveWorkState } from "../lib/work-state.ts";

test("liest Claude- und Codex-JSONL ohne kumulative Tokens doppelt zu zählen", async () => {
  const root = await mkdtemp(join(tmpdir(), "osa-dashboard-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  await mkdir(claude, { recursive: true });
  await mkdir(codex, { recursive: true });

  const codexEvents = [
    {
      timestamp: "2026-08-19T08:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-1", cwd: "/work/checkout" },
    },
    {
      timestamp: "2026-08-19T08:01:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    },
    {
      timestamp: "2026-08-19T08:02:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Checkout-Fehler beheben" },
    },
    {
      timestamp: "2026-08-19T08:03:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 10,
            total_tokens: 130,
          },
        },
      },
    },
    {
      timestamp: "2026-08-19T08:04:00.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "shell" },
    },
    {
      timestamp: "2026-08-19T08:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 120,
            output_tokens: 35,
            cached_input_tokens: 15,
            total_tokens: 170,
          },
        },
      },
    },
    {
      timestamp: "2026-08-19T08:06:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "Checkout-Fehler korrigiert und getestet.",
      },
    },
  ];
  const claudeEvents = [
    {
      type: "ai-title",
      aiTitle: "Login aufräumen",
      sessionId: "claude-1",
    },
    {
      timestamp: "2026-08-19T09:00:00.000Z",
      type: "user",
      sessionId: "claude-1",
      cwd: "/work/login",
      message: { content: "Login-Flow vereinfachen" },
    },
    {
      timestamp: "2026-08-19T09:02:00.000Z",
      type: "assistant",
      sessionId: "claude-1",
      cwd: "/work/login",
      message: {
        model: "claude-test",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
        },
        content: [{ type: "tool_use", name: "Edit" }],
      },
    },
  ];
  const responseOnlyEvents = [
    {
      timestamp: "2026-08-19T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-2", cwd: "/work/ratings" },
    },
    {
      timestamp: "2026-08-19T10:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions\n\n@RTK.md" },
          { type: "input_text", text: "<environment_context>intern</environment_context>" },
        ],
      },
    },
    {
      timestamp: "2026-08-19T10:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Rating-Tabelle sortierbar machen" },
        ],
      },
    },
    {
      timestamp: "2026-08-19T10:03:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Sortierung umgesetzt und geprüft." },
        ],
      },
    },
  ];

  await writeFile(
    join(codex, "rollout-test.jsonl"),
    codexEvents.map((event) => JSON.stringify(event)).join("\n"),
  );
  await writeFile(
    join(codex, "response-only.jsonl"),
    responseOnlyEvents.map((event) => JSON.stringify(event)).join("\n"),
  );
  await writeFile(
    join(claude, "claude-test.jsonl"),
    claudeEvents.map((event) => JSON.stringify(event)).join("\n"),
  );

  try {
    const result = await loadDashboardData({
      roots: { claude, codex },
      disableCache: true,
    });
    assert.equal(result.sessions.length, 3);

    const codexSession = result.sessions.find(
      (session) => session.id === "codex-1",
    );
    const claudeSession = result.sessions.find(
      (session) => session.agent === "claude",
    );
    const responseOnlySession = result.sessions.find(
      (session) => session.id === "codex-2",
    );
    assert.ok(codexSession);
    assert.ok(claudeSession);
    assert.ok(responseOnlySession);
    assert.equal(codexSession.title, "Checkout-Fehler beheben");
    assert.equal(codexSession.tokens.total, 170);
    assert.equal(codexSession.toolCalls, 1);
    assert.equal(codexSession.summary, "Checkout-Fehler korrigiert und getestet.");
    assert.deepEqual(codexSession.daily["2026-08-19"].tasks, [
      "Checkout-Fehler beheben",
    ]);
    assert.equal(
      codexSession.daily["2026-08-19"].outcome,
      "Checkout-Fehler korrigiert und getestet.",
    );
    assert.equal(responseOnlySession.title, "Rating-Tabelle sortierbar machen");
    assert.equal(responseOnlySession.summary, "Sortierung umgesetzt und geprüft.");
    assert.equal(responseOnlySession.prompts, 1);
    assert.equal(claudeSession.title, "Login aufräumen");
    assert.equal(claudeSession.tokens.total, 65);
    assert.equal(claudeSession.toolCalls, 1);
    assert.equal(codexSession.daily["2026-08-19"].prompts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("speichert offene Arbeit lokal und kann sie wieder freigeben", async () => {
  const root = await mkdtemp(join(tmpdir(), "osa-work-state-"));
  const file = join(root, "work-state.json");

  try {
    await saveWorkState(
      "codex:session-1",
      "open",
      "  Checkout erneut prüfen  ",
      file,
    );
    const stored = await loadWorkStates(file);
    assert.equal(stored["codex:session-1"].status, "open");
    assert.equal(stored["codex:session-1"].note, "Checkout erneut prüfen");

    await saveWorkState("codex:session-1", "auto", "", file);
    assert.deepEqual(await loadWorkStates(file), {});
    await assert.rejects(
      saveWorkState("fremd:session-1", "open", "", file),
      /Invalid session ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
