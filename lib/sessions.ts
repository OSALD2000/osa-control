import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type AgentKind = "claude" | "codex";

export type TokenUsage = {
  input: number;
  output: number;
  cached: number;
  total: number;
};

export type DayActivity = {
  events: number;
  prompts: number;
  messages: number;
  toolCalls: number;
  activeMs: number;
  firstAt: string;
  lastAt: string;
  hours: number[];
  tokens: TokenUsage;
  tasks: string[];
  outcome: string;
};

export type SessionRecord = {
  id: string;
  agent: AgentKind;
  title: string;
  summary: string;
  cwd: string;
  project: string;
  model: string;
  startedAt: string;
  lastAt: string;
  fileModifiedAt: string;
  isSubagent: boolean;
  prompts: number;
  messages: number;
  toolCalls: number;
  tools: Array<{ name: string; count: number }>;
  tokens: TokenUsage;
  daily: Record<string, DayActivity>;
};

export type SourceStatus = {
  agent: AgentKind;
  root: string;
  files: number;
  error?: string;
};

export type DashboardData = {
  sessions: SessionRecord[];
  sources: SourceStatus[];
  scannedAt: string;
};

type JsonObject = Record<string, unknown>;
type FileSource = { file: string; agent: AgentKind };
type CacheEntry = { fingerprint: string; session: SessionRecord };
type LoadOptions = {
  roots?: Partial<Record<AgentKind, string>>;
  disableCache?: boolean;
};

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || "Europe/Berlin";
const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const HOUR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});
const EMPTY_TOKENS = (): TokenUsage => ({
  input: 0,
  output: 0,
  cached: 0,
  total: 0,
});
const sessionCache = new Map<string, CacheEntry>();

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const block = object(item);
      const type = string(block.type);
      if (!["text", "input_text", "output_text"].includes(type)) return "";
      return string(block.text) || string(block.content);
    })
    .filter(Boolean);
}

