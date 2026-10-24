// Run after npm run build. Uses disposable Dinder/Mealie instances only.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const artifacts =
  process.env.DINDER_TEST_ARTIFACTS || "/tmp/dinder-v2-artifacts";
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
  const { startMealie, startDinder, planEntry, recipes } =
    await import("./helpers.js");
  const mealie = await startMealie();
  let app, browser;
  try {
    app = await startDinder(mealie.url);
    async function api(route, body, profile = 1) {
      const res = await fetch(
        app.url +
          "/api" +
          route +
          (route.includes("?") ? "&" : "?") +
          "profile=" +
          profile,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return data;
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const c1 = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      }),
      c2 = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
    const p1 = await c1.newPage(),
      p2 = await c2.newPage(),
      errors = [];
    for (const p of [p1, p2]) {
      p.on("pageerror", (e) => errors.push(e.message));
      await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
      await p.goto(app.url);
    }
    await p1.locator(".profile-options button").nth(0).click();
    await p2.locator(".profile-options button").nth(1).click();
    await p1.locator(".recipe-tile").first().waitFor();
    await p1.screenshot({
      path: path.join(artifacts, "home-mobile.png"),
      fullPage: true,
    });
    await p1.getByRole("textbox", { name: "Search recipes" }).fill("Dinner 12");
    assert.equal(await p1.locator(".recipe-tile").count(), 1);
    await p1.getByRole("textbox", { name: "Search recipes" }).fill("");
    await p1
      .getByRole("button", { name: "Plan our week", exact: true })
      .click();
    await p1.locator(".swipe-card").waitFor();
    await p2
      .getByRole("button", { name: "Join Meal Planner", exact: true })
      .click();
    await p2.locator(".swipe-card").waitFor();
    let state = await api("/state"),
      r = state.round;
    const first = r.current.id;
    await p1.getByRole("button", { name: "Yes please — swipe right" }).click();
    await api("/rounds/" + r.id + "/votes", { mealId: first, liked: true }, 2);
    const rest = state.recipes.filter((m) => m.id !== first).slice(0, 6);
    for (const m of rest)
      for (const profile of [1, 2])
        await api(
          "/rounds/" + r.id + "/votes",
          { mealId: m.id, liked: true },
          profile,
        );
    await p1
      .getByRole("heading", { name: "Your week is ready to review." })
      .waitFor();
    state = await api("/state");
    r = state.round;
    mealie.state.entries = [
      planEntry(1, r.dates[0]),
      planEntry(2, r.dates[0], recipes[0].id, "lunch"),
      planEntry(3, state.today, recipes[10].id),
    ];
    const night = p1.getByRole("combobox").first();
    await night.selectOption(r.dates[1]);
    await p1.getByRole("button", { name: "Review Mealie changes" }).click();
    await p1.getByRole("button", { name: "Confirm & publish plan" }).click();
    await p1
      .getByRole("heading", { name: "Your plan is in Mealie." })
      .waitFor();
    assert.equal(
      mealie.state.entries.filter(
        (e) => e.entryType === "dinner" && r.dates.includes(e.date),
      ).length,
      7,
    );
    assert.ok(mealie.state.entries.some((e) => e.id === 2));
    await p1.screenshot({
      path: path.join(artifacts, "planner-published.png"),
      fullPage: true,
    });
    await p1
      .getByRole("button", { name: "Back to your table", exact: true })
      .click();
    await p1.getByRole("radio", { name: /The meal plan/ }).check();
    await p1
      .getByRole("button", { name: "Pick tonight’s dinner", exact: true })
      .click();
    await p1.locator(".swipe-card").waitFor();
    r = (await api("/state")).round;
    const chosen = r.current.id;
    await api("/rounds/" + r.id + "/votes", { mealId: chosen, liked: true }, 2);
    // A drag swipe exercises the same guarded vote path as the buttons.
    await p1.locator(".swipe-card").scrollIntoViewIfNeeded();
    const box = await p1.locator(".swipe-card").boundingBox();
    await p1.mouse.move(box.x + box.width / 2, box.y + 80);
    await p1.mouse.down();
    await p1.mouse.move(box.x + box.width / 2 + 125, box.y + 85, { steps: 8 });
    await p1.locator(".swipe-stamp.yes").waitFor({ timeout: 2000 });
    await p1.mouse.up();
    await p1.getByRole("heading", { name: "It’s a match!" }).waitFor();
    const choice = await api("/rounds/" + r.id + "/choices"),
      source = choice.entries.find((e) => e.recipeId === chosen);
    await p1
      .getByRole("combobox", { name: "Planned dinner to move" })
      .selectOption(String(source.id));
    await p1.getByRole("button", { name: "Review tonight’s change" }).click();
    await p1.getByRole("button", { name: "Confirm tonight’s dinner" }).click();
    await p1
      .getByRole("heading", { name: "Tonight’s dinner, sorted." })
      .waitFor();
    assert.equal(
      mealie.state.entries.find((e) => e.id === source.id).date,
      state.today,
    );
    assert.equal(
      mealie.state.entries.find((e) => e.id === 3).date,
      source.date,
    );
    await p1
      .getByRole("button", { name: "Back to your table", exact: true })
      .click();
    await p1.getByRole("radio", { name: /All recipes/ }).check();
    await p1
      .getByRole("button", { name: "Pick tonight’s dinner", exact: true })
      .click();
    await p1.locator(".swipe-card").waitFor();
    const before = (await api("/state")).round;
    mealie.state.status = 503;
    await p1.getByRole("button", { name: "Refresh", exact: true }).click();
    await p1.locator(".connection-warning").waitFor();
    assert.ok(
      await p1
        .getByRole("button", { name: "Yes please — swipe right" })
        .isDisabled(),
    );
    mealie.state.status = 200;
    await p1.getByRole("button", { name: "Refresh", exact: true }).click();
    await p1.locator(".connection-warning").waitFor({ state: "hidden" });
    mealie.state.recipes.push({
      ...recipes[0],
      id: "new-live",
      name: "A live new recipe",
      slug: "new-live",
    });
    await p1.getByRole("button", { name: "Refresh", exact: true }).click();
    assert.equal((await api("/state")).round.total, 13);
    await p1.getByRole("button", { name: "Not tonight — swipe left" }).click();
    await p1.reload();
    await p1.locator(".swipe-card").waitFor();
    assert.equal((await api("/state")).round.progress[0].count, 1);
    await p1.keyboard.press("ArrowLeft");
    await p1.waitForFunction(
      async () =>
        (await (await fetch("/api/state?profile=1")).json()).round.progress[0]
          .count === 2,
    );
    await p1.getByRole("button", { name: "Cancel round", exact: true }).click();
    await p1.getByRole("button", { name: "Discard round" }).click();
    await p1
      .getByRole("button", { name: "Plan our week", exact: true })
      .waitFor();
    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await desktop.route("https://fonts.googleapis.com/**", (r) => r.abort());
    await desktop.goto(app.url);
    await desktop.locator(".profile-options button").first().click();
    await desktop.locator(".recipe-tile").first().waitFor();
    await desktop.screenshot({
      path: path.join(artifacts, "home-desktop.png"),
      fullPage: true,
    });
    for (const page of [p1, p2, desktop])
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        "No horizontal overflow",
      );
    assert.deepEqual(errors, []);
    console.log(
      "PASS Browser: two profiles, mobile/desktop, live pool, planning/reordering/publishing, planned dinner swap, drag swiping, outage pause/reconnect, refresh recovery and cancellation.",
    );
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    await mealie.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
