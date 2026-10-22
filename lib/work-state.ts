import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type WorkStatus = "open" | "blocked" | "done";
export type WorkState = {
  status: WorkStatus;
  note: string;
  updatedAt: string;
};
export type WorkStates = Record<string, WorkState>;

const WORK_STATUSES = new Set<WorkStatus>(["open", "blocked", "done"]);

function defaultStateFile(): string {
  if (process.env.DASHBOARD_DEMO === "1") {
    return resolve(".data", "demo-work-state.json");
  }
  return resolve(/*turbopackIgnore: true*/
    process.env.DASHBOARD_STATE_FILE ||
      join(process.cwd(), ".data", "work-state.json"),
  );
}

export function workKey(agent: string, id: string): string {
  return agent + ":" + id;
}

function validKey(value: string): boolean {
  return /^(claude|codex):[A-Za-z0-9._:-]{1,220}$/.test(value);
}

export async function loadWorkStates(
  file = defaultStateFile(),
): Promise<WorkStates> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([key, value]) => {
        if (!validKey(key) || !value || typeof value !== "object") return false;
        const state = value as Partial<WorkState>;
        return (
          WORK_STATUSES.has(state.status as WorkStatus) &&
          typeof state.note === "string" &&
          typeof state.updatedAt === "string"
        );
      })
      .map(([key, value]) => {
        const state = value as WorkState;
        return [
          key,
          {
            status: state.status,
            note: state.note.slice(0, 280),
            updatedAt: state.updatedAt,
          },
        ];
      }),
  );
}

export async function saveWorkState(
  key: string,
  status: string,
  note: string,
  file = defaultStateFile(),
): Promise<void> {
  if (!validKey(key)) throw new Error("Invalid session ID");
  if (status !== "auto" && !WORK_STATUSES.has(status as WorkStatus)) {
    throw new Error("Invalid work status");
  }

  const states = await loadWorkStates(file);
  const cleanNote = note.trim().slice(0, 280);

  if (status === "auto" && !cleanNote) {
    delete states[key];
  } else {
    states[key] = {
      status:
        status === "auto"
          ? states[key]?.status || "open"
          : (status as WorkStatus),
      note: cleanNote,
      updatedAt: new Date().toISOString(),
    };
  }

  await mkdir(dirname(file), { recursive: true });
  // ponytail: single-user atomic file; move to SQLite only if concurrent users appear.
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(states, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}
