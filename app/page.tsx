import { homedir } from "node:os";
import {
  dayKey,
  loadDashboardData,
  shiftDay,
  type AgentKind,
  type DayActivity,
  type SessionRecord,
  type TokenUsage,
} from "../lib/sessions";
import {
  loadWorkStates,
  workKey,
  type WorkState,
  type WorkStatus,
} from "../lib/work-state";
import { updateWorkState } from "./actions";
import { CopyCommand } from "./copy-command";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;
type PageProps = { searchParams: Promise<SearchParams> };

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || "Europe/Berlin";
const ZERO_TOKENS = (): TokenUsage => ({
  input: 0,
  output: 0,
  cached: 0,
  total: 0,
});
const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  open: "Open",
  blocked: "Blocked",
  done: "Done",
};

function value(param: string | string[] | undefined): string {
  return Array.isArray(param) ? param[0] || "" : param || "";
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("en-GB", {
    notation: tokens >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(tokens);
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? hours + " h " + rest + " min" : hours + " h";
}

function formatDate(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(timestamp));
}

function formatMoment(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(timestamp));
}

function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

function mergeTokens(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cached += source.cached;
  target.total += source.total;
}

function aggregateDay(sessions: SessionRecord[], day: string) {
  const tokens = ZERO_TOKENS();
  const hours = Array.from({ length: 24 }, () => 0);
  const projects = new Map<
    string,
    {
      sessions: number;
      events: number;
      tasks: number;
      activeMs: number;
      tokens: number;
    }
  >();
  const tools = new Map<string, number>();
  let prompts = 0;
  let messages = 0;
  let toolCalls = 0;
  let events = 0;
  let activeMs = 0;
  let firstAt = "";
  let lastAt = "";

  for (const session of sessions) {
    const activity = session.daily[day];
    if (!activity) continue;
    prompts += activity.prompts;
    messages += activity.messages;
    toolCalls += activity.toolCalls;
    events += activity.events;
    activeMs += activity.activeMs;
    mergeTokens(tokens, activity.tokens);
    activity.hours.forEach((count, hour) => {
      hours[hour] += count;
    });
    if (!firstAt || Date.parse(activity.firstAt) < Date.parse(firstAt)) {
      firstAt = activity.firstAt;
    }
    if (!lastAt || Date.parse(activity.lastAt) > Date.parse(lastAt)) {
      lastAt = activity.lastAt;
    }

    const project = projects.get(session.project) || {
      sessions: 0,
      events: 0,
      tasks: 0,
      activeMs: 0,
      tokens: 0,
    };
    project.sessions += 1;
    project.events += activity.events;
    project.tasks += activity.tasks.length;
    project.activeMs += activity.activeMs;
    project.tokens += activity.tokens.total;
    projects.set(session.project, project);

    for (const tool of session.tools) {
      tools.set(tool.name, (tools.get(tool.name) || 0) + tool.count);
    }
  }

  return {
    tokens,
    hours,
    prompts,
    messages,
    toolCalls,
    events,
    activeMs,
    firstAt,
    lastAt,
    projects: [...projects]
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.activeMs - a.activeMs),
    tools: [...tools]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function sessionStatus(session: SessionRecord, now: number) {
  const ageMinutes = (now - Date.parse(session.fileModifiedAt)) / 60_000;
  if (ageMinutes <= 15) return { label: "Active now", tone: "live" };
  if (ageMinutes <= 24 * 60) return { label: "Seen today", tone: "recent" };
  return { label: "Saved", tone: "saved" };
}

function queryHref(
  current: {
    day: string;
    agent: string;
    scope: string;
    subagents: string;
    search: string;
  },
  changes: Partial<typeof current> = {},
): string {
  const next = { ...current, ...changes };
  const params = new URLSearchParams();
  params.set("day", next.day);
  if (next.agent !== "all") params.set("agent", next.agent);
  if (next.scope !== "day") params.set("scope", next.scope);
  if (next.subagents === "include") params.set("subagents", "include");
  if (next.search) params.set("q", next.search);
  return "/?" + params.toString();
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function resumeCommand(session: SessionRecord): string {
  const resume =
    session.agent === "codex"
      ? "codex resume " + shellQuote(session.id)
      : "claude --resume " + shellQuote(session.id);
  return session.cwd ? "cd " + shellQuote(session.cwd) + " && " + resume : resume;
}

function WorkStateForm({
  session,
  state,
  compact = false,
}: {
  session: SessionRecord;
  state?: WorkState;
  compact?: boolean;
}) {
  return (
    <form
      key={state?.updatedAt || "automatic"}
      className={compact ? "work-form compact" : "work-form"}
      action={updateWorkState}
    >
      <input type="hidden" name="key" value={workKey(session.agent, session.id)} />
      <select
        name="status"
        defaultValue={state?.status || "auto"}
        aria-label={"Work status for " + session.title}
      >
        <option value="auto">Automatic</option>
        <option value="open">Open</option>
        <option value="blocked">Blocked</option>
        <option value="done">Done</option>
      </select>
      <input
        name="note"
        defaultValue={state?.note || ""}
        maxLength={280}
        placeholder="Next step or blocker …"
        aria-label={"Note for " + session.title}
      />
      <button type="submit">Save</button>
    </form>
  );
}

function AgentBadge({ agent }: { agent: AgentKind }) {
  return (
    <span className={"agent-badge " + agent}>
      <span aria-hidden="true" />
      {agent === "claude" ? "Claude" : "Codex"}
    </span>
  );
}

function ActivityRail({ activity }: { activity: ReturnType<typeof aggregateDay> }) {
  const max = Math.max(1, ...activity.hours);
  return (
    <div className="rail-wrap">
      <div className="rail-label">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
      <div className="activity-rail" aria-label="Activity by hour">
        {activity.hours.map((count, hour) => (
          <div
            className={count ? "rail-hour active" : "rail-hour"}
            key={hour}
            title={hour + ":00 — " + count + " events"}
          >
            <span style={{ height: Math.max(5, (count / max) * 100) + "%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function Dashboard({ searchParams }: PageProps) {
  const params = await searchParams;
  const demo = process.env.DASHBOARD_DEMO === "1";
  const defaultDay = demo ? "2026-08-19" : shiftDay(dayKey(new Date()), -1);
  const requestedDay = value(params.day);
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay)
    ? requestedDay
    : defaultDay;
  const requestedAgent = value(params.agent);
  const agent: AgentKind | "all" =
    requestedAgent === "claude" || requestedAgent === "codex"
      ? requestedAgent
      : "all";
  const scope = value(params.scope) === "all" ? "all" : "day";
  const subagents = value(params.subagents) === "include" ? "include" : "hide";
  const search = value(params.q).trim();
  const normalizedSearch = search.toLocaleLowerCase("en-GB");
  const [data, workStates] = await Promise.all([
    loadDashboardData(),
    loadWorkStates(),
  ]);
  const now = Date.now();
  const filteredByAgent =
    agent === "all"
      ? data.sessions
      : data.sessions.filter((session) => session.agent === agent);
  const agentSessions =
    subagents === "include"
      ? filteredByAgent
      : filteredByAgent.filter((session) => !session.isSubagent);
  const daySessions = agentSessions.filter(
    (session) => Boolean(session.daily[selectedDay]),
  );
  const recap = aggregateDay(daySessions, selectedDay);
  const listBase = scope === "all" ? agentSessions : daySessions;
  const shownSessions = listBase.filter((session) => {
    if (!normalizedSearch) return true;
    return [
      session.title,
      session.summary,
      Object.values(session.daily).flatMap((activity) => activity.tasks),
      session.project,
      session.cwd,
      session.model,
    ]
      .join(" ")
      .toLocaleLowerCase("en-GB")
      .includes(normalizedSearch);
  });
  const topProject = recap.projects[0];
  const claudeCount = data.sessions.filter(
    (session) => session.agent === "claude",
  ).length;
  const codexCount = data.sessions.filter(
    (session) => session.agent === "codex",
  ).length;
  const isActive = (session: SessionRecord) =>
    now - Date.parse(session.fileModifiedAt) <= 15 * 60_000;
  const activeCount = data.sessions.filter(
    (session) => !session.isSubagent && isActive(session),
  ).length;
  const queueSessions = data.sessions
    .filter((session) => {
      if (session.isSubagent) return false;
      const state = workStates[workKey(session.agent, session.id)];
      if (state?.status === "done") return false;
      return isActive(session) || state?.status === "open" || state?.status === "blocked";
    })
    .sort((left, right) => {
      const priority = (session: SessionRecord) => {
        const status = workStates[workKey(session.agent, session.id)]?.status;
        return status === "blocked" ? 3 : status === "open" ? 2 : 1;
      };
      return (
        priority(right) - priority(left) ||
        Date.parse(right.fileModifiedAt) - Date.parse(left.fileModifiedAt)
      );
    });
  const trackedCount = queueSessions.filter((session) =>
    Boolean(workStates[workKey(session.agent, session.id)]),
  ).length;
  const trend = Array.from({ length: 7 }, (_, index) => {
    const day = shiftDay(selectedDay, index - 6);
    const sessions = agentSessions.filter((session) =>
      Boolean(session.daily[day]),
    );
    const summary = aggregateDay(sessions, day);
    const tasks = sessions.reduce(
      (sum, session) => sum + session.daily[day].tasks.length,
      0,
    );
    return { day, tasks, ...summary };
  });
  const trendMax = Math.max(1, ...trend.map((point) => point.tasks));
  const query = {
    day: selectedDay,
    agent,
    scope,
    subagents,
    search,
  };
  const workWindow =
    recap.firstAt && recap.lastAt
      ? formatTime(recap.firstAt) + "–" + formatTime(recap.lastAt)
      : "no activity";
  const recapItems = daySessions
    .filter((session) => !session.isSubagent)
    .flatMap((session) => {
      const activity = session.daily[selectedDay];
      const tasks = activity.tasks.length ? activity.tasks : [session.title];
      const state = workStates[workKey(session.agent, session.id)];
      return tasks.map((task) => ({
        task,
        outcome: activity.outcome || session.summary,
        project: session.project,
        agent: session.agent,
        state,
      }));
    })
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) =>
            candidate.task === item.task &&
            candidate.project === item.project &&
            candidate.agent === item.agent,
        ) === index,
    )
    .sort((left, right) => {
      const priority = (status?: WorkStatus) =>
        status === "blocked" ? 3 : status === "open" ? 2 : status === "done" ? 1 : 0;
      return priority(right.state?.status) - priority(left.state?.status);
    })
    .slice(0, 10);
  const dayOpen = recapItems.filter((item) => item.state?.status === "open").length;
  const dayBlocked = recapItems.filter(
    (item) => item.state?.status === "blocked",
  ).length;
  const dayDone = recapItems.filter((item) => item.state?.status === "done").length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="OSA Control home">
          <span className="brand-mark">O</span>
          <span>
            <strong>OSA Control</strong>
            <small>Agent logbook</small>
          </span>
        </a>

        <nav aria-label="Dashboard navigation">
          <a href="#queue">Continue work</a>
          <a href="#recap">Daily recap</a>
          <a href="#sessions">Sessions</a>
          <a href="#sources">Sources</a>
        </nav>

        <div className="source-pulse">
          <span className={activeCount ? "pulse live" : "pulse"} />
          <div>
            <strong>{activeCount ? activeCount + " active" : "All quiet"}</strong>
            <small>local status</small>
          </div>
        </div>

        <p className="privacy-note">
          Local only
          <br />
          No uploads
        </p>
      </aside>

      <main id="top">
        {demo && (
          <p className="demo-notice" role="status">
            Demo mode — synthetic sessions only. Personal session sources are disabled.
          </p>
        )}
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL / AGENT LOGBOOK</p>
            <h1>Your AI work.<br />Back in focus.</h1>
          </div>
          <div className="source-totals" aria-label="Discovered sessions">
            <div>
              <AgentBadge agent="claude" />
              <strong>{claudeCount}</strong>
            </div>
            <div>
              <AgentBadge agent="codex" />
              <strong>{codexCount}</strong>
            </div>
          </div>
        </header>

        <section className="live-board" id="queue">
          <div className="live-heading">
            <div>
              <p className="eyebrow">RETURN DECK</p>
              <h2>Continue work</h2>
              <p>
                {activeCount} active · {trackedCount} marked open or blocked
              </p>
            </div>
            <strong>{queueSessions.length}</strong>
          </div>
          {queueSessions.length ? (
            <div className="live-grid">
              {queueSessions.slice(0, 8).map((session) => {
                const state = workStates[workKey(session.agent, session.id)];
                const automatic = sessionStatus(session, now);
                const status = state
                  ? {
                      label: WORK_STATUS_LABELS[state.status],
                      tone: state.status,
                    }
                  : automatic;
                return (
                  <article
                    className={"live-card " + session.agent}
                    key={session.agent + session.id}
                  >
                    <div className="live-card-head">
                      <AgentBadge agent={session.agent} />
                      <span className={"status " + status.tone}>
                        <i />
                        {status.label}
                      </span>
                    </div>
                    <h3>{session.title}</h3>
                    <p className="live-summary">
                      {state?.note ||
                        session.summary ||
                        "Capture the next step before context is lost."}
                    </p>
                    <div className="live-meta">
                      <span>{session.project}</span>
                      <span>{formatMoment(session.fileModifiedAt)}</span>
                    </div>
                    <div className="resume-row">
                      <code>{resumeCommand(session)}</code>
                      <CopyCommand command={resumeCommand(session)} />
                    </div>
                    <WorkStateForm session={session} state={state} />
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="live-empty">
              No open work. Active sessions appear automatically;
              you can mark older sessions as open below.
            </p>
          )}
        </section>

        <section className="filter-panel" aria-label="Filter dashboard">
          <a
            className="date-arrow"
            href={queryHref(query, { day: shiftDay(selectedDay, -1) })}
            aria-label="Previous day"
          >
            ←
          </a>
          <form action="/" method="get">
            <label>
              Report date
              <input type="date" name="day" defaultValue={selectedDay} />
            </label>
            <label>
              Agent
              <select name="agent" defaultValue={agent}>
                <option value="all">All agents</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Sessions
              <select name="scope" defaultValue={scope}>
                <option value="day">Report date only</option>
                <option value="all">All sessions</option>
              </select>
            </label>
            <label>
              Subagents
              <select name="subagents" defaultValue={subagents}>
                <option value="hide">Hide</option>
                <option value="include">Show</option>
              </select>
            </label>
            <label className="search-field">
              Search
              <input
                type="search"
                name="q"
                defaultValue={search}
                placeholder="Task, outcome, project …"
              />
            </label>
            <button type="submit">Apply</button>
          </form>
          <a
            className="date-arrow"
            href={queryHref(query, { day: shiftDay(selectedDay, 1) })}
            aria-label="Next day"
          >
            →
          </a>
        </section>

        <section className="recap" id="recap">
          <div className="section-heading">
            <div>
              <p className="eyebrow">DAILY RECAP / {selectedDay}</p>
              <h2>{formatDate(selectedDay)}</h2>
            </div>
            <a className="refresh-link" href={queryHref(query)}>
              Refresh now
            </a>
          </div>

          <div className="recap-grid">
            <article className="recap-brief">
              <p className="recap-kicker">Summary</p>
              {daySessions.length ? (
                <>
                  <h3>
                    {recapItems.length}{" "}
                    {recapItems.length === 1 ? "task" : "tasks"}{" "}
                    worked on.
                  </h3>
                  <p>
                    Your main focus was{" "}
                    <strong>{topProject?.name || "no project"}</strong>.
                    Your activity window was {workWindow}. See your tasks
                    and latest outcomes on the right.
                  </p>
                  <div className="agent-split">
                    <span><i className="open-dot" /> {dayOpen} open</span>
                    <span><i className="blocked-dot" /> {dayBlocked} blocked</span>
                    <span><i className="done-dot" /> {dayDone} done</span>
                  </div>
                </>
              ) : (
                <>
                  <h3>No local agent activity found.</h3>
                  <p>
                    Choose another date or check below that both
                    log directories are available.
                  </p>
                </>
              )}
            </article>

            <article className="recap-worklog">
              <div className="worklog-heading">
                <div>
                  <p className="eyebrow">YOUR WORK</p>
                  <h3>What you worked on</h3>
                </div>
                <span>{recapItems.length}</span>
              </div>
              {recapItems.length ? (
                <ol className="worklog-list">
                  {recapItems.map((item, index) => (
                    <li key={item.agent + item.project + item.task + index}>
                      <strong>{item.task}</strong>
                      <span className="worklog-meta">
                        <AgentBadge agent={item.agent} />
                        {item.project}
                        {item.state && (
                          <span className={"work-state " + item.state.status}>
                            {WORK_STATUS_LABELS[item.state.status]}
                          </span>
                        )}
                      </span>
                      {item.state?.note && (
                        <p className="worklog-note">
                          Next step: {item.state.note}
                        </p>
                      )}
                      {item.outcome && item.outcome !== item.task && (
                        <p className="worklog-result">
                          Outcome: {item.outcome}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-copy">
                  No specific task has been detected for this date.
                </p>
              )}
            </article>
          </div>

          <article className="flight-recorder">
            <div>
              <p className="eyebrow">24H FLIGHT RECORDER</p>
              <strong>{workWindow}</strong>
            </div>
            <ActivityRail activity={recap} />
          </article>
        </section>

        <section className="work-grid">
          <article className="panel projects-panel">
            <div className="panel-title">
              <div>
                <p className="eyebrow">FOCUS</p>
                <h2>Projects of the day</h2>
              </div>
              <span>{recap.projects.length}</span>
            </div>
            {recap.projects.length ? (
              <ol className="project-list">
                {recap.projects.slice(0, 6).map((project) => (
                  <li key={project.name}>
                    <div>
                      <strong>{project.name}</strong>
                      <small>
                        {project.sessions} Sessions · {project.tasks} tasks
                      </small>
                    </div>
                    <span>{formatDuration(project.activeMs)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-copy">No projects for this date.</p>
            )}
          </article>

          <article className="panel trend-panel">
            <div className="panel-title">
              <div>
                <p className="eyebrow">WEEKLY VIEW</p>
                <h2>Tasks / 7 days</h2>
              </div>
              <span>{trend.reduce((sum, item) => sum + item.tasks, 0)}</span>
            </div>
            <div className="trend-chart">
              {trend.map((point) => (
                <div className="trend-day" key={point.day}>
                  <div className="bar-track" title={point.tasks + " tasks"}>
                    <span
                      style={{
                        height:
                          Math.max(5, (point.tasks / trendMax) * 100) + "%",
                      }}
                    />
                  </div>
                  <strong>{point.day.slice(8)}</strong>
                  <small>
                    {new Intl.DateTimeFormat("en-GB", {
                      weekday: "short",
                      timeZone: "UTC",
                    }).format(new Date(point.day + "T12:00:00Z"))}
                  </small>
                </div>
              ))}
            </div>
          </article>

        </section>

        <section className="sessions-section" id="sessions">
          <div className="section-heading">
            <div>
              <p className="eyebrow">CONTROL ROOM</p>
              <h2>
                {scope === "all" ? "All sessions" : "Sessions of the day"}
              </h2>
            </div>
            <span className="result-count">
              {shownSessions.length} of {listBase.length}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Session</th>
                  <th>Project</th>
                  <th>Model</th>
                  <th>Activity</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {shownSessions.map((session, index) => {
                  const workState =
                    workStates[workKey(session.agent, session.id)];
                  const status = workState
                    ? {
                        label: WORK_STATUS_LABELS[workState.status],
                        tone: workState.status,
                      }
                    : sessionStatus(session, now);
                  const activity: DayActivity | undefined =
                    session.daily[selectedDay];
                  const displayedTokens =
                    scope === "day" && activity
                      ? activity.tokens.total
                      : session.tokens.total;
                  return (
                    <tr key={session.agent + session.id + index}>
                      <td>
                        <span className={"status " + status.tone}>
                          <i />
                          {status.label}
                        </span>
                      </td>
                      <td className="session-cell">
                        <strong>{session.title}</strong>
                        <small>
                          <AgentBadge agent={session.agent} />
                          {session.isSubagent ? "Subagent" : "Main session"} ·{" "}
                          {session.prompts} prompts · {session.toolCalls} Tools
                        </small>
                        {session.summary && (
                          <small className="session-result">
                            Outcome: {session.summary}
                          </small>
                        )}
                        {!session.isSubagent && (
                          <details className="session-plan">
                            <summary>
                              {workState
                                ? WORK_STATUS_LABELS[workState.status]
                                : "Plan work"}
                            </summary>
                            <WorkStateForm
                              session={session}
                              state={workState}
                              compact
                            />
                          </details>
                        )}
                      </td>
                      <td>
                        <strong>{session.project}</strong>
                        <small className="path" title={session.cwd}>
                          {shortPath(session.cwd)}
                        </small>
                      </td>
                      <td>
                        <span className="model">{session.model}</span>
                      </td>
                      <td>
                        <strong>{formatMoment(session.lastAt)}</strong>
                        <small>
                          {activity
                            ? formatDuration(activity.activeMs)
                            : "outside this date"}
                        </small>
                      </td>
                      <td className="token-cell">
                        {formatTokens(displayedTokens)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!shownSessions.length && (
              <div className="empty-table">
                No sessions match this filter.
              </div>
            )}
          </div>
        </section>

        <section className="sources-section" id="sources">
          <div className="section-heading">
            <div>
              <p className="eyebrow">READ-ONLY INPUTS</p>
              <h2>Local sources</h2>
            </div>
            <span className="scan-time">
              Scan {formatMoment(data.scannedAt)}
            </span>
          </div>
          <div className="source-cards">
            {data.sources.map((source) => (
              <article key={source.agent}>
                <div>
                  <AgentBadge agent={source.agent} />
                  <strong>
                    {source.error ? "Unavailable" : source.files + " files"}
                  </strong>
                </div>
                <code>{shortPath(source.root)}</code>
                <small>
                  {source.error || "Read-only source · files are never modified"}
                </small>
              </article>
            ))}
          </div>
        </section>

        <footer>
          <span>OSA Control / local on 127.0.0.1</span>
          <span>Daily Recap · {selectedDay}</span>
        </footer>
      </main>
    </div>
  );
}