function contentText(value: unknown): string {
  return contentTexts(value).join(" ");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function usefulPrompt(value: string): boolean {
  const text = cleanText(value);
  if (text.length < 3) return false;
  return !(
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<skills_instructions>") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("<command-name>/clear") ||
    text.startsWith("[Request interrupted by user") ||
    text.startsWith("The following is the Codex agent history") ||
    text.startsWith("The Codex agent has requested")
  );
}

function shortTitle(value: string): string {
  const text = cleanText(value);
  return text.length > 110 ? text.slice(0, 107) + "…" : text;
}

function promptTitle(value: string): string {
  const paragraphs = value
    .split(/\n\s*\n/)
    .map(cleanText)
    .filter(usefulPrompt);
  const readable = paragraphs.find(
    (text) =>
      text.length <= 320 &&
      !/^(at |caused by:|traceback|>>>|\[|\{)/i.test(text),
  );
  return shortTitle(readable || paragraphs[0] || value);
}

function outcomeText(value: string): string {
  const text = cleanText(value);
  return text.length > 240 ? text.slice(0, 237) + "…" : text;
}

function usageFrom(value: unknown): TokenUsage {
  const usage = object(value);
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  const cached =
    number(usage.cached_input_tokens) +
    number(usage.cache_read_input_tokens) +
    number(usage.cache_creation_input_tokens) +
    number(usage.cache_write_input_tokens);
  return {
    input,
    output,
    cached,
    total: number(usage.total_tokens) || input + output + cached,
  };
}

function addUsage(target: TokenUsage, value: TokenUsage): void {
  target.input += value.input;
  target.output += value.output;
  target.cached += value.cached;
  target.total += value.total;
}

function usageDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const delta = (next: number, before: number) =>
    next >= before ? next - before : next;
  return {
    input: delta(current.input, previous.input),
    output: delta(current.output, previous.output),
    cached: delta(current.cached, previous.cached),
    total: delta(current.total, previous.total),
  };
}

export function dayKey(date: Date): string {
  const parts = Object.fromEntries(
    DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return [parts.year, parts.month, parts.day].join("-");
}

export function shiftDay(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + amount, 12));
  return shifted.toISOString().slice(0, 10);
}

function projectName(cwd: string): string {
  if (!cwd) return "No project";
  return basename(cwd) || cwd;
}

function defaultRoots(): Record<AgentKind, string> {
  if (process.env.DASHBOARD_DEMO === "1") {
    return {
      claude: resolve("demo", "claude"),
      codex: resolve("demo", "codex"),
    };
  }
  return {
    claude: resolve(/*turbopackIgnore: true*/
      process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
    ),
    codex: resolve(/*turbopackIgnore: true*/
      process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"),
    ),
  };
}

async function scanRoot(
  root: string,
  agent: AgentKind,
): Promise<{ source: SourceStatus; files: FileSource[] }> {
  const files: FileSource[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push({ file: path, agent });
        }
      }),
    );
  }

  try {
    await walk(root);
    return { source: { agent, root, files: files.length }, files };
  } catch (error) {
    const code = object(error).code;
    return {
      source: {
        agent,
        root,
        files: 0,
        error:
          code === "ENOENT"
            ? "Directory not found"
            : error instanceof Error
              ? error.message
              : "Could not read source",
      },
      files: [],
    };
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

async function parseSession(
  file: string,
  agent: AgentKind,
  modifiedAt: Date,
): Promise<SessionRecord> {
  const daily: Record<string, DayActivity> = {};
  const lastEventByDay = new Map<string, number>();
  const tools = new Map<string, number>();
  const fileId = basename(file, ".jsonl");
  let id = fileId;
  let cwd = "";
  let model = "";
  let title = "";
  let summary = "";
  let fallbackTitle = "";
  let isSubagent = fileId.startsWith("agent-");
  let prompts = 0;
  let messages = 0;
  let toolCalls = 0;
  let startedMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;
  let previousCodexUsage = EMPTY_TOKENS();
  const tokens = EMPTY_TOKENS();
  const seenPrompts = new Set<string>();
  const seenMessages = new Set<string>();

  function touch(timestamp: unknown): DayActivity | undefined {
    const time = Date.parse(string(timestamp));
    if (!Number.isFinite(time)) return undefined;
    startedMs = Math.min(startedMs, time);
    lastMs = Math.max(lastMs, time);

    const date = new Date(time);
    const day = dayKey(date);
    const existing = daily[day];
    const activity =
      existing ||
      (daily[day] = {
        events: 0,
        prompts: 0,
        messages: 0,
        toolCalls: 0,
        activeMs: 60_000,
        firstAt: date.toISOString(),
        lastAt: date.toISOString(),
        hours: Array.from({ length: 24 }, () => 0),
        tokens: EMPTY_TOKENS(),
        tasks: [],
        outcome: "",
      });

    activity.events += 1;
    activity.firstAt =
      Date.parse(activity.firstAt) <= time
        ? activity.firstAt
        : date.toISOString();
    activity.lastAt =
      Date.parse(activity.lastAt) >= time ? activity.lastAt : date.toISOString();
    const hour = Number(HOUR_FORMATTER.format(date));
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
      activity.hours[hour] += 1;
    }

    const previous = lastEventByDay.get(day);
    if (previous !== undefined && time > previous) {
      activity.activeMs += Math.min(time - previous, 10 * 60_000);
    }
    lastEventByDay.set(day, Math.max(previous || 0, time));
    return activity;
  }

  function countPrompt(activity: DayActivity | undefined, value: string): void {
    if (!usefulPrompt(value)) return;
    const task = promptTitle(value);
    if (!task || seenPrompts.has(task)) return;
    seenPrompts.add(task);
    prompts += 1;
    messages += 1;
    if (activity) {
      activity.prompts += 1;
      activity.messages += 1;
      activity.tasks.push(task);
    }
    if (!title) title = task;
  }

  function saveOutcome(
    activity: DayActivity | undefined,
    value: string,
  ): void {
    if (!value) return;
    const outcome = outcomeText(value);
    if (!outcome) return;
    summary = outcome;
    if (activity) activity.outcome = outcome;
  }

  function countMessage(
    activity: DayActivity | undefined,
    value = "",
  ): void {
    const message = outcomeText(value);
    if (message && seenMessages.has(message)) return;
    if (message) seenMessages.add(message);
    messages += 1;
    if (activity) activity.messages += 1;
    saveOutcome(activity, message);
  }

  function countTool(activity: DayActivity | undefined, value: unknown): void {
    const name = string(value) || "Tool";
    toolCalls += 1;
    tools.set(name, (tools.get(name) || 0) + 1);
    if (activity) activity.toolCalls += 1;
  }

  function countUsage(
    activity: DayActivity | undefined,
    usage: TokenUsage,
  ): void {
    addUsage(tokens, usage);
    if (activity) addUsage(activity.tokens, usage);
  }

  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let event: JsonObject;
    try {
      event = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }

    const activity = touch(event.timestamp);
    const type = string(event.type);

    if (agent === "codex") {
      const payload = object(event.payload);
      const payloadType = string(payload.type);

      if (type === "session_meta") {
        id = string(payload.id) || string(payload.session_id) || id;
        cwd = string(payload.cwd) || cwd;
        isSubagent = Boolean(payload.parent_thread_id) || isSubagent;
      }
      if (type === "turn_context") {
        cwd = string(payload.cwd) || cwd;
        model = string(payload.model) || model;
      }
      if (type === "event_msg" && payloadType === "user_message") {
        countPrompt(activity, string(payload.message));
      }
      if (type === "event_msg" && payloadType === "agent_message") {
        countMessage(activity, string(payload.message));
      }
      if (type === "event_msg" && payloadType === "task_complete") {
        saveOutcome(activity, string(payload.last_agent_message));
      }
      if (type === "event_msg" && payloadType === "token_count") {
        const info = object(payload.info);
        const current = usageFrom(info.total_token_usage);
        const delta = usageDelta(current, previousCodexUsage);
        previousCodexUsage = current;
        countUsage(activity, delta);
      }
      if (type === "response_item" && payloadType === "custom_tool_call") {
        countTool(activity, payload.name);
      }
      if (type === "response_item" && payloadType === "message") {
        const role = string(payload.role);
        if (role === "user") {
          contentTexts(payload.content).forEach((text) =>
            countPrompt(activity, text),
          );
        }
        if (role === "assistant") {
          countMessage(activity, contentText(payload.content));
        }
      }
    } else {
      const message = object(event.message);
      id = string(event.sessionId) || string(event.session_id) || id;
      cwd = string(event.cwd) || cwd;
      isSubagent = Boolean(event.isSidechain) || isSubagent;

      if (type === "ai-title" && string(event.aiTitle)) {
        title = shortTitle(string(event.aiTitle));
      }
      if (type === "last-prompt" && string(event.lastPrompt)) {
        fallbackTitle = shortTitle(string(event.lastPrompt));
      }
      if (type === "user" && !event.isMeta) {
        contentTexts(message.content).forEach((text) =>
          countPrompt(activity, text),
        );
      }
      if (type === "assistant") {
        countMessage(activity, contentText(message.content));
        model = string(message.model) || model;
        if (message.usage) countUsage(activity, usageFrom(message.usage));
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            const block = object(item);
            if (block.type === "tool_use") countTool(activity, block.name);
          }
        }
      }
    }
  }

  if (!Number.isFinite(startedMs)) {
    startedMs = modifiedAt.getTime();
    lastMs = modifiedAt.getTime();
    touch(modifiedAt.toISOString());
  }

  const generatedFallback =
    (agent === "claude" ? "Claude" : "Codex") + " · " + projectName(cwd);

  return {
    id,
    agent,
    title: title || fallbackTitle || summary || generatedFallback,
    summary,
    cwd,
    project: projectName(cwd),
    model: model || "unknown",
    startedAt: new Date(startedMs).toISOString(),
    lastAt: new Date(lastMs).toISOString(),
    fileModifiedAt: modifiedAt.toISOString(),
    isSubagent,
    prompts,
    messages,
    toolCalls,
    tools: [...tools]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    tokens,
    daily,
  };
}

