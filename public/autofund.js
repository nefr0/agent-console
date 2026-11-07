// Autofund page: a read view of GET /api/autofund plus confirmed writes to POST /api/autofund/action.
// Static skeleton in autofund.html; each section has a small render function that replaces its rows.
const REFRESH_MS = 60000;
const DECISIONS_STEP = 20;
const HORIZON_ORDER = ["24h", "7d", "1m", "1y"];
const AMOUNT_RE = /^\d+(\.\d+)?$/;

let data = null;
let timer = null;
let loadedAt = 0;
let inflight = false;
let horizon = "1m";
let decisionsShown = DECISIONS_STEP;
let pendingRun = null;
let Chart = null;
let chart = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdAxis = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const usd = (n) => (Number.isFinite(Number(n)) && n !== null ? usdFmt.format(Number(n)) : "n/a");
const inr = (n) => (Number.isFinite(Number(n)) && n !== null ? inrFmt.format(Number(n)) : "n/a");
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : "n/a");
const stamp = (iso) => {
  const when = iso ? new Date(iso) : null;
  if (!when || Number.isNaN(when.getTime())) return "never";
  return when.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ---------- network ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, init) {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `Request failed (${res.status})`);
  return body;
}
const postAction = (verb, args) =>
  api("/api/autofund/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, args }),
  });

// ---------- small ui helpers ----------

function toast(text, tone) {
  const node = $("toast");
  node.textContent = text;
  node.dataset.tone = tone || "";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3000);
}

function pill(node, text, tone) {
  node.textContent = text;
  node.dataset.tone = tone || "";
  node.hidden = !text;
}

function emptyOr(list, empty, count) {
  list.hidden = count === 0;
  empty.hidden = count !== 0;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  } catch {
    toast("Copy is not available here. Select the text instead.", "bad");
  }
}

// ---------- confirm sheet ----------

/** Every write goes through here: show what will happen, run only on Confirm. */
function ask({ title, body, okLabel, danger, run }) {
  $("c-title").textContent = title;
  $("c-body").textContent = body;
  $("c-err").hidden = true;
  const ok = $("c-ok");
  ok.textContent = okLabel;
  ok.disabled = false;
  ok.classList.toggle("primary", !danger);
  ok.classList.toggle("danger-fill", Boolean(danger));
  pendingRun = run;
  $("confirm").showModal();
}

async function onConfirm() {
  const ok = $("c-ok");
  ok.disabled = true;
  try {
    const message = await pendingRun();
    $("confirm").close();
    toast(message || "Done", "ok");
    load();
  } catch (err) {
    $("c-err").textContent = err.message;
    $("c-err").hidden = false;
    ok.disabled = false;
  }
}

const doAction = (verb, args, message) => async () => {
  await postAction(verb, args);
  return message;
};

// ---------- header ----------

const STATUS_TONE = { active: "ok", hibernating: "warn", KILL: "bad" };

function renderVitals(summary) {
  $("vitals").hidden = false;
  $("v-usd").textContent = usd(summary.balance_usd);
  $("v-inr").textContent = `${inr(summary.balance_inr)} at ${summary.fx_inr_per_usd} INR/USD`;
  const days = summary.runway_days;
  $("v-run").textContent = days == null ? "n/a" : `${Math.round(days)} days`;
  pill($("v-status"), summary.status, STATUS_TONE[summary.status] || "");
  pill(
    $("v-mode"),
    summary.mode === "live" ? "Live" : "Paper",
    summary.mode === "live" ? "accent" : "",
  );
  const engaged = data.kill_engaged;
  pill($("v-kill"), engaged ? "Kill engaged" : "Kill off", engaged ? "bad" : "");
}

function renderMeta() {
  const generated = stamp(data.generated_at);
  $("meta").textContent = `Data from ${generated}. Refreshes every minute.`;
  const banner = $("stale");
  banner.hidden = !data.stale;
  if (data.stale) {
    banner.dataset.tone = "warn";
    banner.textContent = `Stale since ${stamp(data.stale_since)}. Showing the last good data.`;
  }
}

// ---------- projection ----------

const projectionRows = () => data.projection.rows || [];
const selectedRow = () => projectionRows().find((r) => r.label === horizon) || projectionRows()[0];
const hasBand = (row) => row && row.p50 != null;

