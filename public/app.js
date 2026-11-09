// Minimal client. All untrusted strings (logins, model output) go through textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const form = $("query");
const status = $("status");
let current = null;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const fmt = {
  num: (v) => (v === null || v === undefined ? "n/a" : Number(v).toLocaleString()),
  pct: (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`),
  hours: (v) => (v === null || v === undefined ? "n/a" : v >= 48 ? `${(v / 24).toFixed(1)}d` : `${v}h`),
};

function params() {
  const data = new FormData(form);
  const q = new URLSearchParams();
  if (data.get("from")) q.set("from", data.get("from"));
  if (data.get("to")) q.set("to", data.get("to"));
  if (data.get("includeBots")) q.set("includeBots", "true");
  const [owner, repo] = String(data.get("repo")).trim().split("/");
  return { base: `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/insights`, q };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Request failed with HTTP ${res.status}`);
  return body;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { base, q } = params();
  const button = form.querySelector("button");
  button.disabled = true;
  status.textContent = "Loading. The first request for a repository syncs from GitHub and can take a little while.";
  try {
    current = { base, q };
    render(await getJson(`${base}?${q}`));
    status.textContent = "";
    history.replaceState(
      null,
      "",
      `?${new URLSearchParams({ repo: new FormData(form).get("repo"), ...Object.fromEntries(q) })}`,
    );
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("explain").addEventListener("click", async () => {
  if (!current) return;
  const button = $("explain");
  button.disabled = true;
  $("narrative").replaceChildren(
    el("p", { className: "muted" }, "Thinking through the numbers. This can take up to a minute."),
  );
  try {
    renderNarrative(await getJson(`${current.base}/narrative?${current.q}`));
  } catch (err) {
    $("narrative").replaceChildren(el("p", { className: "warning" }, err.message));
  } finally {
    button.disabled = false;
  }
});

function render(r) {
  $("report").hidden = false;
  $("narrative").replaceChildren(
    el("p", { className: "muted" }, "Ask the model to read these numbers. Every claim links back to a metric below."),
  );
  const change = (metric) => r.changes.find((c) => c.metric === metric);
  const card = (label, metric, format, higherIsBetter) => {
    const c = change(metric);
    let delta = null;
    if (c && c.delta !== null && c.delta !== 0) {
      const good = higherIsBetter === null ? null : c.delta > 0 === higherIsBetter;
      const rel = c.deltaRatio !== null ? ` (${c.deltaRatio > 0 ? "+" : ""}${Math.round(c.deltaRatio * 100)}%)` : "";
      delta = el(
        "div",
        { className: `delta ${good === null ? "muted" : good ? "up" : "down"}` },
        `${c.delta > 0 ? "▲" : "▼"} vs ${format(c.previous)} before${rel}`,
      );
    }
    return el(
      "div",
      { className: "card" },
      el("div", { className: "label" }, label),
      el("div", { className: "value" }, format(c?.current ?? null)),
      delta,
    );
  };

  $("cards").replaceChildren(
    card("PRs merged", "flow.prsMerged", fmt.num, true),
    card("Median time to first review", "flow.medianHoursToFirstReview", fmt.hours, false),
    card("Median time to merge", "flow.medianHoursToMerge", fmt.hours, false),
    card("Merged without review", "flow.mergedWithoutReviewRate", fmt.pct, false),
    card("Reviews submitted", "totals.reviews", fmt.num, true),
    card("Review bus factor", "concentration.reviewBusFactor", fmt.num, true),
  );

  table(
    $("contributors"),
    ["Login", "Merged", "Opened", "+Lines", "-Lines", "Median to merge"],
    r.current.contributors,
    (c) => [
      c.login,
      fmt.num(c.prsMerged),
      fmt.num(c.prsOpened),
      fmt.num(c.linesAdded),
      fmt.num(c.linesDeleted),
      fmt.hours(c.medianHoursToMerge),
    ],
  );
  table(
    $("reviewers"),
    ["Login", "Reviews", "Approvals", "Changes req.", "Comments", "Authors"],
    r.current.reviewers,
    (v) => [
      v.login,
      fmt.num(v.reviews),
      fmt.num(v.approvals),
      fmt.num(v.changesRequested),
      fmt.num(v.reviewComments),
      fmt.num(v.authorsReviewed),
    ],
  );
  table($("pairs"), ["Reviewer → author", "Reviews"], r.current.reviewPairs, (p) => [
    `${p.reviewer} → ${p.author}`,
    fmt.num(p.reviews),
  ]);

  const partial = r.data.complete ? "" : " Sync hit its page cap, so older activity may be missing.";
  $("meta").textContent =
    `${r.repository.owner}/${r.repository.name} · ${r.period.from.slice(0, 10)} to ${r.period.to.slice(0, 16).replace("T", " ")} UTC · ` +
    `compared with ${r.previousPeriod.from.slice(0, 10)} onward · synced ${new Date(r.data.syncedAt).toLocaleString()}.${partial}`;
}

function table(node, headers, rows, cells) {
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      headers.map((h) => el("th", {}, h)),
    ),
  );
  const body = el(
    "tbody",
    {},
    rows.length
      ? rows.map((row) =>
          el(
            "tr",
            {},
            cells(row).map((c) => el("td", {}, c)),
          ),
        )
      : el("tr", {}, el("td", { colSpan: headers.length, className: "muted" }, "No activity in this period")),
  );
  node.replaceChildren(head, body);
}

