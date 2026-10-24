import { createHash, randomUUID } from "node:crypto";
import { userError } from "./store.js";
import {
  addDays,
  isDate,
  nextMonday,
  today,
  weekDates,
  TIME_ZONE,
} from "./calendar.js";

const closed = (r) => ["complete", "cancelled", "expired"].includes(r.status);
const fingerprint = (e) =>
  JSON.stringify(
    [
      "id",
      "date",
      "entryType",
      "title",
      "text",
      "recipeId",
      "recipeScale",
      "groupId",
      "userId",
      "householdId",
    ].map((k) => e?.[k] ?? null),
  );
const signature = (entries) =>
  createHash("sha256")
    .update(entries.map(fingerprint).sort().join("\n"))
    .digest("hex");
const editable = (e) =>
  Object.fromEntries(
    [
      "date",
      "entryType",
      "title",
      "text",
      "recipeId",
      "recipeScale",
      "groupId",
      "userId",
      "householdId",
    ]
      .filter((k) => e[k] !== undefined)
      .map((k) => [k, e[k]]),
  );
const same = (a, b) => fingerprint(a) === fingerprint(b);
const conflict = () =>
  userError(
    "The Mealie dinners changed since review. Review the latest plan before confirming. If a save is partly complete, inspect Mealie before resolving the conflicting entry.",
    409,
  );

