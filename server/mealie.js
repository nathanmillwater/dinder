import { userError } from "./store.js";
export function createMealie({
  url = process.env.MEALIE_URL || "https://recipes.muthur.network",
  publicUrl = process.env.MEALIE_PUBLIC_URL || url,
  token = process.env.MEALIE_API_TOKEN,
  fetchImpl = fetch,
  cacheMs = 15_000,
} = {}) {
  const cleanUrl = (value) => {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw Error(
        "Mealie URLs must be HTTP(S) URLs without credentials, queries or fragments.",
      );
    return u.href.replace(/\/$/, "");
  };
  const api = cleanUrl(url),
    publicBase = cleanUrl(publicUrl);
  let cached,
    expires = 0,
    pending;
  async function request(route, method = "GET", body) {
    if (!token)
      throw userError("Configure the Mealie API token to connect Dinder.", 503);
    let response;
    try {
      response = await fetchImpl(api + route, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw userError(
        "Cannot reach Mealie. Your progress is saved; reconnect and retry.",
        502,
      );
    }
    if ([401, 403].includes(response.status))
      throw userError(
        "Mealie refused access. Check the server token and household permissions.",
        503,
      );
    if (!response.ok && !(method === "DELETE" && response.status === 404))
      throw userError(
        `Mealie could not ${method === "GET" ? "load data" : "save the change"}. Reconnect and retry.`,
        502,
      );
    if (
      response.status === 204 ||
      (method === "DELETE" && response.status === 404)
    )
      return null;
    try {
      return await response.json();
    } catch {
      throw userError(
        "Mealie returned an invalid response. Retry to reconcile the change.",
        502,
      );
    }
  }
  async function pages(path, query = {}) {
    const all = [];
    for (let page = 1; page <= 1000; page++) {
      const params = new URLSearchParams({
        ...query,
        page: String(page),
        perPage: "100",
        orderBy: path === "/api/recipes" ? "id" : "date",
        orderDirection: "asc",
      });
      const result = await request(path + "?" + params);
      if (
        !result ||
        !Array.isArray(result.items) ||
        !Number.isInteger(result.total_pages) ||
        result.total_pages < 0
      )
        throw userError("Mealie returned an invalid list.", 502);
      all.push(...result.items);
      if (page >= result.total_pages) return all;
    }
    throw userError("Mealie returned too many pages.", 502);
  }
  async function loadRecipes() {
    const group = await request("/api/groups/self");
    if (!group || typeof group.slug !== "string" || !group.slug)
      throw userError("Mealie returned an invalid household group.", 502);
    const recipes = await pages("/api/recipes");
    return [
      ...new Map(
        recipes.map((r) => {
          if (
            !r ||
            typeof r.id !== "string" ||
            !r.id ||
            typeof r.name !== "string" ||
            typeof r.slug !== "string" ||
            !r.slug
          )
            throw userError("Mealie returned an invalid recipe.", 502);
          return [
            r.id,
            {
              id: r.id,
              name: r.name,
              notes: typeof r.description === "string" ? r.description : "",
              photo:
                r.image && r.image !== "no image"
                  ? `${publicBase}/api/media/recipes/${encodeURIComponent(r.id)}/images/original.webp?version=${encodeURIComponent(String(r.image))}`
                  : "",
              recipe: `${publicBase}/g/${encodeURIComponent(group.slug)}/r/${encodeURIComponent(r.slug)}`,
            },
          ];
        }),
      ).values(),
    ];
  }
  async function recipes({ fresh = false } = {}) {
    if (!fresh && cached && Date.now() < expires) return cached;
    if (!pending)
      pending = loadRecipes()
        .then((result) => {
          cached = result;
          expires = Date.now() + cacheMs;
          return result;
        })
        .catch((error) => {
          expires = 0;
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
    return pending;
  }
  const entries = (start, end) =>
    pages("/api/households/mealplans", { start_date: start, end_date: end });
  return {
    recipes,
    entries,
    publicUrl: publicBase,
    create: (body) => request("/api/households/mealplans", "POST", body),
    update: (id, body) =>
      request(`/api/households/mealplans/${id}`, "PUT", body),
    remove: (id) => request(`/api/households/mealplans/${id}`, "DELETE"),
  };
}