function evidenceList(items) {
  return el(
    "ul",
    { className: "evidence" },
    items.map((e) => el("li", {}, el("code", {}, e.factId), ` = ${e.value} · ${e.interpretation}`)),
  );
}

function renderNarrative({ narrative: n, generation }) {
  const parts = [el("p", { className: "headline" }, n.headline), el("p", {}, n.summary)];

  for (const o of n.observations) {
    parts.push(
      el(
        "div",
        { className: "observation" },
        el("strong", {}, o.title),
        el("div", {}, o.detail),
        evidenceList(o.evidence),
      ),
    );
  }

  if (n.hypothesis) {
    const h = n.hypothesis;
    const adjustments = h.confidenceAdjustments.map((a) => el("li", {}, `${a.reason} → ${a.confidenceAfter}`));
    parts.push(
      el(
        "h3",
        {},
        "Root-cause hypothesis ",
        el("span", { className: "confidence", title: `Model said ${h.modelConfidence}` }, `confidence ${h.confidence}`),
      ),
      el("p", {}, h.statement),
      el("p", { className: "muted" }, h.reasoning),
      evidenceList(h.evidence),
      adjustments.length ? el("ul", { className: "small muted" }, adjustments) : null,
      h.alternativeExplanations.length
        ? el("p", { className: "small" }, `Other explanations: ${h.alternativeExplanations.join("; ")}`)
        : null,
      el("p", { className: "small" }, `To confirm: ${h.howToConfirm}`),
    );
  } else {
    parts.push(el("p", { className: "muted" }, "The model found no root cause the data supports."));
  }

  if (n.caveats.length) parts.push(el("p", { className: "small muted" }, `Caveats: ${n.caveats.join(" ")}`));

  const v = n.verification;
  if (!v.grounded) {
    const issues = [];
    if (v.unknownFactIds.length) issues.push(`dropped ${v.unknownFactIds.length} citation(s) to unknown metrics`);
    if (v.unverifiedNumbers.length) issues.push(`numbers not found in the data: ${v.unverifiedNumbers.join(", ")}`);
    parts.push(el("p", { className: "warning" }, `Verification: ${issues.join("; ")}.`));
  }
  parts.push(
    el(
      "p",
      { className: "small muted" },
      `${generation.model} · ${v.citedFacts} cited facts · ${generation.cached ? "cached" : "fresh"}`,
    ),
  );

  $("narrative").replaceChildren(...parts);
}

// Restore a shared link like /?repo=owner/name&from=2026-10-01.
const initial = new URLSearchParams(location.search);
for (const key of ["repo", "from", "to"]) if (initial.get(key)) form.elements[key].value = initial.get(key);
if (initial.get("includeBots") === "true") form.elements.includeBots.checked = true;
if (initial.get("repo")) form.requestSubmit();
