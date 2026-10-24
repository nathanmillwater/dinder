import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Profile = { id: number; name: string };
type Meal = {
  id: string;
  name: string;
  notes: string;
  photo: string;
  recipe: string;
  planned?: { id: number; date: string }[];
};
type Assignment = { recipeId: string; date: string };
type Review = {
  token: string;
  summary: string[];
  assignments?: Assignment[];
  sourceEntryId?: number;
  targetEntryId?: number;
};
type Round = {
  id: string;
  mode: "planner" | "picker";
  source: "recipes" | "mealplan";
  status: string;
  startDate: string;
  today: string;
  dates: string[];
  total: number;
  current: Meal | null;
  matches: Meal[];
  progress: { id: number; count: number }[];
  review: Review | null;
  syncError: string;
  canRetry: boolean;
  result: string[] | null;
};
type Config = {
  today: string;
  nextMonday: string;
  timeZone: string;
  mealieUrl: string;
  profiles: Profile[];
};
type State = Config & { round: Round | null; recipes: Meal[] };
type Entry = {
  id: number;
  date: string;
  recipeId: string | null;
  title: string;
};
async function api<T>(
  path: string,
  profile: number,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const res = await fetch(
    "/api" + path + (path.includes("?") ? "&" : "?") + "profile=" + profile,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(
      Error("Dinder is unreachable. Reconnect to continue."),
      { status: 502 },
    );
  }
  if (!res.ok)
    throw Object.assign(Error(data.error || "Something went wrong."), {
      status: res.status,
    });
  return data;
}
function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    heart: (
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2" />
        <path d="M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7V2m0 5h-5M4 17v5m0-5h5" />
        <path d="M5 7a8 8 0 0 1 14-2l1 2M4 17l1 2a8 8 0 0 0 14-2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.heart}
    </svg>
  );
}
function Photo({ meal }: { meal: Meal }) {
  const [failed, setFailed] = useState("");
  return (
    <div className="food">
      {meal.photo && failed !== meal.photo ? (
        <img
          src={meal.photo}
          alt={meal.name}
          draggable={false}
          onError={() => setFailed(meal.photo)}
        />
      ) : (
        <div className="food-art">
          <span>🍽️</span>
          <i>✦</i>
          <small>made to share</small>
        </div>
      )}
    </div>
  );
}
const dayLabel = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(date + "T12:00:00Z"));
const active = (r: Round | null) =>
  !!r && !["complete", "cancelled", "expired"].includes(r.status);