async function loadFile(
  source: FileSource,
  disableCache: boolean,
): Promise<SessionRecord | null> {
  try {
    const metadata = await stat(source.file);
    const fingerprint = metadata.mtimeMs + ":" + metadata.size;
    const cached = sessionCache.get(source.file);
    if (!disableCache && cached?.fingerprint === fingerprint) {
      return cached.session;
    }
    const session = await parseSession(source.file, source.agent, metadata.mtime);
    if (!disableCache) {
      sessionCache.set(source.file, { fingerprint, session });
    }
    return session;
  } catch {
    return null;
  }
}

export async function loadDashboardData(
  options: LoadOptions = {},
): Promise<DashboardData> {
  const defaults = defaultRoots();
  const roots = {
    claude: resolve(/*turbopackIgnore: true*/process.env.DASHBOARD_DEMO === "1" ? defaults.claude : options.roots?.claude || defaults.claude),
    codex: resolve(/*turbopackIgnore: true*/process.env.DASHBOARD_DEMO === "1" ? defaults.codex : options.roots?.codex || defaults.codex),
  };
  const scans = await Promise.all([
    scanRoot(roots.claude, "claude"),
    scanRoot(roots.codex, "codex"),
  ]);
  const files = scans.flatMap((scan) => scan.files);
  const parsed = await mapLimit(files, 12, (source) =>
    loadFile(source, Boolean(options.disableCache)),
  );

  return {
    sessions: parsed
      .filter((session): session is SessionRecord => Boolean(session))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
    sources: scans.map((scan) => scan.source),
    scannedAt: new Date().toISOString(),
  };
}