export function createRounds(store, mealie, { day = today } = {}) {
  // Every route which can change round state shares this queue, including live reconciliation.
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const requireRound = (id) => {
    const r = store.get(id);
    if (!r) throw userError("Round not found.", 404);
    return r;
  };
  const dinners = async (dates) =>
    (
      await mealie.entries([...dates].sort()[0], [...dates].sort().at(-1))
    ).filter((e) => e.entryType === "dinner" && dates.includes(e.date));
  async function pool(r, fresh = false) {
    const recipes = await mealie.recipes({ fresh });
    if (r.mode === "planner" || r.source === "recipes") return recipes;
    const entries = (await mealie.entries(r.today, addDays(r.today, 6))).filter(
      (e) => e.entryType === "dinner" && e.recipeId,
    );
    return recipes
      .filter((recipe) => entries.some((e) => e.recipeId === recipe.id))
      .map((recipe) => ({
        ...recipe,
        planned: entries
          .filter((e) => e.recipeId === recipe.id)
          .map((e) => ({ id: e.id, date: e.date }))
          .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id),
      }));
  }
  async function reconcile(r, fresh = false) {
    const operation = store.operation(r.id);
    if (operation?.done && r.status !== "complete") {
      r.status = "complete";
      r.result = operation.summary;
      return store.save(r);
    }
    if (closed(r) || operation) return r;
    if (r.mode === "picker" && r.today !== day()) {
      r.status = "expired";
      r.review = null;
      return store.save(r);
    }
    const meals = await pool(r, fresh),
      ids = meals.map((m) => m.id);
    r.ids = [
      ...r.ids.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !r.ids.includes(id)),
    ];
    for (const p of [1, 2])
      r.votes[p] = Object.fromEntries(
        Object.entries(r.votes[p]).filter(([id]) => ids.includes(id)),
      );
    const previous = [...r.matches];
    r.matches = r.matches.filter((id) => ids.includes(id));
    if (JSON.stringify(previous) !== JSON.stringify(r.matches)) r.review = null;
    const goal = r.mode === "planner" ? 7 : 1;
    const exhausted = r.ids.every((id) =>
      [1, 2].every((p) => id in r.votes[p]),
    );
    r.status =
      r.matches.length >= goal ? "review" : exhausted ? "exhausted" : "swiping";
    store.save(r);
    return r;
  }
  async function view(r, profile, meals) {
    if (!r) return null;
    meals ||= await pool(r);
    const cards = new Map(meals.map((m) => [m.id, m]));
    const order = [...r.ids].sort((a, b) => {
      const rank = (id) =>
        createHash("sha256")
          .update(r.id + ":" + profile + ":" + id)
          .digest("hex");
      return rank(a).localeCompare(rank(b));
    });
    const candidate =
      r.status === "swiping"
        ? order.find((id) => !(id in r.votes[profile]))
        : undefined;
    const operation = store.operation(r.id);
    return {
      id: r.id,
      mode: r.mode,
      source: r.source,
      status: r.status,
      startDate: r.startDate,
      today: r.today,
      dates: r.mode === "planner" ? weekDates(r.startDate) : [r.today],
      total: r.ids.length,
      current: candidate ? cards.get(candidate) || null : null,
      matches: r.matches.map((id) => cards.get(id)).filter(Boolean),
      votes: r.votes[profile],
      progress: [1, 2].map((id) => ({
        id,
        count: Object.keys(r.votes[id]).length,
      })),
      review: r.review
        ? {
            token: r.review.token,
            summary: r.review.summary,
            assignments: r.review.assignments,
            sourceEntryId: r.review.sourceEntryId,
            targetEntryId: r.review.targetEntryId,
          }
        : null,
      syncError: operation?.error || "",
      canRetry: !!operation && !operation.done,
      result: r.result || null,
    };
  }
  async function current(profile, fresh = false) {
    let r = store.current();
    if (r && !closed(r)) r = await reconcile(r, fresh);
    return view(r, profile);
  }
  async function start(input, profile) {
    const previous = store.current();
    if (previous && !closed(previous)) return current(profile);
    if (!["planner", "picker"].includes(input.mode))
      throw userError("Choose Meal Planner or Meal Picker.");
    if (
      input.mode === "picker" &&
      !["recipes", "mealplan"].includes(input.source)
    )
      throw userError("Choose recipes or the meal plan.");
    const startDate = input.startDate || nextMonday(day());
    if (
      input.mode === "planner" &&
      (!isDate(startDate) ||
        startDate < day() ||
        startDate > addDays(day(), 365))
    )
      throw userError("Choose a start date within the next year.");
    const r = {
      id: randomUUID(),
      mode: input.mode,
      source: input.mode === "planner" ? "recipes" : input.source,
      startDate,
      today: day(),
      status: "swiping",
      ids: [],
      votes: { 1: {}, 2: {} },
      matches: [],
      review: null,
    };
    const meals = await pool(r, true);
    if (!meals.length)
      throw userError(
        r.source === "mealplan"
          ? "There are no dinner recipes in the upcoming seven days. Choose the recipe pool or add dinners in Mealie."
          : "Add a recipe in Mealie before starting.",
      );
    r.ids = meals.map((m) => m.id);
    store.save(r);
    return view(r, profile, meals);
  }
  async function vote(id, profile, mealId, liked) {
    let r = requireRound(id);
    if (typeof liked !== "boolean") throw userError("Choose yes or no.");
    r = await reconcile(r);
    if (r.status !== "swiping") return view(r, profile);
    if (!r.ids.includes(mealId))
      throw userError("That recipe is no longer in this round.", 409);
    if (!(mealId in r.votes[profile])) {
      r.votes[profile][mealId] = liked;
      if (
        liked &&
        r.votes[profile === 1 ? 2 : 1][mealId] === true &&
        !r.matches.includes(mealId)
      )
        r.matches.push(mealId);
      r.review = null;
      store.save(r);
    }
    return view(await reconcile(r), profile);
  }
  async function retry(id, profile) {
    const r = requireRound(id);
    if (closed(r) || store.operation(id))
      throw userError("This round cannot be retried.", 409);
    for (const p of [1, 2])
      r.votes[p] = Object.fromEntries(
        Object.entries(r.votes[p]).filter(([mealId]) =>
          r.matches.includes(mealId),
        ),
      );
    r.review = null;
    store.save(r);
    return view(await reconcile(r, true), profile);
  }
  async function cancel(id, profile) {
    const r = requireRound(id);
    if (store.operation(id) && !closed(r))
      throw userError(
        "A save has started. Retry the save to reconcile it before starting another round.",
        409,
      );
    if (!closed(r)) {
      r.status = "cancelled";
      r.review = null;
      store.save(r);
    }
    return view(r, profile);
  }
  async function choices(id) {
    const r = requireRound(id);
    if (r.mode !== "picker") return { entries: [] };
    if (r.today !== day())
      throw userError("It is a new day. Start a new picker round.", 409);
    const entries = await dinners(weekDates(r.today));
    return {
      entries: entries.map((e) => ({
        id: e.id,
        date: e.date,
        recipeId: e.recipeId,
        title: e.recipe?.name || e.title || e.text || "Dinner",
      })),
    };
  }
  async function review(id, input, profile) {
    let r = requireRound(id);
    if (closed(r) || store.operation(id))
      throw userError("This round cannot be reviewed.", 409);
    r = await reconcile(r, true);
    if (!r.matches.length) throw userError("Agree on a meal before reviewing.");
    const recipes = await mealie.recipes();
    const name = (id) => recipes.find((m) => m.id === id)?.name || "Recipe";
    let dates,
      assignments = [],
      sourceEntryId = null,
      targetEntryId = null,
      summary = [],
      steps = [];
    const opId = randomUUID();
    if (r.mode === "planner") {
      assignments = input.assignments;
      if (
        !Array.isArray(assignments) ||
        assignments.some((a) => !a || typeof a !== "object") ||
        assignments.length !== r.matches.length ||
        new Set(assignments.map((a) => a.recipeId)).size !== r.matches.length ||
        new Set(assignments.map((a) => a.date)).size !== assignments.length ||
        assignments.some(
          (a) =>
            !r.matches.includes(a.recipeId) ||
            !weekDates(r.startDate).includes(a.date),
        )
      )
        throw userError(
          "Assign every agreed meal to a different night in this week.",
        );
      dates = assignments.map((a) => a.date);
      const entries = await dinners(dates);
      for (const a of assignments) {
        const marker = `Planned together in Dinder [${opId}:${a.date}]`;
        steps.push({
          type: "create",
          body: {
            date: a.date,
            entryType: "dinner",
            recipeId: a.recipeId,
            recipeScale: 1,
            title: "",
            text: marker,
          },
          marker,
        });
        summary.push(
          `${a.date}: ${name(a.recipeId)} — replaces ${entries.filter((e) => e.date === a.date).length} existing dinner(s)`,
        );
      }
      steps.push(
        ...entries.map((before) => ({ type: "delete", id: before.id, before })),
      );
      r.review = {
        token: opId,
        dates,
        assignments,
        summary,
        before: entries,
        steps,
      };
    } else {
      if (r.today !== day())
        throw userError("It is a new day. Start a new picker round.", 409);
      const winner = r.matches[0];
      const entries = await dinners(weekDates(r.today));
      const tonight = entries.filter((e) => e.date === r.today);
      let source;
      if (r.source === "mealplan") {
        const sources = entries.filter((e) => e.recipeId === winner);
        source = sources.find((e) => e.id === Number(input.sourceEntryId));
        if (!source)
          throw userError("Choose the planned dinner to move to tonight.");
        sourceEntryId = source.id;
      }
      const target = tonight.find((e) => e.id === Number(input.targetEntryId));
      if (tonight.length && !target && source?.date !== r.today)
        throw userError(
          "Choose which of tonight’s dinners to replace or swap.",
        );
      targetEntryId = target?.id || null;
      dates = [...new Set([r.today, ...(source ? [source.date] : [])])];
      const before = entries.filter((e) => dates.includes(e.date));
      if (source) {
        if (source.date === r.today)
          summary.push(
            `${name(winner)} is already planned for tonight. No changes needed.`,
          );
        else {
          steps.push({
            type: "update",
            id: source.id,
            before: source,
            after: { ...source, date: r.today },
          });
          if (target)
            steps.push({
              type: "update",
              id: target.id,
              before: target,
              after: { ...target, date: source.date },
            });
          summary.push(`Move ${name(winner)} from ${source.date} to tonight.`);
          summary.push(
            target
              ? `Move tonight’s ${target.recipe?.name || target.title || "dinner"} to ${source.date}.`
              : `Leave ${source.date} unplanned.`,
          );
        }
      } else {
        const marker = `Picked together in Dinder [${opId}:${r.today}]`;
        steps.push({
          type: "create",
          body: {
            date: r.today,
            entryType: "dinner",
            recipeId: winner,
            recipeScale: 1,
            title: "",
            text: marker,
          },
          marker,
        });
        if (target)
          steps.push({ type: "delete", id: target.id, before: target });
        summary.push(
          `Set ${name(winner)} as tonight’s dinner${target ? " in place of the selected dinner" : ""}.`,
        );
      }
      r.review = {
        token: opId,
        dates,
        summary,
        sourceEntryId,
        targetEntryId,
        before,
        steps,
      };
    }
    store.save(r);
    return view(r, profile, recipes);
  }
  function assertWorld(op, entries) {
    const known = new Set(op.before.map((e) => e.id));
    const created = op.steps.filter((s) => s.type === "create");
    for (const e of entries) {
      if (known.has(e.id)) continue;
      const step = created.find((s) => s.marker === e.text && s.started);
      if (
        !step ||
        e.date !== step.body.date ||
        e.recipeId !== step.body.recipeId ||
        e.recipeScale !== 1 ||
        e.title !== "" ||
        e.entryType !== "dinner"
      )
        throw conflict();
    }
    for (const step of created) {
      const count = entries.filter((e) => e.text === step.marker).length;
      if (count > 1 || (step.done && count !== 1)) throw conflict();
    }
    for (const before of op.before) {
      const current = entries.find((e) => e.id === before.id);
      const step = op.steps.find((s) => s.id === before.id);
      if (!current) {
        if (step?.type === "delete" && step.started) continue;
        throw conflict();
      }
      if (same(current, before)) {
        if (step?.done) throw conflict();
        continue;
      }
      if (step?.type === "update" && step.started && same(current, step.after))
        continue;
      throw conflict();
    }
  }
  async function publish(id, token, profile) {
    const r = requireRound(id);
    let op = store.operation(id);
    if (op?.done) {
      r.status = "complete";
      r.result = op.summary;
      store.save(r);
      return view(r, profile);
    }
    if (!op) {
      await reconcile(r, true);
      if (closed(r) || !r.review || r.review.token !== token)
        throw userError("Review the changes before confirming.", 409);
      if (r.mode === "picker" && r.today !== day())
        throw userError("It is a new day. Start a new picker round.", 409);
      // Detect conflicts before journaling; an unstarted conflict can be reviewed afresh.
      const entries = await dinners(r.review.dates);
      if (signature(entries) !== signature(r.review.before)) {
        r.review = null;
        store.save(r);
        throw conflict();
      }
      op = { ...r.review, error: "", done: false };
      store.saveOperation(id, op);
    }
    if (token !== op.token)
      throw userError("Use the current save operation.", 409);
    try {
      r.status = "publishing";
      store.save(r);
      const recipes = await mealie.recipes({ fresh: true });
      if (r.matches.some((id) => !recipes.some((m) => m.id === id)))
        throw userError(
          "An agreed recipe was removed from Mealie. Restore it before retrying this save.",
          409,
        );
      for (const step of op.steps) {
        const entries = await dinners(op.dates);
        assertWorld(op, entries);
        if (step.done) continue;
        step.started = true;
        store.saveOperation(id, op);
        if (step.type === "create") {
          if (!entries.some((e) => e.text === step.marker))
            await mealie.create(step.body);
        } else if (step.type === "update") {
          const current = entries.find((e) => e.id === step.id);
          if (!same(current, step.after))
            await mealie.update(step.id, editable(step.after));
        } else if (entries.some((e) => e.id === step.id))
          await mealie.remove(step.id);
        // Verify the remote result before advancing the durable journal.
        const after = await dinners(op.dates);
        assertWorld(op, after);
        if (
          step.type === "create" &&
          !after.some((e) => e.text === step.marker)
        )
          throw userError(
            "Mealie has not confirmed the new dinner. Retry the save.",
            502,
          );
        if (
          step.type === "update" &&
          !same(
            after.find((e) => e.id === step.id),
            step.after,
          )
        )
          throw userError(
            "Mealie has not confirmed the moved dinner. Retry the save.",
            502,
          );
        if (step.type === "delete" && after.some((e) => e.id === step.id))
          throw userError(
            "Mealie has not confirmed the removed dinner. Retry the save.",
            502,
          );
        step.done = true;
        store.saveOperation(id, op);
      }
      assertWorld(op, await dinners(op.dates));
      op.done = true;
      op.error = "";
      store.saveOperation(id, op);
      r.status = "complete";
      r.result = op.summary;
      store.save(r);
      return view(r, profile, recipes);
    } catch (e) {
      op.error = e.expose
        ? e.message
        : "The save was interrupted. Retry to reconcile progress.";
      store.saveOperation(id, op);
      r.status = "sync_error";
      store.save(r);
      throw e;
    }
  }
  return {
    serial,
    current,
    start,
    vote,
    retry,
    cancel,
    choices,
    review,
    publish,
    config: () => ({
      today: day(),
      nextMonday: nextMonday(day()),
      timeZone: TIME_ZONE,
      mealieUrl: mealie.publicUrl,
    }),
    pool: async (fresh = false) => mealie.recipes({ fresh }),
  };
}
