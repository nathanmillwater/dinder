// Optional full-system QA: run against a disposable Dinder instance only.
// Requires playwright-core and Chromium. This script clears that instance's meals.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const artifacts = process.env.DINDER_TEST_ARTIFACTS || "/tmp/dinder-artifacts";
fs.mkdirSync(artifacts, { recursive: true });
const base = process.env.DINDER_TEST_URL || "http://127.0.0.1:3099";
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
(async () => {
  assert.deepEqual(await api("/health"), { ok: true });
  await api("/profiles/1", "PATCH", { name: "Me" });
  await api("/profiles/2", "PATCH", { name: "Partner" });
  for (const m of await api("/meals")) await api("/meals/" + m.id, "DELETE");
  const starters = await api("/seed", "POST");
  assert.equal(starters.length, 12);
  const starts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      api("/rounds", "POST", { profile: (i % 2) + 1 }),
    ),
  );
  assert.equal(new Set(starts.map((r) => r.id)).size, 1);
  assert.equal(starts[0].meals.length, 10);
  const r = starts[0],
    id = r.meals[0].id;
  await api(`/rounds/${r.id}/votes`, "POST", {
    profile: 1,
    mealId: id,
    liked: true,
  });
  const hidden = await api("/rounds/current?profile=2");
  assert.equal(hidden.votes.length, 0);
  const matches = await Promise.all(
    Array.from({ length: 5 }, () =>
      api(`/rounds/${r.id}/votes`, "POST", {
        profile: 2,
        mealId: id,
        liked: true,
      }),
    ),
  );
  assert.ok(matches.every((r) => r.status === "matched" && r.winner.id === id));
  assert.equal((await api("/rounds/current?profile=1")).winner.id, id);
  let round = await api("/rounds", "POST", { profile: 1, mealIds: [id] });
  await api(`/rounds/${round.id}/votes`, "POST", {
    profile: 1,
    mealId: id,
    liked: false,
  });
  assert.equal((await api("/rounds/current?profile=1")).status, "active");
  await api(`/rounds/${round.id}/votes`, "POST", {
    profile: 2,
    mealId: id,
    liked: true,
  });
  assert.equal((await api("/rounds/current?profile=1")).status, "exhausted");
  console.log(
    "PASS API: concurrent starts, simultaneous duplicate votes, private votes, matching and no-match.",
  );
  // Leave the finished round in place; clear the collection for UI onboarding.
  for (const m of await api("/meals")) await api("/meals/" + m.id, "DELETE");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context1 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const context2 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const p1 = await context1.newPage(),
      p2 = await context2.newPage();
    const errors = [];
    for (const page of [p1, p2])
      page.on("pageerror", (e) => errors.push(e.message));
    await Promise.all([p1.goto(base), p2.goto(base)]);
    await p1.locator(".profile-options button").nth(0).click();
    await p2.locator(".profile-options button").nth(1).click();
    await p1
      .getByRole("button", { name: "Add starter meals", exact: false })
      .click();
    await p1.locator(".preview-meal").first().waitFor();
    await p1.evaluate(() => window.scrollTo(0, 0));
    await p1.screenshot({
      path: path.join(artifacts, "dinder-mobile.png"),
      fullPage: true,
    });
    await p1.getByRole("button", { name: /Our meals/ }).click();
    await p1.getByRole("button", { name: "Add a meal", exact: true }).click();
    await p1.getByRole("textbox", { name: /Meal name/ }).fill("QA lemon pasta");
    await p1
      .getByRole("textbox", { name: /A little about it/ })
      .fill("Lemon, parmesan and a little love.");
    await p1
      .getByRole("textbox", { name: /Recipe link/ })
      .fill("https://example.com/pasta");
    await p1.locator("input[type=file]").setInputFiles({
      name: "dinner.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await p1.locator(".upload-preview img").waitFor();
    await p1.getByRole("button", { name: "Add to our meals" }).click();
    await p1.getByRole("dialog").waitFor({ state: "hidden" });
    const added = (await api("/meals")).find(
      (m) => m.name === "QA lemon pasta",
    );
    assert.ok(added.photo.startsWith("/uploads/"));
    assert.equal((await fetch(base + added.photo)).status, 200);
    await p2.getByRole("button", { name: /Our meals/ }).click();
    await p2
      .getByRole("heading", { name: "QA lemon pasta", exact: true })
      .waitFor();
    // Edit and reload to verify persistence.
    await p1
      .getByRole("button", { name: "Edit QA lemon pasta", exact: true })
      .last()
      .click();
    await p1
      .getByRole("textbox", { name: /Meal name/ })
      .fill("Lemon pasta for two");
    await p1.getByRole("button", { name: "Save changes" }).click();
    await p1.getByRole("dialog").waitFor({ state: "hidden" });
    await p1.reload();
    await p1.getByRole("button", { name: /Our meals/ }).click();
    await p1
      .getByRole("heading", { name: "Lemon pasta for two", exact: true })
      .waitFor();
    // Pick a single meal via no-match recovery to make a touch swipe deterministic.
    await p1.getByRole("button", { name: "Discover", exact: true }).click();
    await api("/rounds", "POST", { profile: 1, mealIds: [added.id] });
    await p1.getByRole("button", { name: "Join Match Mode" }).waitFor();
    await p1.getByRole("button", { name: "Join Match Mode" }).click();
    await p2.getByRole("button", { name: "Discover", exact: true }).click();
    await p2.getByRole("button", { name: "Join Match Mode" }).click();
    await context1.setOffline(true);
    await p1.locator(".connection-warning").waitFor();
    await context1.setOffline(false);
    await p1.locator(".connection-warning").waitFor({ state: "hidden" });
    const box = await p1.locator(".swipe-card").boundingBox();
    assert.ok(box);
    await p1.mouse.move(box.x + box.width / 2, box.y + 100);
    await p1.mouse.down();
    await p1.mouse.move(box.x + box.width / 2 + 130, box.y + 105, { steps: 8 });
    await p1.mouse.up();
    await p1.getByRole("heading", { name: "Your cravings are in." }).waitFor();
    await p1.reload();
    await p1.getByRole("heading", { name: "Your cravings are in." }).waitFor();
    await p2.getByRole("button", { name: "Yes please — swipe right" }).click();
    await Promise.all([
      p1.getByRole("heading", { name: "It’s a match!" }).waitFor(),
      p2.getByRole("heading", { name: "It’s a match!" }).waitFor(),
    ]);
    assert.equal(
      await p1.locator(".result-meal h3").innerText(),
      "Lemon pasta for two",
    );
    assert.equal(
      await p2.locator(".result-meal h3").innerText(),
      "Lemon pasta for two",
    );
    await p1.evaluate(() => window.scrollTo(0, 0));
    await p1.screenshot({
      path: path.join(artifacts, "dinder-match.png"),
      fullPage: true,
    });
    // Retry through UI, exercise no-match and manual selection.
    await p1
      .getByRole("button", { name: "Another round?", exact: false })
      .click();
    round = await api("/rounds/current?profile=1");
    for (const m of round.meals) {
      await api(`/rounds/${round.id}/votes`, "POST", {
        profile: 1,
        mealId: m.id,
        liked: false,
      });
      await api(`/rounds/${round.id}/votes`, "POST", {
        profile: 2,
        mealId: m.id,
        liked: false,
      });
    }
    await p1
      .getByRole("heading", { name: "Different cravings tonight?" })
      .waitFor();
    await p1.getByRole("button", { name: "Choose meals ourselves" }).click();
    const boxes = p1.getByRole("dialog").getByRole("checkbox");
    const count = await boxes.count();
    for (let i = 0; i < count; i++) await boxes.nth(i).uncheck();
    await boxes.first().check();
    await p1.getByRole("button", { name: "Start with 1 meal" }).click();
    await p1.locator(".swipe-card").waitFor();
    // Finish this test round using keyboard then the second profile.
    await p1.keyboard.press("ArrowLeft");
    await p1.getByRole("heading", { name: "Your cravings are in." }).waitFor();
    const last = await api("/rounds/current?profile=2");
    await api(`/rounds/${last.id}/votes`, "POST", {
      profile: 2,
      mealId: last.meals[0].id,
      liked: false,
    });
    // Desktop layout and overflow checks.
    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await desktop.goto(base);
    await desktop.locator(".profile-options button").first().click();
    await desktop.locator(".preview-meal").first().waitFor();
    await desktop.screenshot({
      path: path.join(artifacts, "dinder-desktop.png"),
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
      "PASS Browser: two profiles, onboarding, starter meals, uploaded photo, meal editing, shared collection sync, refresh recovery, drag swipe, shared match, no-match retry, manual selection, keyboard input, mobile/desktop layouts.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