function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [profile, setProfile] = useState(
      () => Number(localStorage.getItem("dinder-profile")) || 0,
    ),
    [round, setRound] = useState<Round | null>(null),
    [recipes, setRecipes] = useState<Meal[]>([]);
  const [screen, setScreen] = useState<"home" | "round">(() =>
    sessionStorage.getItem("dinder-screen") === "round" ? "round" : "home",
  );
  const [startDate, setStartDate] = useState(""),
    [source, setSource] = useState<"recipes" | "mealplan">("recipes"),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(false),
    [error, setError] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]),
    [choices, setChoices] = useState<Entry[]>([]),
    [sourceEntry, setSourceEntry] = useState(""),
    [targetEntry, setTargetEntry] = useState("");
  const [settings, setSettings] = useState(false),
    [names, setNames] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [drag, setDrag] = useState(0),
    [confirmCancel, setConfirmCancel] = useState(false);
  const inFlight = useRef(false),
    generation = useRef(0),
    polling = useRef(false),
    writeVersion = useRef(0),
    pointer = useRef<{ x: number; y: number } | null>(null),
    dialog = useRef<HTMLDialogElement>(null),
    voteRef = useRef<(liked: boolean) => void>(() => {});
  useEffect(() => {
    api<Config>("/config", 0)
      .then((c) => {
        setConfig(c);
        setStartDate(c.nextMonday);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    sessionStorage.setItem("dinder-screen", screen);
    window.scrollTo(0, 0);
  }, [screen]);
  useEffect(() => {
    if (![1, 2].includes(profile)) return;
    const epoch = ++generation.current;
    let stopped = false;
    const refresh = async () => {
      if (inFlight.current || polling.current) return;
      polling.current = true;
      const version = writeVersion.current;
      try {
        const data = await api<State>("/state", profile);
        if (
          !stopped &&
          epoch === generation.current &&
          version === writeVersion.current &&
          !inFlight.current
        ) {
          setConfig(data);
          setRecipes(data.recipes);
          setRound(data.round);
          setOnline(true);
        }
      } catch (e) {
        if (!stopped) {
          setOnline(false);
          setError((e as Error).message);
        }
      } finally {
        polling.current = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [profile]);
  const matchesKey = round?.matches.map((m) => m.id).join(",") || "";
  useEffect(() => {
    if (round?.mode === "planner")
      setAssignments(
        round.review?.assignments ||
          round.matches.map((m, i) => ({
            recipeId: m.id,
            date: round.dates[i],
          })),
      );
    setChoices([]);
    setSourceEntry("");
    setTargetEntry("");
  }, [round?.id, matchesKey]);
  useEffect(() => {
    if (
      round?.mode !== "picker" ||
      !round.matches.length ||
      !["review", "exhausted"].includes(round.status)
    )
      return;
    let stopped = false;
    api<{ entries: Entry[] }>("/rounds/" + round.id + "/choices", profile)
      .then(({ entries }) => {
        if (stopped) return;
        setChoices(entries);
        const sources = entries.filter(
          (e) => e.recipeId === round.matches[0]?.id,
        );
        if (
          round.review?.sourceEntryId &&
          sources.some((e) => e.id === round.review!.sourceEntryId)
        )
          setSourceEntry(String(round.review.sourceEntryId));
        else if (sources.length === 1) setSourceEntry(String(sources[0].id));
        const tonight = entries.filter((e) => e.date === round.today);
        if (
          round.review?.targetEntryId &&
          tonight.some((e) => e.id === round.review!.targetEntryId)
        )
          setTargetEntry(String(round.review.targetEntryId));
        else if (tonight.length === 1) setTargetEntry(String(tonight[0].id));
      })
      .catch((e) => {
        if (!stopped) setError(e.message);
      });
    return () => {
      stopped = true;
    };
  }, [round?.id, round?.status, matchesKey, profile]);
  useEffect(() => {
    if (settings) dialog.current?.showModal();
    else dialog.current?.close();
  }, [settings]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        screen === "round" &&
        !settings &&
        !e.repeat &&
        !["INPUT", "SELECT", "TEXTAREA"].includes(
          (e.target as HTMLElement)?.tagName,
        ) &&
        ["ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        e.preventDefault();
        voteRef.current(e.key === "ArrowRight");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [screen, settings]);
  const me = config?.profiles.find((p) => p.id === profile),
    partner = config?.profiles.find((p) => p.id !== profile);
  function choose(id: number) {
    generation.current++;
    setProfile(id);
    localStorage.setItem("dinder-profile", String(id));
    setRound(null);
    setOnline(false);
    setScreen("home");
    setSettings(false);
    setError("");
  }
  async function perform(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    writeVersion.current++;
    setBusy(true);
    setError("");
    try {
      await task();
      setOnline(true);
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status! >= 500 || e instanceof TypeError)
        setOnline(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function act(
    path: string,
    body: unknown = {},
    onResult?: (r: Round) => void,
  ) {
    void perform(async () => {
      const r = await api<Round>(path, profile, body);
      setRound(r);
      onResult?.(r);
    });
  }
  function start(mode: "planner" | "picker") {
    act("/rounds", { mode, source, startDate }, () => setScreen("round"));
  }
  function vote(liked: boolean) {
    if (!online || busy || round?.status !== "swiping" || !round.current)
      return;
    setDrag(0);
    act("/rounds/" + round.id + "/votes", { mealId: round.current.id, liked });
  }
  voteRef.current = vote;
  async function refresh() {
    await perform(async () => {
      const data = await api<State>("/state?fresh=true", profile);
      setConfig(data);
      setRound(data.round);
      setRecipes(data.recipes);
    });
  }
  function review() {
    if (!round) return;
    act(
      "/rounds/" + round.id + "/review",
      round.mode === "planner"
        ? { assignments }
        : {
            sourceEntryId: Number(sourceEntry),
            targetEntryId: targetEntry ? Number(targetEntry) : null,
          },
    );
  }
  const saving = round && ["publishing", "sync_error"].includes(round.status);
  const tonightEntries = choices.filter((e) => e.date === round?.today),
    sourceEntries = choices.filter((e) => e.recipeId === round?.matches[0]?.id);
  const selectedIsTonight =
    choices.find((e) => e.id === Number(sourceEntry))?.date === round?.today;
  return (
    <>
      <header className="header">
        <button
          className="brand"
          onClick={() => setScreen("home")}
          aria-label="Dinder home"
        >
          <Icon name="heart" size={28} />
          dinder<span>.</span>
        </button>
        <div className="header-right">
          <span className="tag">DINNER, TOGETHER</span>
          {me && (
            <button
              className="profile-button"
              onClick={() => {
                setNames(config!.profiles.map((p) => p.name));
                setSettings(true);
              }}
            >
              <span>{me.name.charAt(0)}</span>
              {me.name}
              <small>⌄</small>
            </button>
          )}
        </div>
      </header>
      <main>
        {error && (
          <div role="alert" className="notice error">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        {!config ? (
          <section className="empty">
            <span className="spinner" />
            <h2>Setting the table…</h2>
            <button
              className="button secondary"
              onClick={() => location.reload()}
            >
              Try again
            </button>
          </section>
        ) : ![1, 2].includes(profile) ? (
          <section className="onboard">
            <span className="eyebrow">YOUR TABLE FOR TWO</span>
            <h1>
              Good food.
              <br />
              <em>Better together.</em>
            </h1>
            <p>First things first. Who’s hungry?</p>
            <div className="profile-options">
              {config.profiles.map((p, i) => (
                <button key={p.id} onClick={() => choose(p.id)}>
                  <span className={"avatar avatar-" + i}>
                    {i === 0 ? "☀" : "☾"}
                  </span>
                  <strong>{p.name}</strong>
                  <span>
                    That’s me <Icon name="arrow" size={16} />
                  </span>
                </button>
              ))}
            </div>
            <p className="muted small">Two profiles. One happy dinner.</p>
          </section>
        ) : (
          <>
            <div className="source-bar">
              <span>
                <i className={"status-dot " + (online ? "" : "offline")} />
                {online
                  ? `${recipes.length} live recipes from Mealie`
                  : "Connecting to Mealie…"}
              </span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <Icon name="refresh" size={14} />
                Refresh
              </button>
            </div>
            {screen === "home" ? (
              <>
                <section className="intro">
                  <div>
                    <span className="eyebrow">YOUR TABLE FOR TWO</span>
                    <h1>
                      Hey, {me?.name}
                      <span className="coral">.</span>
                    </h1>
                    <p>A little less deciding. A little more dinner.</p>
                  </div>
                  <div className="couple">
                    <span>{me?.name.charAt(0)}</span>
                    <span>{partner?.name.charAt(0)}</span>
                  </div>
                </section>
                {active(round) && (
                  <section className="resume">
                    <div>
                      <strong>
                        {round!.mode === "planner"
                          ? "Your week is in the making."
                          : "Tonight’s dinner is in the running."}
                      </strong>
                      <p>Pick up where you and {partner?.name} left off.</p>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => setScreen("round")}
                    >
                      Join{" "}
                      {round!.mode === "planner"
                        ? "Meal Planner"
                        : "Meal Picker"}
                      <Icon name="arrow" size={17} />
                    </button>
                  </section>
                )}
                <div className="mode-grid">
                  <section className="mode-card planner-card">
                    <span className="eyebrow">
                      <Icon name="calendar" size={17} /> MEAL PLANNER
                    </span>
                    <h2>
                      Seven nights.
                      <br />
                      <em>Something for both of you.</em>
                    </h2>
                    <p>
                      Swipe together, agree on the menu, and send your week
                      straight to Mealie.
                    </p>
                    <label className="date-label">
                      Week starting
                      <input
                        type="date"
                        aria-label="Week starting"
                        min={config.today}
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </label>
                    <button
                      className="button cream"
                      disabled={busy || !online || active(round)}
                      onClick={() => start("planner")}
                    >
                      Plan our week
                      <Icon name="arrow" size={19} />
                    </button>
                    <span className="mode-note">
                      Seven shared yeses. Review before replacing dinners.
                    </span>
                    <span className="mode-art" aria-hidden="true">
                      🗓️
                    </span>
                  </section>
                  <section className="mode-card picker-card">
                    <span className="eyebrow">
                      <Icon name="heart" size={17} /> MEAL PICKER
                    </span>
                    <h2>
                      Two appetites.
                      <br />
                      <em>One happy dinner.</em>
                    </h2>
                    <p>
                      Find the meal you both fancy tonight, from your recipes or
                      the week ahead.
                    </p>
                    <fieldset className="pool-choice">
                      <legend>Choose tonight’s pool</legend>
                      <label className={source === "recipes" ? "selected" : ""}>
                        <input
                          type="radio"
                          name="pool"
                          value="recipes"
                          checked={source === "recipes"}
                          onChange={() => setSource("recipes")}
                        />
                        <span>
                          <strong>All recipes</strong>
                          <small>Your live Mealie collection</small>
                        </span>
                      </label>
                      <label
                        className={source === "mealplan" ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="pool"
                          value="mealplan"
                          checked={source === "mealplan"}
                          onChange={() => setSource("mealplan")}
                        />
                        <span>
                          <strong>The meal plan</strong>
                          <small>Dinners in the upcoming seven days</small>
                        </span>
                      </label>
                    </fieldset>
                    <button
                      className="button primary"
                      disabled={busy || !online || active(round)}
                      onClick={() => start("picker")}
                    >
                      Pick tonight’s dinner
                      <Icon name="arrow" size={19} />
                    </button>
                    <span className="mode-note">
                      The first shared yes wins.
                    </span>
                  </section>
                </div>
                <section className="collection">
                  <div className="section-head">
                    <div>
                      <span className="eyebrow">FROM YOUR MEALIE KITCHEN</span>
                      <h2>
                        What’s on the menu<span className="coral">.</span>
                      </h2>
                    </div>
                    <a
                      className="text-button"
                      href={config.mealieUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Mealie
                      <Icon name="link" size={15} />
                    </a>
                  </div>
                  <input
                    className="search"
                    aria-label="Search recipes"
                    placeholder="Find a favourite…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="recipe-grid">
                    {recipes
                      .filter((m) =>
                        (m.name + " " + m.notes)
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .slice(0, 12)
                      .map((m) => (
                        <a
                          className="recipe-tile"
                          key={m.id}
                          href={m.recipe}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Photo meal={m} />
                          <div>
                            <h3>{m.name}</h3>
                            <p>{m.notes || "A contender for tonight."}</p>
                            <span>View recipe ↗</span>
                          </div>
                        </a>
                      ))}
                  </div>
                  {!recipes.length && (
                    <div className="empty">
                      <h3>Your next favourite starts in Mealie.</h3>
                      <p>
                        Add recipes there and they’ll appear here automatically.
                      </p>
                    </div>
                  )}
                  <p className="muted small">
                    Add and edit recipes in Mealie. Dinder always uses your live
                    collection.
                  </p>
                </section>
              </>
            ) : (
              <section className="round-page">
                <div className="round-nav">
                  <button
                    className="text-button"
                    onClick={() => setScreen("home")}
                  >
                    ← Back to your table
                  </button>
                  {active(round) && !saving && (
                    <button
                      className="text-button cancel"
                      onClick={() => setConfirmCancel(!confirmCancel)}
                    >
                      Cancel round
                    </button>
                  )}
                </div>
                {confirmCancel && (
                  <div className="notice">
                    <span>
                      Discard this round? Nothing will be changed in Mealie.
                    </span>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (round)
                          act("/rounds/" + round.id + "/cancel", {}, () => {
                            setConfirmCancel(false);
                            setScreen("home");
                          });
                      }}
                    >
                      Discard round
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirmCancel(false)}
                    >
                      Keep it
                    </button>
                  </div>
                )}
                {!online && (
                  <div className="notice connection-warning" role="status">
                    Reconnecting to Mealie. Your votes are saved; swiping and
                    saving will resume when it’s back.
                  </div>
                )}
                {!round ? (
                  <div className="empty">
                    <h2>Your table is waiting.</h2>
                    <button
                      className="button primary"
                      onClick={() => setScreen("home")}
                    >
                      Choose a mode
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="round-heading">
                      <span className="eyebrow">
                        {round.mode === "planner"
                          ? "MEAL PLANNER · " + dayLabel(round.startDate)
                          : "MEAL PICKER · TONIGHT"}
                      </span>
                      <h1>
                        {round.mode === "planner" ? (
                          <>
                            A week you <em>both love.</em>
                          </>
                        ) : (
                          <>
                            Follow your <em>cravings.</em>
                          </>
                        )}
                      </h1>
                      <p>
                        {round.mode === "planner"
                          ? "Every shared yes joins the week. Review your nights before sending them to Mealie."
                          : round.source === "mealplan"
                            ? "Choose from the plan. Your winner can swap into tonight."
                            : "Choose from every recipe. The first shared yes wins."}
                      </p>
                    </div>
                    {round.mode === "planner" && (
                      <div
                        className="plan-progress"
                        aria-label={`${round.matches.length} of 7 dinners agreed`}
                      >
                        {Array.from({ length: 7 }, (_, i) => (
                          <span
                            key={i}
                            className={round.matches[i] ? "filled" : ""}
                          >
                            {round.matches[i] ? (
                              <Icon name="check" size={16} />
                            ) : (
                              i + 1
                            )}
                          </span>
                        ))}
                        <small>{round.matches.length} of 7 agreed</small>
                      </div>
                    )}
                    {round.status === "swiping" && round.current ? (
                      <>
                        <div className="swipe-deck">
                          <article
                            className="swipe-card"
                            onDragStart={(e) => e.preventDefault()}
                            style={{
                              transform: `translateX(${drag}px) rotate(${drag / 24}deg)`,
                            }}
                            onPointerDown={(e) => {
                              if (
                                (e.target as HTMLElement).closest("a,button") ||
                                busy ||
                                !online
                              )
                                return;
                              pointer.current = { x: e.clientX, y: e.clientY };
                              e.currentTarget.setPointerCapture(e.pointerId);
                            }}
                            onPointerMove={(e) => {
                              if (pointer.current) {
                                const dx = e.clientX - pointer.current.x,
                                  dy = e.clientY - pointer.current.y;
                                if (Math.abs(dx) > Math.abs(dy)) setDrag(dx);
                              }
                            }}
                            onPointerUp={() => {
                              if (pointer.current && Math.abs(drag) > 85)
                                vote(drag > 0);
                              pointer.current = null;
                              setDrag(0);
                            }}
                            onPointerCancel={() => {
                              pointer.current = null;
                              setDrag(0);
                            }}
                          >
                            <Photo meal={round.current} />
                            {Math.abs(drag) > 35 && (
                              <span
                                className={
                                  "swipe-stamp " + (drag > 0 ? "yes" : "no")
                                }
                              >
                                {drag > 0 ? "YES PLEASE" : "NOT TONIGHT"}
                              </span>
                            )}
                            <div className="swipe-copy">
                              <span className="eyebrow">
                                {round.current.planned?.length
                                  ? "ON THE PLAN · " +
                                    round.current.planned
                                      .map((e) => dayLabel(e.date))
                                      .join(", ")
                                  : "ON THE MENU"}
                              </span>
                              <h2>{round.current.name}</h2>
                              <p>
                                {round.current.notes ||
                                  "Could this be the one for you both?"}
                              </p>
                              <a
                                href={round.current.recipe}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <Icon name="link" size={15} />
                                Take a peek at the recipe
                              </a>
                            </div>
                          </article>
                        </div>
                        <div className="swipe-controls">
                          <div>
                            <button
                              className="reject"
                              aria-label="Not tonight — swipe left"
                              disabled={busy || !online}
                              onClick={() => vote(false)}
                            >
                              <Icon name="close" size={30} />
                            </button>
                            <span>Not tonight</span>
                          </div>
                          <small>go with your gut</small>
                          <div>
                            <button
                              className="accept"
                              aria-label="Yes please — swipe right"
                              disabled={busy || !online}
                              onClick={() => vote(true)}
                            >
                              <Icon name="heart" size={28} />
                            </button>
                            <span>Yes please!</span>
                          </div>
                        </div>
                      </>
                    ) : round.status === "swiping" ? (
                      <div className="empty waiting">
                        <span className="large-heart">♡</span>
                        <h2>Your cravings are in.</h2>
                        <p>Waiting for {partner?.name} to finish swiping.</p>
                      </div>
                    ) : null}
                    {round.status === "swiping" && (
                      <div className="partner-status">
                        <i className="status-dot" />
                        {partner?.name} has swiped{" "}
                        {round.progress.find((p) => p.id !== profile)?.count ||
                          0}{" "}
                        of {round.total} recipes.
                      </div>
                    )}
                    {["review", "exhausted"].includes(round.status) && (
                      <div className="review-panel">
                        <span className="eyebrow">
                          {round.mode === "planner"
                            ? "YOUR SHARED YESES"
                            : "TWO YESES. ONE DINNER."}
                        </span>
                        <h2>
                          {round.mode === "planner"
                            ? round.matches.length === 7
                              ? "Your week is ready to review."
                              : `${round.matches.length} dinners you both fancy.`
                            : round.matches.length
                              ? "It’s a match!"
                              : "Different cravings tonight?"}
                        </h2>
                        {!round.matches.length ? (
                          <p>
                            No shared yeses this time. Try the recipes again or
                            start a new round with a different pool.
                          </p>
                        ) : round.mode === "planner" ? (
                          <>
                            <p>
                              Assign each meal to a night. Only dinners on these
                              dates will be replaced; other dates and meal types
                              stay as they are.
                            </p>
                            <div className="assignment-list">
                              {round.matches.map((m) => (
                                <label key={m.id}>
                                  <span>{m.name}</span>
                                  <select
                                    aria-label={"Night for " + m.name}
                                    value={
                                      assignments.find(
                                        (a) => a.recipeId === m.id,
                                      )?.date || ""
                                    }
                                    disabled={busy}
                                    onChange={(e) => {
                                      const date = e.target.value;
                                      setAssignments((a) => {
                                        const previous = a.find(
                                          (v) => v.recipeId === m.id,
                                        )?.date;
                                        return a.map((v) =>
                                          v.recipeId === m.id
                                            ? { ...v, date }
                                            : v.date === date
                                              ? { ...v, date: previous || "" }
                                              : v,
                                        );
                                      });
                                    }}
                                  >
                                    {round.dates.map((d) => (
                                      <option key={d} value={d}>
                                        {dayLabel(d)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ))}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="winner">
                              <Photo meal={round.matches[0]} />
                              <h3>{round.matches[0].name}</h3>
                              <a
                                href={round.matches[0].recipe}
                                target="_blank"
                                rel="noreferrer"
                              >
                                View recipe ↗
                              </a>
                            </div>
                            {round.source === "mealplan" && (
                              <label className="field">
                                Which planned dinner?
                                <select
                                  aria-label="Planned dinner to move"
                                  value={sourceEntry}
                                  onChange={(e) =>
                                    setSourceEntry(e.target.value)
                                  }
                                >
                                  <option value="">
                                    Choose a planned date
                                  </option>
                                  {sourceEntries.map((e) => (
                                    <option key={e.id} value={e.id}>
                                      {dayLabel(e.date)} · {e.title}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            {tonightEntries.length > 0 &&
                              !selectedIsTonight && (
                                <label className="field">
                                  Tonight’s dinner to{" "}
                                  {round.source === "mealplan"
                                    ? "swap"
                                    : "replace"}
                                  <select
                                    aria-label="Tonight’s dinner"
                                    value={targetEntry}
                                    onChange={(e) =>
                                      setTargetEntry(e.target.value)
                                    }
                                  >
                                    <option value="">
                                      Choose tonight’s dinner
                                    </option>
                                    {tonightEntries.map((e) => (
                                      <option key={e.id} value={e.id}>
                                        {e.title}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                          </>
                        )}
                        {round.matches.length > 0 && (
                          <button
                            className="button primary"
                            disabled={busy || !online}
                            onClick={review}
                          >
                            Review{" "}
                            {round.mode === "planner"
                              ? "Mealie changes"
                              : "tonight’s change"}
                            <Icon name="arrow" size={18} />
                          </button>
                        )}
                        {round.review &&
                          (round.mode === "planner"
                            ? JSON.stringify(round.review.assignments) ===
                              JSON.stringify(assignments)
                            : (round.source !== "mealplan" ||
                                round.review.sourceEntryId ===
                                  Number(sourceEntry)) &&
                              round.review.targetEntryId ===
                                (targetEntry ? Number(targetEntry) : null)) && (
                            <div className="confirmation">
                              <strong>Here’s what will change in Mealie</strong>
                              <ul>
                                {round.review.summary.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                              <button
                                className="button green"
                                disabled={busy || !online}
                                onClick={() =>
                                  act("/rounds/" + round.id + "/publish", {
                                    token: round.review!.token,
                                  })
                                }
                              >
                                {busy
                                  ? "Saving…"
                                  : round.mode === "planner"
                                    ? "Confirm & publish plan"
                                    : "Confirm tonight’s dinner"}
                                <Icon name="check" size={18} />
                              </button>
                            </div>
                          )}
                        {round.status === "exhausted" && (
                          <button
                            className="text-button retry"
                            disabled={busy || !online}
                            onClick={() =>
                              act("/rounds/" + round.id + "/retry")
                            }
                          >
                            Try unmatched recipes again
                            <Icon name="refresh" size={15} />
                          </button>
                        )}
                      </div>
                    )}
                    {saving && (
                      <div className="review-panel">
                        <h2>
                          {round.status === "sync_error"
                            ? "Your save needs another moment."
                            : "Sending your choices to Mealie…"}
                        </h2>
                        <p>
                          {round.syncError ||
                            "If saving was interrupted, retry to check what has already been saved and finish the remaining changes."}
                        </p>
                        <a
                          href={config.mealieUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Inspect the plan in Mealie ↗
                        </a>
                        <button
                          className="button primary"
                          disabled={busy || !online}
                          onClick={() =>
                            act("/rounds/" + round.id + "/publish", {
                              token: round.review?.token,
                            })
                          }
                        >
                          {busy ? "Saving…" : "Retry save"}
                        </button>
                      </div>
                    )}
                    {round.status === "complete" && (
                      <div className="review-panel complete">
                        <span className="success-icon">
                          <Icon name="check" size={32} />
                        </span>
                        <h2>
                          {round.mode === "planner"
                            ? "Your plan is in Mealie."
                            : "Tonight’s dinner, sorted."}
                        </h2>
                        <p>Less deciding. More enjoying it together.</p>
                        <ul>
                          {round.result?.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                        <a
                          className="button green"
                          href={config.mealieUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Mealie
                          <Icon name="link" size={17} />
                        </a>
                        <button
                          className="text-button"
                          onClick={() => setScreen("home")}
                        >
                          Back to your table
                          <Icon name="arrow" size={16} />
                        </button>
                      </div>
                    )}
                    {["cancelled", "expired"].includes(round.status) && (
                      <div className="empty">
                        <h2>
                          {round.status === "expired"
                            ? "A new day. A new dinner."
                            : "Back to a fresh menu."}
                        </h2>
                        <p>
                          {round.status === "expired"
                            ? "Tonight’s round expired at midnight. Start a new one for today."
                            : "This round was cancelled."}
                        </p>
                        <button
                          className="button primary"
                          onClick={() => setScreen("home")}
                        >
                          Choose a mode
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
      <footer>
        <span className="footer-brand">dinder.</span>
        <span>
          <Icon name="heart" size={14} /> Made for your table for two.
        </span>
        <a
          href={config?.mealieUrl || "https://recipes.muthur.network"}
          target="_blank"
          rel="noreferrer"
        >
          Recipes by Mealie ↗
        </a>
      </footer>
      <dialog
        ref={dialog}
        onCancel={() => setSettings(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSettings(false);
        }}
      >
        <div className="settings">
          <button
            className="icon-button modal-close"
            aria-label="Close profile settings"
            onClick={() => setSettings(false)}
          >
            <Icon name="close" />
          </button>
          <span className="eyebrow">YOUR TABLE FOR TWO</span>
          <h2>Who’s hungry?</h2>
          <p>Make these names your own, or switch profile.</p>
          {config?.profiles.map((p, i) => (
            <div className="settings-person" key={p.id}>
              <label>
                Person {p.id}
                <input
                  maxLength={40}
                  value={names[i] || ""}
                  onChange={(e) =>
                    setNames((n) =>
                      n.map((v, j) => (i === j ? e.target.value : v)),
                    )
                  }
                />
              </label>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => choose(p.id)}
              >
                {profile === p.id ? "That’s me" : "Switch"}
              </button>
            </div>
          ))}
          <button
            className="button primary"
            disabled={busy || !names.every((n) => n.trim())}
            onClick={() =>
              void perform(async () => {
                for (let i = 0; i < config!.profiles.length; i++)
                  await api(
                    "/profiles/" + config!.profiles[i].id,
                    profile,
                    { name: names[i] },
                    "PATCH",
                  );
                setConfig((c) =>
                  c
                    ? {
                        ...c,
                        profiles: c.profiles.map((p, i) => ({
                          ...p,
                          name: names[i],
                        })),
                      }
                    : c,
                );
                setSettings(false);
              })
            }
          >
            Save names
          </button>
        </div>
      </dialog>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
