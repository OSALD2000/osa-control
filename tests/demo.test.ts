import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDashboardData } from "../lib/sessions.ts";
import { loadWorkStates, saveWorkState } from "../lib/work-state.ts";

test("demo ignores personal sources and status, including when fixtures are missing", async () => {
  const cwd = process.cwd();
  const previous = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "osa-demo-"));
  try {
    await cp(join(cwd, "demo"), join(root, "demo"), { recursive: true });
    const personal = join(root, "personal");
    await mkdir(personal);
    await writeFile(join(personal, "private.jsonl"), JSON.stringify({
      timestamp: "2026-08-19T08:00:00.000Z",
      type: "session_meta",
      payload: { id: "private-sentinel", cwd: "/private-sentinel" },
    }));
    const stateFile = join(root, "personal-state.json");
    await writeFile(stateFile, "{}");
    process.chdir(root);
    process.env.DASHBOARD_DEMO = "1";
    process.env.CLAUDE_PROJECTS_DIR = personal;
    process.env.CODEX_SESSIONS_DIR = personal;
    process.env.DASHBOARD_STATE_FILE = stateFile;

    const data = await loadDashboardData({
      roots: { claude: personal, codex: personal }, disableCache: true,
    });
    assert.deepEqual(data.sessions.map(s => s.id).sort(), ["demo-claude", "demo-codex"]);
    assert.ok(data.sessions.every(s => s.cwd === "/demo/catalog"));
    await saveWorkState("codex:demo-codex", "done", "Demo only");
    assert.equal((await loadWorkStates())["codex:demo-codex"].status, "done");
    assert.equal(await readFile(stateFile, "utf8"), "{}");
    const demoState = JSON.parse(await readFile(join(root, ".data/demo-work-state.json"), "utf8"));
    assert.equal(demoState["codex:demo-codex"].note, "Demo only");

    await rm(join(root, "demo"), { recursive: true });
    const missing = await loadDashboardData({ disableCache: true });
    assert.deepEqual(missing.sessions, []);
    assert.ok(missing.sources.every(source => source.error));
  } finally {
    process.chdir(cwd);
    for (const key of ["DASHBOARD_DEMO", "CLAUDE_PROJECTS_DIR", "CODEX_SESSIONS_DIR", "DASHBOARD_STATE_FILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