function projectionNote(proj) {
  if (proj.source === "model") {
    return "Lending yield model only, before costs: compare with the cost-carry line. Not realized results.";
  }
  if (proj.source === "none") {
    return "No band yet: fewer than 30 days of data and no lending marks for a model band.";
  }
  return proj.insufficient_data
    ? "Realized results, but fewer than 30 days of data: treat as indicative."
    : "Realized results from the ledger.";
}

function renderRange() {
  const box = $("p-range");
  const labels = HORIZON_ORDER.filter((l) => projectionRows().some((r) => r.label === l));
  box.replaceChildren(
    ...labels.map((label) => {
      const btn = el("button", null, label);
      btn.type = "button";
      btn.dataset.range = label;
      btn.setAttribute("aria-pressed", String(label === horizon));
      return btn;
    }),
  );
}

function gridCell(label, value) {
  const wrap = el("div");
  wrap.append(el("dt", null, label), el("dd", null, value));
  return wrap;
}

function renderGrid(row) {
  const grid = $("p-grid");
  if (!row) return grid.replaceChildren();
  const cells = [];
  if (hasBand(row)) {
    for (const key of ["p5", "p25", "p50", "p75", "p95"]) {
      cells.push(gridCell(key.toUpperCase(), usd(row[key])));
    }
  }
  cells.push(gridCell("Cost carry", usd(row.carry)));
  const odds = row.prob_net_nonneg;
  cells.push(gridCell("P(net >= 0)", odds == null ? "n/a" : pct(odds)));
  if (row.extrapolated || (data.projection.grey_year && row.horizon >= 365)) {
    cells.push(gridCell("Basis", "extrapolated"));
  }
  grid.replaceChildren(...cells);
}

function renderProjection() {
  const proj = data.projection;
  const tone = proj.source === "realized" ? "ok" : proj.source === "model" ? "warn" : "";
  pill($("p-badge"), proj.badge, tone);
  $("p-note").textContent = projectionNote(proj);
  if (!projectionRows().some((r) => r.label === horizon)) horizon = projectionRows()[0]?.label;
  renderRange();
  renderGrid(selectedRow());
  drawChart();
}

function alpha(hex, level) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const num = Number.parseInt(match[1], 16);
  return `rgba(${num >> 16}, ${(num >> 8) & 255}, ${num & 255}, ${level})`;
}

function bandSeries(rows, key, style) {
  const points = [0, ...rows.map((r) => r[key])];
  return { label: key.toUpperCase(), data: points, ...style };
}

function chartDatasets(rows) {
  const model = data.projection.source !== "realized" || rows.some((r) => r.extrapolated);
  const base = css("--viz-1");
  const edge = alpha(base, model ? 0.55 : 0.8);
  const line = { pointRadius: 3, pointHoverRadius: 5, borderWidth: 1.5, tension: 0 };
  const dash = model ? [5, 4] : [];
  const sets = [];
  if (rows.every(hasBand)) {
    const outer = {
      ...line,
      borderColor: edge,
      borderDash: dash,
      backgroundColor: alpha(base, 0.1),
    };
    const inner = {
      ...line,
      borderColor: edge,
      borderDash: dash,
      backgroundColor: alpha(base, 0.2),
    };
    sets.push(
      bandSeries(rows, "p95", { ...outer, fill: 4 }),
      bandSeries(rows, "p75", { ...inner, fill: 3 }),
      bandSeries(rows, "p50", {
        ...line,
        borderColor: base,
        borderWidth: 2.5,
        borderDash: dash,
        fill: false,
      }),
      bandSeries(rows, "p25", { ...inner, fill: false }),
      bandSeries(rows, "p5", { ...outer, fill: false }),
    );
  }
  const carry = css("--bad");
  sets.push({
    ...bandSeries(rows, "carry", { ...line, borderColor: carry, borderDash: [2, 3], fill: false }),
  });
  return sets;
}

