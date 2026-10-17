import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Profile = { id: number; name: string };
type Meal = {
  id: number;
  name: string;
  photo: string;
  recipe: string;
  notes: string;
  emoji: string;
};
type Round = {
  id: number;
  status: "active" | "matched" | "exhausted";
  meals: Meal[];
  winner: Meal | null;
  votes: { meal_id: number; liked: number }[];
  progress: { id: number; count: number }[];
};
type MatchHistory = {
  id: number;
  startedAt: string;
  matchedAt: string | null;
  meal: Meal;
};
type Draft = Omit<Meal, "id"> & { id?: number };
const empty: Draft = {
  name: "",
  photo: "",
  recipe: "",
  notes: "",
  emoji: "🍽️",
};
const emojis = [
  "🍽️",
  "🍝",
  "🌮",
  "🍕",
  "🍛",
  "🍜",
  "🥗",
  "🍔",
  "🐟",
  "🍳",
  "🥔",
  "🍄",
  "🥘",
  "🍗",
  "🥙",
  "🍲",
];
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch("/api" + url, {
    ...options,
    headers:
      options?.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || "Something went wrong.");
  return body;
}
function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
        <path d="M9 21v-8h6v8" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2.8 7M3 4v7h7" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    heart: (
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    edit: (
      <>
        <path d="m15 5 4 4M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="7" r="4" />
        <path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    shuffle: (
      <>
        <path d="M3 5h3l12 14h3m-4-4 4 4-4 3M3 19h3l4-5m3-5 5-4h3m-4-3 4 3-4 4" />
      </>
    ),
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
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
function Food({
  meal,
  className = "",
}: {
  meal: Pick<Meal, "name" | "emoji" | "photo">;
  className?: string;
}) {
  return (
    <div className={"food " + className} data-emoji={meal.emoji}>
      {meal.photo ? (
        <img src={meal.photo} alt={meal.name} />
      ) : (
        <>
          <span className="food-ring" />
          <span className="food-emoji" aria-hidden="true">
            {meal.emoji}
          </span>
          <span className="food-spark one">✦</span>
          <span className="food-spark two">✧</span>
        </>
      )}
    </div>
  );
}
function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [meals, setMeals] = useState<Meal[]>([]),
    [profile, setProfile] = useState<number>(() =>
      [1, 2].includes(Number(localStorage.getItem("dinder-profile")))
        ? Number(localStorage.getItem("dinder-profile"))
        : 0,
    );
  const [tab, setTab] = useState<"home" | "meals" | "match" | "history">(
      sessionStorage.getItem("dinder-tab") === "history"
        ? "history"
        : sessionStorage.getItem("dinder-tab") === "match"
          ? "match"
          : sessionStorage.getItem("dinder-tab") === "meals"
            ? "meals"
            : "home",
    ),
    [round, setRound] = useState<Round | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true);
  const [history, setHistory] = useState<MatchHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  useEffect(() => {
    if (tab !== "history" && tab !== "home") return;
    let stopped = false;
    setHistoryLoading(true);
    const refresh = async () => {
      try {
        const matches = await api<MatchHistory[]>("/history");
        if (!stopped) setHistory(matches);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setHistoryLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [tab]);
  const [draft, setDraft] = useState<Draft | null>(null),
    [settings, setSettings] = useState(false),
    [names, setNames] = useState<string[]>([]),
    [selection, setSelection] = useState<number[] | null>(null),
    [search, setSearch] = useState(""),
    [confirmDelete, setConfirmDelete] = useState<Meal | null>(null);
  const [drag, setDrag] = useState(0),
    [exit, setExit] = useState(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // Read by the modal's key handler so busy changes don't re-run its focus setup.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const voteLock = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const writeVersion = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const [p, m] = await Promise.all([
          api<Profile[]>("/profiles"),
          api<Meal[]>("/meals"),
        ]);
        if (!stopped) {
          setProfiles(p);
          setMeals(m);
          setLoaded(true);
        }
      } catch {
        /* Round polling reports connectivity during matching. */
      }
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem("dinder-tab", tab);
    window.scrollTo(0, 0);
  }, [tab]);
  const me = profiles.find((p) => p.id === profile),
    partner = profiles.find((p) => p.id !== profile);
  const current = round?.meals.find(
    (m) => !round.votes.some((v) => v.meal_id === m.id),
  );
  const modal = !!draft || settings || selection !== null || !!confirmDelete;
  useEffect(() => {
    Promise.all([api<Profile[]>("/profiles"), api<Meal[]>("/meals")])
      .then(([p, m]) => {
        setProfiles(p);
        setMeals(m);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!profile) return;
    const epoch = ++generation.current;
    let stopped = false;
    let pending = false;
    async function poll() {
      if (pending || inFlight.current) return;
      pending = true;
      const version = writeVersion.current;
      try {
        const r = await api<Round | null>("/rounds/current?profile=" + profile);
        if (
          !stopped &&
          epoch === generation.current &&
          version === writeVersion.current &&
          !inFlight.current
        ) {
          setRound(r);
          setOnline(true);
        }
      } catch {
        if (!stopped) setOnline(false);
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [profile]);
  useEffect(() => {
    if (!modal) return;
    returnFocus.current = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() =>
      modalRef.current
        ?.querySelector<HTMLElement>("input,button,textarea")
        ?.focus(),
    );
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeModal();
      }
      if (e.key === "Tab") {
        const all = modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]",
        );
        if (!all?.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", handler);
      returnFocus.current?.focus();
    };
  }, [modal]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        tab !== "match" ||
        modal ||
        !current ||
        round?.status !== "active" ||
        e.repeat
      )
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        void vote(e.key === "ArrowRight");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  function choose(id: number) {
    setProfile(id);
    localStorage.setItem("dinder-profile", String(id));
    setRound(null);
    setTab("home");
  }
  function closeModal() {
    if (busyRef.current) return;
    setDraft(null);
    setSettings(false);
    setSelection(null);
    setConfirmDelete(null);
  }
  async function perform(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshMeals() {
    setMeals(await api<Meal[]>("/meals"));
  }
  function start(ids?: number[]) {
    if (!profile) return;
    if (inFlight.current) return;
    writeVersion.current++;
    inFlight.current = true;
    void perform(async () => {
      try {
        const r = await api<Round>("/rounds", {
          method: "POST",
          body: JSON.stringify({ profile, ...(ids ? { mealIds: ids } : {}) }),
        });
        setRound(r);
        setTab("match");
        setSelection(null);
      } finally {
        inFlight.current = false;
      }
    });
  }
  async function vote(liked: boolean) {
    if (voteLock.current || !current || round?.status !== "active" || !online)
      return;
    voteLock.current = true;
    writeVersion.current++;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setExit(liked ? 1 : -1);
    try {
      const [r] = await Promise.all([
        api<Round>(`/rounds/${round.id}/votes`, {
          method: "POST",
          body: JSON.stringify({ profile, mealId: current.id, liked }),
        }),
        new Promise((resolve) => setTimeout(resolve, 220)),
      ]);
      setRound(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExit(0);
      setDrag(0);
      setBusy(false);
      voteLock.current = false;
      inFlight.current = false;
    }
  }
  function saveMeal(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    void perform(async () => {
      await api("/meals" + (draft.id ? "/" + draft.id : ""), {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      await refreshMeals();
      setDraft(null);
    });
  }
  function upload(file?: File) {
    if (!file || !draft) return;
    void perform(async () => {
      const form = new FormData();
      form.append("photo", file);
      const result = await api<{ photo: string }>("/uploads", {
        method: "POST",
        body: form,
      });
      setDraft((d) => (d ? { ...d, photo: result.photo } : null));
    });
  }
  return (
    <>
      <header className="header">
        <a
          href="#"
          className="brand"
          aria-label="Dinder home"
          onClick={(e) => {
            e.preventDefault();
            setTab("home");
          }}
        >
          <span className="brand-icon">
            <Icon name="heart" size={24} />
          </span>
          dinder<span className="brand-dot">.</span>
        </a>
        <nav aria-label="Main navigation">
          {(
            [
              { id: "home", label: "Discover", icon: "home" },
              { id: "match", label: "Match", icon: "heart" },
              { id: "meals", label: "Our meals", icon: "grid" },
              { id: "history", label: "History", icon: "history" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <button
          className="profile-button"
          onClick={() => {
            setNames(profiles.map((p) => p.name));
            setSettings(true);
          }}
        >
          <span className="avatar">
            {me?.name.charAt(0) || <Icon name="users" size={16} />}
          </span>
          <span>{me?.name || "Who’s cooking?"}</span>
          <span className="chevron">⌄</span>
        </button>
      </header>
      <main>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <Icon name="close" size={17} />
            </button>
          </div>
        )}
        {!loaded ? (
          <div className="loading">
            <span className="spinner" />
            Setting the table…
          </div>
        ) : !profile ? (
          <section className="onboard">
            <span className="eyebrow">A TABLE FOR TWO</span>
            <h1>
              Good food.
              <br />
              <em>Better together.</em>
            </h1>
            <p>First things first. Who’s hungry?</p>
            <div className="profile-options">
              {profiles.map((p, i) => (
                <button key={p.id} onClick={() => choose(p.id)}>
                  <span className={"profile-circle p" + i}>
                    {i === 0 ? "☀" : "☾"}
                  </span>
                  <strong>{p.name}</strong>
                  <span>
                    That’s me <Icon name="arrow" size={16} />
                  </span>
                </button>
              ))}
            </div>
            <p className="small muted">No passwords. Just the two of you.</p>
          </section>
        ) : tab === "home" ? (
          <>
            <section className="dashboard-intro">
              <div>
                <span className="eyebrow">YOUR TABLE FOR TWO</span>
                <h1>
                  Hey, {me?.name}
                  <span className="coral">.</span>
                </h1>
                <p>Let’s find something you both fancy.</p>
              </div>
              <div className="couple-badge">
                <span className="couple-avatars">
                  {profiles.map((p) => (
                    <span key={p.id}>{p.name.charAt(0)}</span>
                  ))}
                </span>
                <span>{profiles.map((p) => p.name).join(" + ")}</span>
              </div>
            </section>
            <section className="dashboard-grid">
              <div className="dinner-panel">
                <div className="dinner-panel-copy">
                  <span className="eyebrow">
                    <Icon name="heart" size={15} /> MATCH MODE
                  </span>
                  <h2>
                    Two appetites.
                    <br />
                    <em>One happy dinner.</em>
                  </h2>
                  <p>
                    Swipe through tonight’s shortlist.
                    <br />
                    Find the meal you both say yes to.
                  </p>
                  <button
                    className="button primary hero-cta"
                    disabled={
                      busy || (!meals.length && round?.status !== "active")
                    }
                    onClick={() =>
                      round?.status === "active" ? setTab("match") : start()
                    }
                  >
                    {round?.status === "active"
                      ? "Join Match Mode"
                      : "Let’s find dinner"}
                    <Icon name="arrow" size={20} />
                  </button>
                  <div className="hero-footnote">
                    <span className="status-dot" />
                    {round?.status === "active"
                      ? "Your round is ready. Pick up where you left off."
                      : `Up to ${Math.min(meals.length, 10)} meals. Your next shared yes.`}
                  </div>
                </div>
                <div className="dinner-illustration" aria-hidden="true">
                  <span className="plate-orbit" />
                  <div className="dinner-plate">
                    <span>🍝</span>
                  </div>
                  <span className="plate-heart">
                    <Icon name="heart" size={24} />
                  </span>
                  <span className="plate-caption">a good night in</span>
                </div>
              </div>
              <aside className="recent-panel">
                <div className="recent-heading">
                  <span className="eyebrow">YOUR LATEST MATCH</span>
                  <Icon name="history" size={17} />
                </div>
                {!historyLoading && history[0] ? (
                  <>
                    <Food meal={history[0].meal} />
                    <div className="recent-body">
                      <span className="small muted">
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                        }).format(
                          new Date(
                            history[0].matchedAt || history[0].startedAt,
                          ),
                        )}
                      </span>
                      <h3>{history[0].meal.name}</h3>
                      <button
                        className="text-button"
                        onClick={() => setTab("history")}
                      >
                        See your dinner history <Icon name="arrow" size={16} />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="recent-empty">
                    <span>
                      <Icon name="heart" size={29} />
                    </span>
                    <h3>
                      {historyLoading
                        ? "Setting the table…"
                        : "Good dinners to come."}
                    </h3>
                    <p>Your shared favourites will find a home here.</p>
                    <button
                      className="text-button"
                      onClick={() => setTab("history")}
                    >
                      View history <Icon name="arrow" size={16} />
                    </button>
                  </div>
                )}
              </aside>
            </section>
            <section className="collection-preview">
              <div className="section-head">
                <div>
                  <span className="eyebrow">YOUR SHARED COLLECTION</span>
                  <h2>
                    On your menu<span className="coral">.</span>
                  </h2>
                </div>
                <button className="text-button" onClick={() => setTab("meals")}>
                  View all meals <Icon name="arrow" size={18} />
                </button>
              </div>
              {meals.length ? (
                <div className="preview-grid">
                  {meals.slice(0, 4).map((m) => (
                    <button
                      className="preview-meal"
                      key={m.id}
                      onClick={() => {
                        setTab("meals");
                        setDraft(m);
                      }}
                    >
                      <Food meal={m} />
                      <h3>{m.name}</h3>
                      <span>{m.notes || "A contender for tonight."}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-collection">
                  <span className="empty-emoji">🍽️</span>
                  <div>
                    <h3>Your next favourite dinner starts here.</h3>
                    <p>
                      Add your own meals, or get a head start with 12 dinner
                      ideas.
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setMeals(
                          await api<Meal[]>("/seed", { method: "POST" }),
                        );
                      })
                    }
                  >
                    Add starter meals <Icon name="plus" size={17} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setDraft({ ...empty })}
                  >
                    Add my own
                  </button>
                </div>
              )}
            </section>
            <div className="bottom-note">
              <Icon name="heart" size={15} /> Made for your table for two.
            </div>
          </>
        ) : tab === "meals" ? (
          <section className="meals-page">
            <div className="section-head">
              <div>
                <span className="eyebrow">A LITTLE OF WHAT YOU LOVE</span>
                <h1>
                  Our meals<span className="coral">.</span>
                </h1>
                <p className="muted">
                  Keep your favourites close. Add something new when the craving
                  hits.
                </p>
              </div>
              <button
                className="button primary"
                onClick={() => setDraft({ ...empty })}
              >
                <Icon name="plus" size={19} />
                Add a meal
              </button>
            </div>
            <div className="collection-toolbar">
              <span>
                {meals.length} {meals.length === 1 ? "meal" : "meals"} on the
                menu
              </span>
              <input
                aria-label="Search meals"
                placeholder="Find a favourite…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {meals.length ? (
              <div className="meal-grid">
                {meals
                  .filter((m) =>
                    (m.name + " " + m.notes)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((m) => (
                    <article className="meal-tile" key={m.id}>
                      <button
                        className="meal-image-button"
                        aria-label={"Edit " + m.name}
                        onClick={() => setDraft(m)}
                      >
                        <Food meal={m} />
                      </button>
                      <div className="tile-content">
                        <div className="tile-heading">
                          <h3>{m.name}</h3>
                          <button
                            className="icon-button"
                            aria-label={"Edit " + m.name}
                            onClick={() => setDraft(m)}
                          >
                            <Icon name="edit" size={17} />
                          </button>
                        </div>
                        <p>{m.notes || "Ready for a dinner date."}</p>
                        <div className="tile-bottom">
                          {m.recipe ? (
                            <a href={m.recipe} target="_blank" rel="noreferrer">
                              <Icon name="link" size={14} />
                              Recipe
                            </a>
                          ) : (
                            <span>Made with love</span>
                          )}
                          <button
                            className="delete-link"
                            onClick={() => setConfirmDelete(m)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                {!meals.some((m) =>
                  (m.name + " " + m.notes)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                ) && (
                  <div className="search-empty">
                    <Icon name="grid" size={27} />
                    <h3>No meals found.</h3>
                    <p>Try another search, or add a new favourite.</p>
                    <button
                      className="text-button"
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </button>
                  </div>
                )}
                <button
                  className="add-tile"
                  onClick={() => setDraft({ ...empty })}
                >
                  <span>
                    <Icon name="plus" size={28} />
                  </span>
                  <strong>Something else you love?</strong>
                  <span>Add it to the menu</span>
                </button>
              </div>
            ) : (
              <div className="center-empty">
                <span>🍽️</span>
                <h2>A fresh start for your menu.</h2>
                <p>Add a favourite meal or try our starter collection.</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setMeals(await api<Meal[]>("/seed", { method: "POST" })),
                    )
                  }
                >
                  Add 12 starter meals
                </button>
              </div>
            )}
          </section>
        ) : tab === "history" ? (
          <section className="meals-page history-page">
            <div className="section-head">
              <div>
                <span className="eyebrow">TWO YESES, EVERY TIME</span>
                <h1>
                  Our matches<span className="coral">.</span>
                </h1>
                <p className="muted">
                  A little look back at the meals you both said yes to.
                </p>
              </div>
            </div>
            {historyLoading ? (
              <div className="loading">
                <span className="spinner" />
                Looking back…
              </div>
            ) : history.length ? (
              <>
                <div className="collection-toolbar">
                  <span>
                    {history.length}{" "}
                    {history.length === 1 ? "match" : "matches"} made together
                  </span>
                  <span>Newest first</span>
                </div>
                <div className="meal-grid">
                  {history.map((match) => (
                    <article className="meal-tile history-tile" key={match.id}>
                      <Food meal={match.meal} />
                      <div className="tile-content">
                        <div className="history-date">
                          <Icon name="heart" size={13} />
                          <time dateTime={match.matchedAt || match.startedAt}>
                            {!match.matchedAt && "Round started · "}
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(
                              new Date(match.matchedAt || match.startedAt),
                            )}
                          </time>
                        </div>
                        <h3>{match.meal.name}</h3>
                        {match.meal.notes && <p>{match.meal.notes}</p>}
                        {match.meal.recipe && (
                          <div className="tile-bottom">
                            <a
                              href={match.meal.recipe}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Icon name="link" size={14} />
                              View recipe
                            </a>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="center-empty">
                <span>💕</span>
                <h2>Your first match is waiting.</h2>
                <p>
                  Once you both swipe right on a meal, it’ll be saved here for
                  next time.
                </p>
                <button
                  className="button primary"
                  onClick={() => setTab("home")}
                >
                  Find tonight’s dinner <Icon name="arrow" size={18} />
                </button>
              </div>
            )}
          </section>
        ) : (
          <section className="match-page">
            <button className="text-button back" onClick={() => setTab("home")}>
              <Icon name="back" size={17} />
              Back to discover
            </button>
            <div className="match-top">
              <span className="eyebrow">TONIGHT’S MATCH</span>
              <h1>
                Follow your <em>cravings.</em>
              </h1>
              <p>
                {round?.status === "active"
                  ? "Right for “yes please”. Left for “not tonight”."
                  : "Your table for two is waiting."}
              </p>
            </div>
            {!online && (
              <div role="status" className="connection-warning">
                Reconnecting… Your swipes are saved. We’ll pick up where you
                left off.
              </div>
            )}
            {!round ? (
              <div className="center-empty">
                <span>🍴</span>
                <h2>Ready when you are.</h2>
                <p>We’ll pick up to 10 meals from your collection.</p>
                <button
                  className="button primary"
                  disabled={!meals.length || busy}
                  onClick={() => start()}
                >
                  Start a round <Icon name="heart" size={18} />
                </button>
              </div>
            ) : round.status === "matched" && round.winner ? (
              <div className="result">
                <div className="confetti" aria-hidden="true">
                  ✦ <span>♥</span> ✧
                </div>
                <span className="result-pill">TWO HEARTS. ONE CRAVING.</span>
                <h2>It’s a match!</h2>
                <p>Looks like dinner just decided itself.</p>
                <div className="result-meal">
                  <Food meal={round.winner} />
                  <h3>{round.winner.name}</h3>
                  {round.winner.notes && <p>{round.winner.notes}</p>}
                  {round.winner.recipe && (
                    <a
                      className="button primary"
                      href={round.winner.recipe}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Let’s get cooking <Icon name="link" size={18} />
                    </a>
                  )}
                </div>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => start()}
                >
                  Another round? <Icon name="shuffle" size={17} />
                </button>
              </div>
            ) : round.status === "exhausted" ? (
              <div className="center-empty">
                <span>🤔</span>
                <h2>Different cravings tonight?</h2>
                <p>
                  No shared yes this time. A fresh selection might do the trick.
                </p>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => start()}
                >
                  Try a fresh shortlist <Icon name="shuffle" size={18} />
                </button>
                <button
                  className="text-button"
                  onClick={() => setSelection(meals.map((m) => m.id))}
                >
                  Choose meals ourselves
                </button>
              </div>
            ) : current ? (
              <div className="swipe-area">
                <div className="round-meta">
                  <span>TONIGHT’S SHORTLIST</span>
                  <span>
                    {round.votes.length + 1}{" "}
                    <span className="muted">/ {round.meals.length}</span>
                  </span>
                </div>
                <div
                  className="swipe-progress"
                  role="progressbar"
                  aria-label="Your round progress"
                  aria-valuemin={0}
                  aria-valuemax={round.meals.length}
                  aria-valuenow={round.votes.length}
                >
                  <span
                    style={{
                      width: `${(round.votes.length / round.meals.length) * 100}%`,
                    }}
                  />
                </div>
                <div className="swipe-stack">
                  <div className="stack-under" />
                  <article
                    className={"swipe-card " + (exit ? "leaving" : "")}
                    style={{
                      transform: `translateX(${exit ? exit * 460 : drag}px) rotate(${exit ? exit * 24 : drag / 18}deg)`,
                      opacity: exit ? 0 : 1,
                    }}
                    onPointerDown={(e) => {
                      if (busy || e.button !== 0) return;
                      pointer.current = { x: e.clientX, y: e.clientY };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (pointer.current)
                        setDrag(e.clientX - pointer.current.x);
                    }}
                    onPointerUp={(e) => {
                      if (!pointer.current) return;
                      const dx = e.clientX - pointer.current.x,
                        dy = e.clientY - pointer.current.y;
                      pointer.current = null;
                      if (Math.abs(dx) > 85 && Math.abs(dx) > Math.abs(dy))
                        void vote(dx > 0);
                      else setDrag(0);
                    }}
                    onPointerCancel={() => {
                      pointer.current = null;
                      setDrag(0);
                    }}
                  >
                    <Food meal={current} />
                    {Math.abs(drag) > 35 && (
                      <span
                        className={"swipe-stamp " + (drag > 0 ? "yes" : "no")}
                      >
                        {drag > 0 ? "YES PLEASE" : "NOT TONIGHT"}
                      </span>
                    )}
                    <div className="swipe-description">
                      <span className="mini-label">ON THE MENU</span>
                      <h2>{current.name}</h2>
                      <p>
                        {current.notes || "Could this be the one for tonight?"}
                      </p>
                      {current.recipe && (
                        <a
                          onPointerDown={(e) => e.stopPropagation()}
                          href={current.recipe}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Icon name="link" size={14} />
                          Take a peek at the recipe
                        </a>
                      )}
                    </div>
                  </article>
                </div>
                <div className="swipe-controls">
                  <div>
                    <button
                      className="reject"
                      aria-label="Not tonight — swipe left"
                      disabled={busy || !online}
                      onClick={() => void vote(false)}
                    >
                      <Icon name="close" size={31} />
                    </button>
                    <span>Not tonight</span>
                  </div>
                  <span className="swipe-hint">go with your gut</span>
                  <div>
                    <button
                      className="accept"
                      aria-label="Yes please — swipe right"
                      disabled={busy || !online}
                      onClick={() => void vote(true)}
                    >
                      <Icon name="heart" size={29} />
                    </button>
                    <span>Yes please!</span>
                  </div>
                </div>
                <div className="partner-status">
                  <span className="status-dot" />
                  {partner?.name} has swiped on{" "}
                  {round.progress.find((p) => p.id !== profile)?.count || 0} of{" "}
                  {round.meals.length} meals
                </div>
              </div>
            ) : (
              <div className="center-empty">
                <span className="waiting-hearts">
                  ♥ <small>♥</small>
                </span>
                <h2>Your cravings are in.</h2>
                <p>
                  Waiting for {partner?.name} to finish swiping.
                  <br />
                  Keep this open — we’ll show your match here.
                </p>
                <div className="waiting-progress">
                  <span
                    style={{
                      width: `${((round.progress.find((p) => p.id !== profile)?.count || 0) / round.meals.length) * 100}%`,
                    }}
                  />
                </div>
                <span className="small muted">
                  {round.progress.find((p) => p.id !== profile)?.count || 0} of{" "}
                  {round.meals.length} meals swiped
                </span>
              </div>
            )}
          </section>
        )}
      </main>
      <footer>
        <span className="footer-brand">dinder.</span>
        <span>A little less deciding. A little more dinner.</span>
        <span className="local-label">
          <span className="status-dot" />
          At home, together
        </span>
      </footer>
      {modal && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            ref={modalRef}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              disabled={busy}
              onClick={closeModal}
            >
              <Icon name="close" />
            </button>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {draft ? (
              <form onSubmit={saveMeal}>
                <span className="eyebrow">ONE FOR THE COLLECTION</span>
                <h2 id="modal-title">
                  {draft.id ? "A little menu edit." : "What’s cooking?"}
                </h2>
                <p className="muted">Add something you’d love to share.</p>
                <div className="emoji-picker" aria-label="Meal illustration">
                  {emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={"Use " + emoji + " illustration"}
                      aria-pressed={draft.emoji === emoji}
                      className={draft.emoji === emoji ? "selected" : ""}
                      onClick={() => setDraft({ ...draft, emoji })}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <label>
                  Meal name <span>*</span>
                  <input
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="e.g. Friday night tacos"
                  />
                </label>
                <label>
                  A little about it
                  <textarea
                    maxLength={2000}
                    value={draft.notes}
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.target.value })
                    }
                    placeholder="Your favourite toppings, a little reminder…"
                    rows={3}
                  />
                </label>
                <label>
                  Recipe link <span className="muted">(optional)</span>
                  <input
                    type="url"
                    value={draft.recipe}
                    onChange={(e) =>
                      setDraft({ ...draft, recipe: e.target.value })
                    }
                    placeholder="https://…"
                  />
                </label>
                <label className="upload-label">
                  <Icon name="upload" size={20} />
                  {draft.photo ? "Change meal photo" : "Add a meal photo"}
                  <span className="small muted">
                    JPG, PNG, WebP or GIF · up to 8 MB
                  </span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    disabled={busy}
                    onChange={(e) => upload(e.target.files?.[0])}
                  />
                </label>
                {draft.photo && (
                  <div className="upload-preview">
                    <img src={draft.photo} alt="Meal photo preview" />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setDraft({ ...draft, photo: "" })}
                    >
                      Remove photo
                    </button>
                  </div>
                )}
                <button className="button primary full" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : draft.id
                      ? "Save changes"
                      : "Add to our meals"}
                  <Icon name="check" size={18} />
                </button>
              </form>
            ) : settings ? (
              <>
                <span className="eyebrow">YOUR TABLE FOR TWO</span>
                <h2 id="modal-title">Who’s hungry?</h2>
                <p className="muted">
                  Choose your profile or make these names your own.
                </p>
                <div className="settings-profiles">
                  {profiles.map((p, i) => (
                    <div className="settings-person" key={p.id}>
                      <label htmlFor={"name-" + p.id}>
                        Person {i + 1}
                        <input
                          id={"name-" + p.id}
                          maxLength={40}
                          value={names[i] || ""}
                          onChange={(e) =>
                            setNames(
                              names.map((n, j) =>
                                i === j ? e.target.value : n,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        className={
                          "button " +
                          (profile === p.id ? "secondary" : "neutral")
                        }
                        disabled={busy || !names.every((n) => n.trim())}
                        onClick={() =>
                          void perform(async () => {
                            for (const [j, person] of profiles.entries())
                              await api("/profiles/" + person.id, {
                                method: "PATCH",
                                body: JSON.stringify({ name: names[j] }),
                              });
                            setProfiles(await api<Profile[]>("/profiles"));
                            choose(p.id);
                            setSettings(false);
                          })
                        }
                      >
                        {profile === p.id ? "That’s me" : "Switch"}
                        {profile === p.id && <Icon name="check" size={16} />}
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="button primary full"
                  disabled={busy || !names.every((n) => n.trim())}
                  onClick={() =>
                    void perform(async () => {
                      for (const [i, p] of profiles.entries())
                        await api("/profiles/" + p.id, {
                          method: "PATCH",
                          body: JSON.stringify({ name: names[i] }),
                        });
                      setProfiles(await api<Profile[]>("/profiles"));
                      setSettings(false);
                    })
                  }
                >
                  {busy ? "Saving…" : "Save names"}
                </button>
              </>
            ) : selection !== null ? (
              <>
                <span className="eyebrow">SET THE MENU</span>
                <h2 id="modal-title">What’s in the running?</h2>
                <p className="muted">
                  Choose the meals you’d like to swipe on.
                </p>
                <div className="selection-list">
                  {meals.map((m) => (
                    <label key={m.id}>
                      <input
                        type="checkbox"
                        checked={selection.includes(m.id)}
                        onChange={(e) =>
                          setSelection(
                            e.target.checked
                              ? [...selection, m.id]
                              : selection.filter((id) => id !== m.id),
                          )
                        }
                      />
                      <span>{m.emoji}</span>
                      {m.name}
                    </label>
                  ))}
                </div>
                <button
                  className="button primary full"
                  disabled={busy || !selection.length}
                  onClick={() => start(selection)}
                >
                  Start with {selection.length}{" "}
                  {selection.length === 1 ? "meal" : "meals"}{" "}
                  <Icon name="arrow" size={18} />
                </button>
              </>
            ) : confirmDelete ? (
              <>
                <span className="eyebrow">A LITTLE MENU CLEAN-UP</span>
                <h2 id="modal-title">Remove this meal?</h2>
                <p className="muted">
                  {confirmDelete.name} will leave your collection. An ongoing
                  round will keep its copy.
                </p>
                <div className="dialog-actions">
                  <button
                    className="button neutral"
                    disabled={busy}
                    onClick={closeModal}
                  >
                    Keep it
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api("/meals/" + confirmDelete.id, {
                          method: "DELETE",
                        });
                        await refreshMeals();
                        setConfirmDelete(null);
                      })
                    }
                  >
                    {busy ? "Removing…" : "Remove meal"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