function chartOptions(labels) {
  const grid = css("--edge");
  const tick = css("--t3");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${usd(c.parsed.y)}` } },
    },
    scales: {
      x: {
        type: "category",
        labels,
        ticks: { color: tick },
        grid: { color: grid },
        border: { display: false },
      },
      y: {
        ticks: { color: tick, maxTicksLimit: 5, callback: (v) => usdAxis.format(v) },
        grid: { color: grid },
        border: { display: false },
      },
    },
  };
}

function drawChart() {
  const box = document.querySelector(".af-chart");
  const sel = selectedRow();
  const rows = projectionRows().filter((r) => sel && r.horizon <= sel.horizon);
  box.hidden = !Chart || rows.length === 0;
  if (box.hidden) return;
  const labels = ["now", ...rows.map((r) => r.label)];
  if (chart) chart.destroy();
  chart = new Chart($("p-chart"), {
    type: "line",
    data: { labels, datasets: chartDatasets(rows) },
    options: chartOptions(labels),
  });
}

async function loadChart() {
  try {
    await import("./vendor/chart.umd.min.js");
    Chart = globalThis.Chart;
    Chart.defaults.font.family = css("--font-mono");
    Chart.defaults.font.size = 11;
    if (data) drawChart();
  } catch {
    Chart = null;
  }
}

// ---------- revenue and costs ----------

function moneyRow(name, value, tone, note) {
  const row = el("li");
  const label = el("span", null, name);
  if (note) label.append(" ", el("small", null, note));
  row.append(label, el("span", `af-num ${tone || ""}`, value));
  return row;
}

function renderMoney() {
  const sum = data.summary;
  $("m-rev").replaceChildren(
    ...Object.entries(sum.revenue).map(([name, v]) => moneyRow(name, usd(v), v > 0 ? "pos" : "")),
  );
  $("m-cost-h").textContent = `Costs (${sum.costs.days} days)`;
  $("m-cost").replaceChildren(
    moneyRow("Max plan", usd(-sum.costs.max), "neg"),
    moneyRow("VPS", usd(-sum.costs.vps), "neg"),
    moneyRow("OpenRouter", usd(-sum.costs.openrouter), "neg"),
    moneyRow(
      "Tax provision",
      `${inr(sum.tax_provision_inr)} (${usd(sum.tax_provision_usd)})`,
      "neg",
    ),
    moneyRow(
      "Cost to cover per month",
      `${usd(sum.cost_to_cover_month_usd)} (${inr(sum.cost_to_cover_month_inr)})`,
    ),
  );
  const entries = data.operator.revenue_entries || [];
  $("m-entries-wrap").hidden = entries.length === 0;
  $("m-entries").replaceChildren(
    ...entries.map((e) =>
      moneyRow(e.source, usd(e.amount_usd), "", `${stamp(e.ts)} ${e.note || ""}`),
    ),
  );
  renderSources();
}

function renderSources() {
  const select = $("rev-src");
  const names = data.revenue_sources || [];
  if (
    select.options.length === names.length &&
    names.every((n, i) => select.options[i].value === n)
  )
    return;
  select.replaceChildren(
    ...names.map((name) => {
      const opt = el("option", null, name);
      opt.value = name;
      return opt;
    }),
  );
}

function onRevenueSubmit(event) {
  event.preventDefault();
  const source = $("rev-src").value;
  const amount = $("rev-amt").value.trim();
  const err = $("rev-err");
  const valid = AMOUNT_RE.test(amount) && Number(amount) > 0;
  err.hidden = valid;
  err.textContent = "Enter a positive amount like 12.50.";
  if (!valid) return;
  ask({
    title: "Record revenue?",
    body: `Records ${usd(amount)} from ${source} as an operator entry. It is not in the ledger until reconciled.`,
    okLabel: "Record revenue",
    run: async () => {
      await postAction("revenue", [source, amount]);
      $("rev-amt").value = "";
      return "Revenue recorded";
    },
  });
}

// ---------- agents ----------

function meter(label, value, warn) {
  const wrap = el("div", "af-meter");
  const head = el("div", "af-meter-head");
  head.append(el("span", null, label));
  if (!Number.isFinite(value)) {
    head.append(el("b", null, "n/a"));
    wrap.append(head);
    return wrap;
  }
  const hot = value >= warn;
  head.append(el("b", null, hot ? `${pct(value)} hot` : pct(value)));
  const track = el("div", "af-track");
  track.setAttribute("role", "meter");
  track.setAttribute("aria-label", `${label} usage window`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  const fill = el("i");
  fill.style.width = `${Math.min(100, Math.round(value * 100))}%`;
  track.append(fill);
  wrap.dataset.hot = String(hot);
  wrap.append(head, track);
  return wrap;
}

function agentCard(agent, warn) {
  const card = el("li", "af-card");
  const top = el("div", "af-line");
  top.append(el("code", "af-mono", agent.task_id), el("span", "af-sub", `${agent.turns} turns`));
  const cost = el("div", "af-sub", `${usd(agent.amount_usd)} API-equivalent`);
  const meters = el("div", "af-meters");
  meters.append(meter("5h", agent.five_hour, warn), meter("7d", agent.seven_day, warn));
  card.append(top, cost, meters);
  return card;
}

function renderAgents() {
  const agents = data.agents || [];
  emptyOr($("a-list"), $("a-empty"), agents.length);
  $("a-list").replaceChildren(...agents.map((a) => agentCard(a, data.warn_util)));
}

// ---------- review queue ----------

const REVIEW_TONE = { approved: "ok", rejected: "bad", pending: "warn" };

function reviewButtons(item) {
  const box = el("div", "af-actions");
  const approve = el("button", "btn primary", "Approve");
  const reject = el("button", "btn", "Reject");
  approve.type = reject.type = "button";
  approve.onclick = () => confirmReview(item, "approve");
  reject.onclick = () => confirmReview(item, "reject");
  box.append(approve, reject);
  return box;
}

function confirmReview(item, verb) {
  const past = verb === "approve" ? "approved" : "rejected";
  ask({
    title: `${verb === "approve" ? "Approve" : "Reject"} this item?`,
    body: `"${item.title}" (#${item.id}) will be marked ${past}.`,
    okLabel: verb === "approve" ? "Approve" : "Reject",
    run: doAction(verb, [String(item.id)], `Item ${past}`),
  });
}

function reviewCard(item) {
  const card = el("li", "af-card");
  const top = el("div", "af-line");
  top.append(el("b", null, item.title), el("span", "af-tag", item.kind));
  const status = el("span", "af-pill");
  pill(status, item.status, REVIEW_TONE[item.status] || "");
  top.append(status);
  card.append(top);
  if (item.body) {
    const more = el("details");
    more.append(el("summary", null, "Details"), el("pre", null, item.body));
    card.append(more);
  }
  if (item.status === "pending") card.append(reviewButtons(item));
  else card.append(el("div", "af-sub", `Decided ${stamp(item.decided_ts)}`));
  return card;
}

function renderReview() {
  const items = data.operator.review || [];
  const pending = items.filter((i) => i.status === "pending").length;
  $("r-count").textContent = pending ? `${pending} pending` : "";
  emptyOr($("r-list"), $("r-empty"), items.length);
  $("r-list").replaceChildren(...items.map(reviewCard));
}

// ---------- alerts, requests ----------

const SEVERITY_TONE = { warn: "warn", warning: "warn", error: "bad", critical: "bad" };

function alertCard(alert) {
  const card = el("li", "af-card");
  const top = el("div", "af-line");
  const sev = el("span", "af-pill");
  pill(sev, alert.severity, SEVERITY_TONE[alert.severity] || "");
  top.append(sev, el("span", null, alert.message));
  card.append(top, el("div", "af-sub", stamp(alert.ts)));
  return card;
}

function requestCard(req) {
  const card = el("li", "af-card");
  const top = el("div", "af-line");
  top.append(el("b", null, req.title), el("span", "af-tag", req.status));
  card.append(top);
  if (req.detail) card.append(el("div", null, req.detail));
  card.append(el("div", "af-sub", stamp(req.ts)));
  return card;
}

function renderAlerts() {
  const alerts = data.alerts || [];
  const reqs = data.requests || [];
  emptyOr($("al-list"), $("al-empty"), alerts.length);
  emptyOr($("rq-list"), $("rq-empty"), reqs.length);
  $("al-list").replaceChildren(...alerts.map(alertCard));
  $("rq-list").replaceChildren(...reqs.map(requestCard));
  $("ack-last").textContent = data.last_ack
    ? `Last acknowledged ${stamp(data.last_ack)}`
    : "Never acknowledged";
}

// ---------- decisions ----------

function decisionCard(dec) {
  const card = el("li", "af-card");
  const top = el("div", "af-line");
  const verdict = el("span", "af-pill");
  pill(verdict, dec.verdict, dec.approved ? "ok" : "bad");
  top.append(verdict, el("b", null, `${dec.action} ${usd(dec.amount_usd)}`));
  card.append(top, el("div", "af-sub", `${dec.strategy} / ${dec.proposal_id}`));
  const reasons = (dec.reasons || []).join("; ");
  card.append(el("div", "af-sub", `${stamp(dec.ts)} #${dec.seq}${reasons ? ` - ${reasons}` : ""}`));
  return card;
}

function renderDecisions() {
  const all = data.decisions || [];
  const shown = all.slice(0, decisionsShown);
  emptyOr($("d-list"), $("d-empty"), all.length);
  $("d-count").textContent = all.length ? `latest ${shown.length} of ${all.length}` : "";
  $("d-list").replaceChildren(...shown.map(decisionCard));
  const rest = all.length - shown.length;
  $("d-more").hidden = rest <= 0;
  $("d-more").textContent = `Show ${Math.min(rest, DECISIONS_STEP)} more`;
}

// ---------- deposit, kill ----------

function renderDeposit() {
  const address = data.safe_address;
  $("dep-body").hidden = !address;
  $("dep-empty").hidden = Boolean(address);
  if (!address) return;
  $("dep-addr").textContent = address;
  const qr = $("dep-qr");
  qr.hidden = !data.qr_data_uri;
  if (data.qr_data_uri) qr.src = data.qr_data_uri;
}

function renderKill() {
  $("k-cmd").textContent = data.kill_command;
  const requests = data.operator.kill_requests || [];
  $("k-log").textContent = requests.length
    ? `Recorded requests: ${requests.map((k) => stamp(k.ts)).join(", ")}`
    : "";
  $("k-btn").disabled = false;
}

// ---------- page states ----------

function showState(title, text, retry) {
  const card = $("state");
  card.hidden = false;
  card.replaceChildren(el("h2", null, title), el("p", "af-note", text));
  if (retry) {
    const btn = el("button", "btn primary", "Retry");
    btn.type = "button";
    btn.onclick = load;
    card.append(btn);
  }
}

function clearState() {
  $("state").hidden = true;
}

function render() {
  clearState();
  $("content").hidden = false;
  $("afm").setAttribute("aria-busy", "false");
  renderVitals(data.summary);
  renderMeta();
  renderProjection();
  renderMoney();
  renderAgents();
  renderReview();
  renderAlerts();
  renderDecisions();
  renderDeposit();
  renderKill();
}

function onLoadError(err) {
  $("afm").setAttribute("aria-busy", "false");
  if (err.status === 503) {
    data = null;
    $("content").hidden = true;
    $("vitals").hidden = true;
    return showState(
      "Not configured",
      "Autofund is not set up on this server yet, so there is nothing to show.",
    );
  }
  if (data) {
    $("stale").hidden = false;
    $("stale").dataset.tone = "bad";
    $("stale").textContent =
      `Could not refresh: ${err.message}. Showing the last data from ${stamp(data.generated_at)}.`;
    return;
  }
  showState("Could not load Autofund", err.message, true);
}

async function load() {
  if (inflight) return;
  inflight = true;
  $("refresh").disabled = true;
  try {
    data = await api("/api/autofund");
    loadedAt = Date.now();
    render();
  } catch (err) {
    onLoadError(err);
  } finally {
    inflight = false;
    $("refresh").disabled = false;
  }
}

// ---------- refresh loop ----------

function startTimer() {
  clearInterval(timer);
  timer = setInterval(load, REFRESH_MS);
}

function onVisibility() {
  if (document.hidden) return clearInterval(timer);
  if (Date.now() - loadedAt >= REFRESH_MS) load();
  startTimer();
}

// ---------- wiring ----------

$("refresh").onclick = load;
$("c-cancel").onclick = () => $("confirm").close();
$("c-ok").onclick = onConfirm;
$("rev-form").onsubmit = onRevenueSubmit;
$("dep-copy").onclick = (e) => copyText(data.safe_address, e.currentTarget);
$("k-copy").onclick = (e) => copyText(data.kill_command, e.currentTarget);
$("d-more").onclick = () => {
  decisionsShown += DECISIONS_STEP;
  renderDecisions();
};
$("p-range").onclick = (e) => {
  const label = e.target.closest("button")?.dataset.range;
  if (!label || !data) return;
  horizon = label;
  renderProjection();
};
$("ack").onclick = () =>
  ask({
    title: "Acknowledge alerts?",
    body: "Records that you have seen the current alerts and requests.",
    okLabel: "Acknowledge",
    run: doAction("ack", [], "Acknowledged"),
  });
$("k-btn").onclick = () =>
  ask({
    title: "Record a kill request?",
    body: "This only records the request. Autofund keeps running until the kill file is created on the operator machine.",
    okLabel: "Request kill",
    danger: true,
    run: doAction("kill", [], "Kill request recorded"),
  });
document.addEventListener("visibilitychange", onVisibility);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => data && drawChart());

load();
loadChart();
startTimer();
