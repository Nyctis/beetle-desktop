"use strict";

// Every value goes through `esc` on its way into the page, because a seller's model
// writes some of it, and this page can spend money.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
class Raw { constructor(s) { this.s = s; } }
const esc = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join("")
  : String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);
const h = (parts, ...values) => new Raw(parts.reduce((out, p, i) => out + p + (i < values.length ? esc(values[i]) : ""), ""));

const usd = (v, digits = 2) => `$${Number(v || 0).toFixed(digits)}`;
const cents = v => usd(v, v > 0 && v < 0.01 ? 4 : 2);
const short = a => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "";
const clock = at => new Date(at * 1000).toLocaleTimeString("en-GB");
const when = at => new Date(at * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const TIER_TONE = { "T3-C": "bad", "T3-B": "warn", MOCK: "bad", T2: "ok", T1: "ok" };
const tier = t => h`<span class="tier ${TIER_TONE[t] || ""}">${t}</span>`;
const NETWORK = { open: "open", eim: "direct works", edm: "direct is hard", blocked: "blocked", unknown: "unknown" };
const copy = value => h`<button class="copy" data-copy="${value}" aria-label="Copy" title="Copy"><svg aria-hidden="true"><use href="#copy"/></svg></button>`;
const INFER_CAP_USD = 0.5;  // what a remote chat may hold in its payment channel

const TITLES = { overview: "Overview", chat: "Chat", train: "Train", models: "Models", market: "Market",
  network: "Network", connect: "Connect", host: "Status", offer: "Setup", wallet: "Wallet" };
const NAV = {
  use: [["overview", "chat", "train", "models"], ["market", "network", "connect"]],
  host: [["host", "offer"], ["market", "network"]],
};
const HOST_PAGES = ["host", "offer"];

const state = {
  page: location.hash.slice(1) || "overview", mode: "use", kind: "train", route: "local",
  open: null, all: false, drawer: null, sheet: null, model: null, seller: null, draft: "", busy: false,
  lastProof: null, awake: false, tray: "", hostForm: { model: "qwen3.5-2b", in: "1.00", out: "3.00", slots: "1" },
};
const data = { thread: [], proofs: {} };  // what the daemon last said, by source
const errors = {};

const SOURCES = {
  info: "/native/info", agents: "/native/agents", wallet: "/api/beetle/wallet", doctor: "/api/beetle/doctor",
  jobs: "/api/beetle/jobs", models: "/api/beetle/models", openai: "/api/v1/models",
  datasets: "/api/beetle/datasets", chainJobs: "/api/beetle/chain/jobs", host: "/native/host",
  market: () => `/api/beetle/market${floor() ? `?min_tier=${encodeURIComponent(floor())}` : ""}`,
};
const NEEDS = {
  overview: ["doctor", "wallet", "jobs", "market"], chat: ["openai", "wallet", "doctor"], train: ["jobs", "datasets", "doctor", "market"],
  models: ["models", "doctor", "jobs"], market: ["wallet", "market"], network: ["market", "chainJobs"],
  connect: ["agents", "openai", "info"], wallet: ["wallet"], host: ["host"], offer: ["host", "wallet", "doctor"],
};

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `The request failed (${status}).`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

async function call(path, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const reply = await fetch(path, options);
  const out = await reply.json().catch(() => null);
  if (!reply.ok) throw new ApiError(reply.status, out);
  return out;
}

async function refresh(...names) {
  await Promise.all(names.map(async name => {
    const source = SOURCES[name];
    try {
      data[name] = await call(typeof source === "function" ? source() : source);
      delete errors[name];
    } catch (e) {
      errors[name] = e;
    }
  }));
  syncShell();
  render();
}

const unpaid = j => j.stage === "delivered" && j.error?.code === "no_funds";  // waiting on this person, not on a seller
const floor = () => data.wallet?.limits?.min_tier ?? data.doctor?.policy?.min_tier;
const finished = j => j.stage === "settled" || j.stage === "failed";
const jobList = () => [...(data.jobs || [])].sort((a, b) => a.timeline[0].at - b.timeline[0].at);
const activeJob = () => jobList().reverse().find(j => !finished(j) && !j.next_job && !unpaid(j));
const provedJob = () => jobList().reverse().find(j => j.timeline.some(t => t.stage === "released"));

// A job needs this Mac awake, and the menu bar says what's going on.
function syncShell() {
  const job = activeJob(), on = !!job;
  if (on !== state.awake) {
    state.awake = on;
    call("/native/awake", { on }).catch(() => {});
  }
  const lines = [job ? `Training ${job.alias || job.base}: ${job.stage}` : "Nothing running"];
  if (data.wallet) lines.push(`Today ${cents(data.wallet.spending.used_today)}`);
  lines.push(data.host?.serving ? "Serving" : "Not serving");
  if (lines.join() !== state.tray) {
    state.tray = lines.join();
    call("/native/tray", { lines }).catch(() => {});
  }
}

// How this Mac is set up, or what the market holds today. Nothing here is broken.
const CALM = { local_only: "Local use only.", not_set_up: "Beetle isn't set up on this Mac yet.",
  not_installed: "Beetle isn't installed yet.", no_seller: "No seller right now.", no_funds: "Not enough funds.",
  no_route_meets_floor: "Nothing meets your privacy floor.", budget_exceeded: "Over your limit.",
  approval_required: "This needs your approval." };
const UNSET = ["local_only", "not_set_up", "not_installed"];
const noWallet = () => UNSET.includes(errors.wallet?.code);
const dash = () => noWallet() ? "–" : "…";
const said = e => {
  const text = String(e.message), parts = (text[0].toUpperCase() + text.slice(1)).split("`");
  return parts.map((part, i) => i % 2 ? h`<span class="mono">${part}</span>` : part);  // `command` in a message
};
const refusal = e => h`<p class="${CALM[e.code] ? "note" : "err"}">${said(e)}</p>`;

function problem(...names) {
  const e = names.map(n => errors[n]).find(Boolean);
  if (!e) return "";
  if (e.code === "local_only") return h`<div class="notice calm"><strong>${CALM.local_only}</strong><span>Models run on this Mac and nothing leaves it, so there's no wallet or market. To join a network, run <span class="mono">beetle init --chain chain.json --per-job 5 --per-day 10 --min-tier public</span>, then reopen Beetle.</span></div>`;
  return CALM[e.code] ? h`<div class="notice calm"><strong>${CALM[e.code]}</strong><span>${said(e)}</span></div>`
    : h`<div class="notice bad"><strong>Couldn't load this.</strong><span>${said(e)}</span></div>`;
}

const loading = () => h`<p class="note">Loading…</p>`;

function stat(label, value, note, text) {
  return h`<div class="stat"><span class="label">${label}</span>
    <span class="value ${text ? "text" : ""}">${value}</span><small>${note}</small></div>`;
}

function seg(name, options, current) {
  return h`<div class="seg" role="group">${options.map(([value, label]) =>
    h`<button data-seg="${name}" data-value="${value}" aria-pressed="${value === current}">${label}</button>`)}</div>`;
}

// A new seller starts clean, so it can win on price; each failed job costs it rank.
const record = o => (o.settled + 3) / (o.settled + o.failed + 3);
const priceOf = o => o.kind === "train" ? o.usd_per_mtok.train : o.usd_per_mtok.out;
const priceLine = o => o.kind === "train" ? `${usd(o.usd_per_mtok.train)} per Mtok` : `${usd(o.usd_per_mtok.in)} in, ${usd(o.usd_per_mtok.out)} out`;
const gpuOf = o => o.gpu ? `${o.gpu}, ${o.gpu_gb} GB` : `${o.gpu_gb} GB GPU`;
const readable = t => t === "T3-C" || t === "T3-B" || t === "MOCK";
const nobody = () => floor() && floor() !== "public" ? `No seller meets your privacy floor, ${floor()}.` : "No sellers are online right now.";

function ranked(kind) {
  const rows = (data.market || []).filter(o => o.kind === kind)
    .sort((a, b) => priceOf(a) / record(a) - priceOf(b) / record(b));
  return { rows, best: rows.find(o => o.slots_free > 0) };
}

// A label near either end of the ladder hangs inward, so it isn't cut off.
const edge = x => x < 0.1 ? "left" : x > 0.9 ? "right" : "";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function verdict() {
  const models = Object.entries(data.doctor?.models || {});
  const [name, path] = models.find(([, m]) => m.path !== "remote") || models.find(([, m]) => m.sellers?.train) || models[0] || [];
  if (!path) return null;
  if (errors.wallet?.code === "local_only") return { name, text: path.path === "remote" ? "No model can run here" : "Runs on this Mac", why: path.why };
  // `doctor` can say "local", but training on a Mac isn't wired in yet.
  return { name, text: path.path === "remote" ? "All remote" : "Train remotely, run here", why: path.why };
}

const STEPS = [["quoted", "Quote accepted"], ["escrowed", "Held in escrow"], ["connected", "Connected to the seller"],
  ["uploading", "Sealed inputs sent"], ["evidence", "Evidence checked here"], ["released", "Key released"],
  ["training", "Training on the seller"], ["delivered", "Model delivered"], ["verified", "Result checked"], ["settled", "Settled"]];

function timeline(job) {
  const seen = new Map(job.timeline.map(t => [t.stage, t]));
  const rows = STEPS.filter(([stage]) => !finished(job) || seen.has(stage)).map(([stage, label]) => {
    const t = seen.get(stage);
    const now = stage === job.stage && !finished(job);
    const name = stage === "evidence" && job.verdict?.type === "NONE" ? "No hardware evidence to check" : label;
    return h`<li class="${now ? "now" : t ? "done" : ""}"><span>${name}${now && t?.note ? h` <span class="dim">· ${t.note}</span>` : ""}</span>
      <time>${t ? clock(t.at) : ""}</time></li>`;
  });
  const failed = seen.get("failed");
  const next = { seller_pinned: "You chose this seller, so the job wasn't moved to another one.",
    approval_required: "The next seller costs more, so it needs your approval. Start the job again." }[job.next_error];
  if (unpaid(job)) return h`<ol class="timeline">${rows}</ol><p class="note">${said(job.error)}. The result is safe here. Add funds, then <button class="link" data-fetch="${job.job}">finish this job</button>.</p>`;
  return h`<ol class="timeline">${rows}${failed ? h`<li class="stopped"><span>Stopped <span class="dim">· ${failed.note}</span></span><time>${clock(failed.at)}</time></li>` : ""}</ol>${next ? h`<p class="note">${next}</p>` : ""}`;
}

function result(job) {
  const r = job.result;
  if (!r?.scores) return "";
  const e = r.effect || {};
  return h`<dl class="rows">
    <div><dt>Hidden test</dt><dd class="mono">${r.scores.before.toFixed(2)} → ${r.scores.after.toFixed(2)}</dd></div>
    ${e.asked ? h`<div><dt>Answers right</dt><dd class="mono">${e.base_correct}/${e.asked} → ${e.adapter_correct}/${e.asked}</dd></div>` : ""}
    ${r.paid_usd === undefined ? "" : h`<div><dt>Paid</dt><dd class="mono">${usd(r.paid_usd)}</dd></div>`}</dl>`;
}

function cancelButton(job) {
  // After the key is out a job can't be recalled.
  return job.timeline.some(t => t.stage === "released") ? "" : h`<button class="link" data-cancel="${job.job}">Cancel</button>`;
}

const baseOf = id => (data.openai?.data || []).find(m => m.id === id)?.base || id;
const runsHere = id => data.doctor?.models?.[baseOf(id)]?.path !== "remote";
const sellersOf = id => data.doctor?.models?.[baseOf(id)]?.sellers?.infer || 0;

// A model this Mac can't run goes straight to a seller, with the warning in view.
function chooseModel(id) {
  state.model = id;
  state.seller = null;
  if (!runsHere(id)) state.route = "remote";
}

const pages = {
  overview() {
    const w = data.wallet, v = verdict(), job = activeJob() || jobList().at(-1), sellers = new Set((data.market || []).map(o => o.seller)).size;
    const running = activeJob();
    const proof = state.lastProof || provedJob()?.job;
    if (proof && !data.proofs[proof]) loadProof(proof);
    return h`<div class="page">
      <div class="head"><div><h1>Overview</h1><p>What this Mac can do, what's running and what it has cost.</p></div></div>
      ${problem("doctor", "wallet", "jobs")}
      ${running ? h`<div class="notice"><strong>Training ${running.alias || running.base} on a seller.</strong> This Mac stays awake until the job is finished.</div>` : ""}
      <div class="stats">
        ${stat("This Mac", v?.text ?? dash(), v ? `${v.name}: ${v.why}` : "", true)}
        ${stat("Spent today", w ? cents(w.spending.used_today) : dash(), w ? `of ${usd(w.limits.per_day_usd, 0)} limit` : "")}
        ${stat("In escrow", w ? cents(w.spending.escrowed) : dash(), "held by the chain, not by a seller")}
        ${stat("Sellers online", data.market ? sellers : dash(), "price and tier in Market")}
      </div>
      <div class="split section">
        <div><span class="label">${running ? "Running" : "Latest job"}</span>
          ${job ? timeline(job) : h`<p class="note">No jobs yet. <button class="link" data-go="train">Train a model</button></p>`}</div>
        <div><span class="label">Latest proof</span>${proof ? proofSummary(proof) : h`<p class="note">A proof appears after your first job or remote chat.</p>`}</div>
      </div>
    </div>`;
  },

  chat() {
    const models = (data.openai?.data || []).filter(m => !data.doctor || runsHere(m.id) || sellersOf(m.id));
    if (!state.model && models.length) chooseModel((models.find(m => m.id === "me") || models[0]).id);
    const current = models.find(m => m.id === state.model), local = runsHere(state.model);
    if (!local && state.route !== "remote") state.route = "remote";
    const ready = !!state.model && (models.length > 0 || !!state.seller);
    const stuck = !!data.openai && !ready;  // loaded, and nothing can answer
    const warn = ready && { remote: "This seller's owner can read what you send. Use public or synthetic data only.",
      auto: "If this Mac can't answer, this message goes to a seller, whose owner can read it." }[state.route];
    const empty = stuck ? h`<div class="empty"><strong>Nothing can answer yet.</strong>
        <p class="note">${errors.wallet?.code === "local_only" ? "This Mac can't run a model, and it isn't on a network." : `This Mac can't run a model. ${nobody()}`}</p>
        <p><button class="btn small" data-go="market">Open Market</button></p></div>`
      : h`<div class="empty"><p class="note">Nothing here is saved. Closing the app clears this chat.</p></div>`;
    return h`<div class="chat">
      <div class="chatbar">
        ${models.length ? h`<select aria-label="Model" data-pick="model">${models.map(m => h`<option ${new Raw(m.id === state.model ? "selected" : "")}>${m.id}</option>`)}</select>` : ""}
        <span class="dim mono">${current?.base && current.base !== current.id ? `on ${current.base}` : ""}</span>
        ${state.seller ? h`<span class="dim mono">seller ${short(data.market?.find(o => o.offer === state.seller)?.seller || state.seller)} <button class="link" data-clear-seller>Any</button></span>` : ""}
        ${ready ? h`<div class="right">
          ${seg("route", local ? [["local", "This Mac"], ["auto", "Auto"], ["remote", "Seller"]] : [["remote", "Seller"]], state.route)}
          ${tier(state.route === "local" ? "T0" : "T3-C")}
        </div>` : ""}
      </div>
      <div class="thread" id="thread">${problem("openai")}${data.thread.length ? data.thread.map((m, i) => h`${i && m.ctx !== data.thread[i - 1].ctx ? h`<div class="break"><span class="note">New conversation. Earlier messages weren't sent.</span></div>` : ""}${message(m)}`) : empty}</div>
      <div class="composer"><form data-send>
        ${warn ? h`<p class="warn">${warn}</p>` : ""}
        <div class="box"><textarea rows="1" id="draft" placeholder="${ready ? `Message ${state.model}` : stuck || errors.openai ? "No model available" : "Loading models…"}" aria-label="Message" ${new Raw(ready ? "" : "disabled")}>${state.draft}</textarea>
        <button class="btn primary small" type="submit" ${new Raw(state.busy || !ready ? "disabled" : "")}>Send</button></div>
      </form></div>
    </div>`;
  },

  train() {
    const scenarios = [
      ["memory", "Teach it some facts", "Public or synthetic facts", "A model that knows them", true],
      ["rent", "Use a bigger model", "Nothing to prepare", "Chat with it now, on a seller's GPU", true],
      ["examples", "Learn from my examples", "Question and answer pairs", "A model tuned to your data", false],
      ["code", "Run my training code", "One Python file, your dataset", "Whatever your code trains", false],
    ];
    const job = activeJob() || jobList().at(-1);
    return h`<div class="page">
      <div class="head"><div><h1>Train</h1><p>Start from what you want. Sellers today can read what they train on, so use public or synthetic data.</p></div></div>
      ${problem("market", "jobs", "datasets")}
      <table><thead><tr><th>What you want</th><th>You provide</th><th>You get</th><th class="n"></th></tr></thead>
      <tbody>${scenarios.map(([id, name, give, get, ready]) => h`<tr class="${ready ? "row" : "off"}" ${new Raw(ready ? `data-scenario="${id}"` : "")}>
        <td>${name}</td><td class="sub">${give}</td><td class="sub">${get}</td>
        <td class="n">${ready ? h`<span class="chev">Start</span>` : h`<span class="tier plan">Planned</span>`}</td></tr>`)}</tbody></table>
      ${job ? h`<div class="section"><span class="label">${activeJob() ? "Running" : "Latest job"}</span>${timeline(job)}${result(job)}
        <p class="section">${!finished(job) ? cancelButton(job) : ""} ${job.timeline.some(t => t.stage === "released") ? h`<button class="link" data-proof="${job.job}">Open proof</button>` : ""}</p></div>` : ""}
    </div>`;
  },

  models() {
    const library = Object.entries(data.models || {}), doctor = data.doctor?.models || {};
    return h`<div class="page">
      <div class="head"><div><h1>Models</h1><p>Your adapters and the base models they run on.</p></div>
        <div class="actions"><button class="btn primary" data-scenario="memory">Train a model</button></div></div>
      ${problem("models", "doctor")}
      ${data.models ? h`<table><thead><tr><th>Name</th><th>Base</th><th>Runs on</th><th>Data</th>
        <th class="n">Hidden test</th><th class="n">Trained</th><th class="n">Version</th><th class="n"></th></tr></thead>
      <tbody>${library.map(([alias, e]) => {
        const v = e.versions[e.current];
        return h`<tr><td>${alias}</td><td class="sub">${v.base}</td>
          <td class="sub">${doctor[v.base]?.path === "remote" ? "Sellers" : "This Mac, sellers"}</td><td class="sub">${v.label}</td>
          <td class="n">${v.scores ? `${v.scores.before.toFixed(2)} → ${v.scores.after.toFixed(2)}` : "–"}</td>
          <td class="n dim">${when(v.at)}</td><td class="n">v${e.versions.length - e.current} of ${e.versions.length}</td>
          <td class="n"><button class="link" data-chat="${alias}">Chat</button>
            ${e.current < e.versions.length - 1 ? h` <button class="link" data-rollback="${alias}">Roll back</button>` : ""}</td></tr>`;
      })}</tbody></table>
      ${library.length ? "" : h`<p class="note section">No models yet.</p>`}` : loading()}
      <div class="section"><span class="label">Base models</span>
      <table><thead><tr><th>Name</th><th>On this Mac</th><th class="n">Train sellers</th><th class="n">Chat sellers</th></tr></thead>
      <tbody>${Object.entries(doctor).map(([name, m]) => h`<tr><td>${name}</td><td class="sub">${m.path === "remote" ? "Sellers only" : "Runs here"}</td>
        <td class="n">${m.sellers?.train ?? "–"}</td><td class="n">${m.sellers?.infer ?? "–"}</td></tr>`)}</tbody></table></div>
    </div>`;
  },

  market() {
    const head = h`<div class="head"><div><h1>Market</h1><p>Sellers post prices on chain. You choose, or take the recommendation.</p></div>
      <div class="actions">${seg("kind", [["train", "Training"], ["infer", "Inference"]], state.kind)}</div></div>`;
    if (!data.market) return h`<div class="page">${head}${problem("market")}${errors.market ? "" : loading()}</div>`;
    const { rows, best } = ranked(state.kind);
    if (!rows.length) return h`<div class="page">${head}<p class="note">${nobody()}</p></div>`;
    const shown = state.all ? rows : rows.slice(0, 4);
    const unit = state.kind === "train" ? "per Mtok trained" : "per Mtok out";
    const prices = rows.map(priceOf), low = Math.min(...prices), high = Math.max(...prices), mid = median(prices);
    const at = price => (price - low) / (high - low || 1);
    return h`<div class="page">${head}${problem("market")}
      ${best ? h`<div class="pick">
        <div class="who"><strong>Recommended: <span class="mono">${short(best.seller)}</span></strong> ${tier(best.tier)}
          <p>Best price for its record: ${best.settled} settled, ${best.failed} failed, ${usd(best.stake_usd, 0)} staked.</p>
          ${readable(best.tier) ? h`<p class="warn">Its owner can read what you send.</p>` : ""}</div>
        <div class="price">${usd(priceOf(best))}<small>${unit}</small></div>
        <button class="btn primary" data-use="${best.offer}">${state.kind === "train" ? "Use this seller" : "Chat with this seller"}</button>
      </div>` : ""}
      ${high > low ? h`<div class="ladder" role="img" aria-label="Prices from ${usd(low)} to ${usd(high)}, median ${usd(mid)}">
        ${rows.map(o => h`<i class="tick ${o === best ? "best" : ""}" data-x="${at(priceOf(o))}"></i>`)}
        ${best ? h`<span class="tag best ${edge(at(priceOf(best)))}" data-x="${at(priceOf(best))}">${usd(priceOf(best))}</span>` : ""}
        ${rows.length > 2 ? h`<i class="cap" data-x="${at(mid)}"></i><span class="tag ${edge(at(mid))}" data-x="${at(mid)}">median ${usd(mid)}</span>` : ""}
        <span class="axis">${usd(low)}</span><span class="axis end">${usd(high)}</span>
      </div>` : ""}
      <div class="section">
      <table><thead><tr><th>#</th><th>Seller</th><th>Model</th><th>Tier</th><th class="n">Price</th><th class="n">Settled</th><th class="n">Failed</th><th class="n">Slots</th></tr></thead>
      <tbody>${shown.map((o, i) => offerRow(o, i, best))}</tbody></table>
      <p class="note section">Ranked by price, adjusted for failed jobs. Tier is what the seller claims; evidence decides before any key is released.
        ${rows.length > 4 ? h`<button class="link" data-all>${state.all ? "Show fewer" : `Show all ${rows.length} offers`}</button>` : ""}</p>
      </div>
    </div>`;
  },

  network() {
    const offers = data.market || [], ids = [...new Set(offers.map(o => o.seller))];
    const sellers = ids.map(id => offers.find(o => o.seller === id));
    const settled = sellers.reduce((n, o) => n + o.settled, 0), stake = sellers.reduce((n, o) => n + o.stake_usd, 0);
    const open = data.chainJobs;
    const head = h`<div class="head"><div><h1>Network</h1><p>This Mac connects to sellers directly. Prices, stake and settlement sit on Solana; prompts, data and weights never do.</p></div></div>`;
    if (UNSET.includes(errors.market?.code)) return h`<div class="page">${head}${problem("market")}</div>`;
    return h`<div class="page">${head}
      ${problem("market", "chainJobs")}
      ${sellers.length ? networkMap(ids, offers) : ""}
      <div class="stats">
        ${stat("Sellers", sellers.length, `${offers.length} offers`)}
        ${stat("Staked", usd(stake, 0), "held by the program")}
        ${stat("Jobs settled", settled, "across these sellers")}
        ${stat("Open jobs", open ? open.length : "…", "right now")}
      </div>
      <div class="section"><span class="label">Sellers</span>
      ${sellers.length ? h`<table class="sellers"><thead><tr><th>Seller</th><th>GPU</th><th>Sells</th><th>Tier</th><th class="n">Price</th><th class="n">Stake</th><th class="n">Settled</th><th class="n">Failed</th></tr></thead>
      <tbody>${ids.map(id => offers.filter(o => o.seller === id).map((o, i, mine) => h`<tr>
        ${i ? "" : h`<td class="mono" rowspan="${mine.length}">${short(o.seller)}${copy(o.seller)}</td><td class="sub" rowspan="${mine.length}">${gpuOf(o)}</td>`}
        <td>${o.kind === "train" ? "Train" : "Chat"} <span class="sub">${o.model}</span></td><td>${tier(o.tier)}</td><td class="n">${priceLine(o)}</td>
        ${i ? "" : h`<td class="n" rowspan="${mine.length}">${usd(o.stake_usd, 0)}</td><td class="n" rowspan="${mine.length}">${o.settled}</td><td class="n" rowspan="${mine.length}">${o.failed}</td>`}</tr>`))}</tbody></table>
      <p class="note section">GPU model and memory are what each seller reports. Nothing checks them yet.</p>` : data.market ? h`<p class="note">${nobody()}</p>` : loading()}</div>
      <div class="section"><span class="label">Open jobs</span>
      ${open?.length ? h`<table><thead><tr><th>Job</th><th>Buyer</th><th>Seller</th><th>State</th><th class="n">Escrow</th></tr></thead>
      <tbody>${open.map(j => h`<tr><td class="mono">${j.job.slice(0, 8)}${copy(j.job)}</td><td class="mono sub">${short(j.buyer)}${copy(j.buyer)}</td><td class="mono sub">${short(j.seller)}${copy(j.seller)}</td>
        <td class="sub">${j.state}</td><td class="n">${usd(j.usd)}</td></tr>`)}</tbody></table>` : h`<p class="note">${open ? "No open jobs right now. A job leaves this list when it settles." : "Loading…"}</p>`}
      <p class="note section">Buyers and sellers appear as wallet addresses, not names. An address is permanent, and anyone can read it.</p></div>
    </div>`;
  },

  connect() {
    const agents = data.agents?.agents, models = (data.openai?.data || []).map(m => m.id).join(", ");
    return h`<div class="page narrow">
      <div class="head"><div><h1>Connect</h1><p>Let your agents use your models, inside the limits you set.</p></div></div>
      ${problem("agents")}
      <div class="section"><span class="label">Agents</span>
      ${agents ? h`<table><tbody>${agents.map(a => h`<tr>
        <td>${a.title}</td><td class="sub">MCP server</td>
        <td class="sub">${!a.installed ? "Not installed" : state.agentBusy === a.id ? "Working…" : a.connected ? "Connected" : "Not connected"}</td>
        <td class="n">${a.installed ? h`<button class="btn small" data-agent="${a.id}" data-to="${a.connected ? "disconnect" : "connect"}">${a.connected ? "Disconnect" : "Connect"}</button>` : ""}</td></tr>`)}</tbody></table>` : loading()}
      ${state.agentError ? h`<p class="note">${state.agentError}</p>` : ""}
      </div>
      <div class="split section">
        <div><span class="label">An agent can</span>
          <ul class="checks plain">${["Chat with your models, here or on a seller", "Call sellers with your wallet, within your limits", "Quote and start training jobs", "Read status and proofs"].map(t => h`<li class="ok"><i></i><span>${t}</span></li>`)}</ul></div>
        <div><span class="label">An agent can't</span>
          <ul class="checks plain">${["Raise a limit or lower a floor", "Change a dataset's label", "Read your wallet key", "Read your adapter weights"].map(t => h`<li class="bad"><i></i><span>${t}</span></li>`)}</ul></div>
      </div>
      <p class="warn section">A seller's owner can read what an agent sends it at tier T3-C.</p>
      <div class="section"><span class="label">For developers</span>
        <p class="note">Tools that speak the OpenAI API can use your models through this address, with a key from <span class="mono">beetle token NAME</span>. It runs on this Mac and isn't reachable from the internet.</p>
        <div class="field"><span>Base URL</span><span class="value"><span class="num">${data.info?.api ? `${data.info.api}/v1` : ""}</span>${data.info?.api ? copy(`${data.info.api}/v1`) : ""}</span></div>
        <div class="field"><span>Models</span><span class="value"><span class="num">${models}</span></span></div>
      </div>
    </div>`;
  },

  wallet() {
    const w = data.wallet;
    if (!w) return h`<div class="page"><div class="head"><div><h1>Wallet</h1></div></div>${problem("wallet")}${errors.wallet ? "" : loading()}</div>`;
    const live = data.info?.network === "mainnet";
    const entries = Object.entries(w.entries).sort(([, a], [, b]) => b.at - a.at);
    return h`<div class="page">
      <div class="head"><div><h1>Wallet</h1><p>${live ? "Real money on Solana mainnet." : `Test tokens on ${data.info?.network ?? "a test network"}. They have no value.`}</p></div></div>
      ${problem("wallet")}
      <div class="stats">
        ${stat("Balance", usd(w.usdc), `USDC, plus ${w.sol.toFixed(2)} SOL for fees`)}
        ${stat("Reserved", cents(w.spending.reserved), "set aside for open sessions")}
        ${stat("In escrow", cents(w.spending.escrowed), "held by the chain")}
        ${stat("Settled", cents(w.spending.settled), "all time")}
      </div>
      <div class="section"><span class="label">Limits</span>
        <div class="field"><span>Address</span><span class="value"><span class="num">${w.address}</span>${copy(w.address)}</span></div>
        <div class="field"><span>Per job</span><span class="num">${usd(w.limits.per_job_usd)}</span></div>
        <div class="field"><span>Per day</span><span class="num">${cents(w.spending.used_today)} of ${usd(w.limits.per_day_usd)}</span></div>
        <div class="field"><span>No approval under</span><span class="num">${usd(w.limits.auto_approve_under_usd)}</span></div>
        <div class="field"><span>Privacy floor</span><span class="num">${w.limits.min_tier}</span></div>
        <p class="note">Limits change only from the command line: <span class="mono">beetle policy set</span>.</p>
      </div>
      <div class="section"><span class="label">Activity</span>
      ${entries.length ? h`<table><thead><tr><th>What</th><th>Reference</th><th>State</th><th class="n">Amount</th><th class="n">Time</th></tr></thead>
      <tbody>${entries.slice(0, 30).map(([key, e]) => h`<tr><td>${e.kind === "train" ? "Training" : "Inference session"}</td><td class="mono sub">${key.replace(/^(job|channel)-/, "").slice(0, 8)}</td><td class="sub">${e.state}</td>
        <td class="n">${cents(e.usd)}</td><td class="n dim">${when(e.at)}</td></tr>`)}</tbody></table>` : h`<p class="note">Nothing yet.</p>`}
      </div>
    </div>`;
  },

  host() {
    const H = data.host, status = H?.status, offers = status?.offers || [], listed = offers.length > 0;
    if (!H) return h`<div class="page"><div class="head"><div><h1>Status</h1></div></div>${problem("host")}${errors.host ? "" : loading()}</div>`;
    const stake = status?.stake;
    return h`<div class="page">
      <div class="head"><div><h1>Status</h1><p>Sell inference from this Mac while you aren't using it.</p></div>
        <div class="actions">${listed ? h`<button class="switch" role="switch" aria-checked="${H.serving}" data-serve="${!H.serving}" ${new Raw(state.hostBusy ? "disabled" : "")}>
          <span>${state.hostBusy ? "Working…" : H.serving ? "Serving" : "Not serving"}</span><i></i></button>` : h`<button class="btn primary" data-go="offer">Set up an offer</button>`}</div></div>
      ${state.hostError ? h`<div class="notice bad"><strong>That didn't work.</strong> ${state.hostError}</div>` : ""}
      <div class="notice bad"><strong>Buyers get no hardware protection here.</strong> You can read what they send, and the market says so.</div>
      <div class="stats">
        ${stat("Earned", usd(stake?.volume), "settled on chain only")}
        ${stat("Jobs settled", stake?.settled_jobs ?? 0, `${stake?.failed ?? 0} failed`)}
        ${stat("Stake", usd(stake?.total), stake ? `${usd(stake.locked)} locked` : "not staked yet")}
      </div>
      <div class="section"><span class="label">Your offers</span>
      ${listed ? h`<table><thead><tr><th>Model</th><th>Kind</th><th>State</th><th class="n">Input</th><th class="n">Output</th><th class="n">Slots</th></tr></thead>
      <tbody>${offers.map(o => h`<tr><td>${o.model}</td><td class="sub">${o.kind}</td><td class="sub">${o.status}</td>
        <td class="n">${usd(o.price_a)}</td><td class="n">${usd(o.price_b)}</td><td class="n">${o.slots}</td></tr>`)}</tbody></table>` : h`<p class="note">Nothing listed yet.</p>`}</div>
      <p class="note section">Earnings show money already settled. Beetle doesn't estimate future income.</p>
    </div>`;
  },

  offer() {
    const w = data.wallet, m = data.doctor?.machine, s = state.hostForm, net = data.doctor?.network;
    const STAKE = 20;
    const checks = !w || !m ? [] : [
      [w.sol > 0.01 ? "ok" : "bad", "Fees", `${w.sol.toFixed(2)} SOL`],
      [w.usdc >= STAKE ? "ok" : "bad", "Stake", `${usd(w.usdc)} USDC, ${usd(STAKE, 0)} needed`],
      [m.local_engine === "mlx" ? "ok" : "bad", "Local engine", m.local_engine === "mlx" ? "mlx-lm" : "Not found"],
      [m.memory_gb >= 16 ? "ok" : "warn", "Memory", `${m.memory_gb} GB, ${m.free_gb} GB free`],
      [net?.nat === "blocked" ? "bad" : "ok", "Network", NETWORK[net?.nat] ?? net?.nat ?? "unknown"],
      [m.on_power ? "ok" : "warn", "Power", m.on_power ? "On mains power" : "On battery"],
      [m.disk_gb >= 5 ? "ok" : "warn", "Disk", `${m.disk_gb} GB free`],
    ];
    const blocked = !checks.length || checks.some(([tone]) => tone === "bad");
    return h`<div class="page">
      <div class="head"><div><h1>Setup</h1><p>Check this Mac and set what you sell.</p></div></div>
      ${problem("doctor", "wallet")}
      ${state.hostError ? h`<div class="notice bad"><strong>That didn't work.</strong> ${state.hostError}</div>` : ""}
      <div class="split">
        <div><span class="label">This Mac</span>
          ${checks.length ? h`<ul class="checks">${checks.map(([tone, name, text]) => h`<li class="${tone}"><i></i><span>${name}</span><span>${text}</span></li>`)}</ul>` : errors.wallet ? "" : loading()}
        </div>
        <div><span class="label">What you sell</span>
          <label class="field"><span>Model</span><select data-host="model"><option>qwen3.5-2b</option></select></label>
          <label class="field"><span>Input, per Mtok</span><input class="num" data-host="in" value="${s.in}"></label>
          <label class="field"><span>Output, per Mtok</span><input class="num" data-host="out" value="${s.out}"></label>
          <label class="field"><span>Requests at once</span><input class="num" data-host="slots" value="${s.slots}"></label>
          <p class="note">Inference only. Training isn't available on a Mac yet.</p>
        </div>
      </div>
      <div class="foot"><button class="btn primary" data-list ${new Raw(blocked || state.hostBusy ? "disabled" : "")}>${state.hostBusy ? "Listing…" : `Stake ${usd(STAKE, 0)} and list`}</button>
        <span class="note">Posts your offer on chain. The stake stays locked while you're listed.</span></div>
    </div>`;
  },
};

function message(m) {
  const line = m.meta ? `${m.meta.route} · ${m.meta.tier}${m.meta.cost !== undefined ? ` · ${cents(m.meta.cost)}` : ""}` : "";
  return h`<div>
    <span class="who label">${m.who === "you" ? "You" : m.who}</span>
    <p class="msg" ${new Raw(m.live ? 'id="live"' : "")}>${m.text}</p>
    ${m.live && !m.text ? h`<p class="meta">${m.waiting}</p>` : ""}
    ${m.error ? h`<p class="meta ${CALM[m.error.code] ? "" : "err"}">${said(m.error)}</p>` : ""}
    ${line ? h`<p class="meta">${line}${m.meta.proof ? h` · <button data-proof="${m.meta.proof}">proof</button>` : ""}${!m.live && m.text ? copy(m.text) : ""}</p>` : ""}
  </div>`;
}

// This Mac, its direct links to sellers, and the chain underneath all of them.
function networkMap(ids, offers) {
  const ROW = 64, BOX = 50, RIGHT = 560, W = 920, top = Math.max(ids.length * ROW, 110), H = top + 44;
  const mid = top / 2 - 7, busy = offers.find(o => o.offer === activeJob()?.offer)?.seller;
  const rows = ids.map((id, i) => {
    const mine = offers.filter(o => o.seller === id), y = i * ROW + (top - ids.length * ROW) / 2;
    const models = [...new Set(mine.map(o => o.model))].join(", ");
    return h`<path class="link ${id === busy ? "live" : ""}" d="M170 ${mid} C 320 ${mid}, 400 ${y + BOX / 2}, ${RIGHT} ${y + BOX / 2}"/>
      <path class="tie" d="M${RIGHT + 180} ${y + BOX} V${top + 16}"/>
      <rect class="node" x="${RIGHT}" y="${y}" width="${W - RIGHT - 1}" height="${BOX}" rx="3"/>
      <text class="name" x="${RIGHT + 14}" y="${y + 21}">${short(id)}</text>
      <text class="sub" x="${W - 15}" y="${y + 21}" text-anchor="end">${gpuOf(mine[0])}</text>
      <text class="sub" x="${RIGHT + 14}" y="${y + 38}">${models}</text>`;
  });
  return h`<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="This Mac is connected to ${ids.length} sellers">
    <path class="tie" d="M85 ${mid + 25} V${top + 16}"/>
    ${rows}
    <rect class="node me" x="1" y="${mid - 25}" width="169" height="50" rx="3"/>
    <text class="name" x="15" y="${mid - 4}">This Mac</text>
    <text class="sub" x="15" y="${mid + 13}">direct, no relay</text>
    <path class="chain" d="M1 ${top + 16} H${W - 1}"/>
    <text class="sub" x="1" y="${top + 36}">Solana ${data.info?.network ?? ""}: prices, stake, settlement</text>
  </svg>`;
}

function offerRow(o, i, best) {
  const open = state.open === o.offer;
  const row = h`<tr class="row ${o === best ? "best" : ""}" data-offer="${o.offer}">
    <td class="dim mono">${i + 1}</td><td class="mono">${short(o.seller)}</td><td class="sub">${o.model}</td><td>${tier(o.tier)}</td>
    <td class="n">${usd(priceOf(o))}</td><td class="n">${o.settled}</td><td class="n ${o.failed ? "" : "dim"}">${o.failed}</td><td class="n">${o.slots_free}</td></tr>`;
  if (!open) return row;
  return h`${row}<tr class="detail"><td colspan="8"><dl class="facts">
    <div><dt>Seller</dt><dd>${short(o.seller)}${copy(o.seller)}</dd></div><div><dt>Stake</dt><dd>${usd(o.stake_usd, 0)}</dd></div><div><dt>GPU</dt><dd>${gpuOf(o)}</dd></div>
    <div><dt>On their machine</dt><dd>${o.evidence_needed ? "Decided by evidence before any key is released" : o.on_their_machine}</dd></div>
    <div><dt>Inbound UDP</dt><dd>${o.public_udp ? "open" : "closed"}</dd></div><div><dt>Last seen</dt><dd>${when(o.updated_at)}</dd></div>
  </dl><p class="foot"><button class="btn small" data-use="${o.offer}">${o.kind === "train" ? "Use this seller" : "Chat with this seller"}</button></p></td></tr>`;
}

async function loadProof(id) {
  data.proofs[id] ??= { loading: true };
  try {
    data.proofs[id] = await call(`/api/beetle/proof/${encodeURIComponent(id)}`);
  } catch (e) {
    data.proofs[id] = { failed: e.message };
  }
  render();
}

function lamps(p) {
  const tone = v => v === "encrypted" || v === "hardware isolated" ? "ok" : v === "not involved" ? "" : "bad";
  return h`<div class="lamps">
    <div class="lamp ${tone(p.on_the_way)}"><span class="label">On the way</span><b>${p.on_the_way}</b></div>
    <div class="lamp ${tone(p.on_their_machine)}"><span class="label">On their machine</span><b>${p.on_their_machine}</b></div>
  </div>`;
}

function proofSummary(id) {
  const p = data.proofs[id];
  if (!p || p.loading) return loading();
  if (p.failed) return h`<p class="note">${p.failed}</p>`;
  return h`<div><p class="lead">${tier(p.tier)} ${p.headline}</p>${lamps(p)}<p class="section"><button class="link" data-proof="${id}">Open proof</button></p></div>`;
}

function detailRows(group) {
  return Object.entries(group || {}).filter(([, v]) => typeof v !== "object").map(([k, v]) =>
    h`<div><dt>${k.replaceAll("_", " ")}</dt><dd class="mono">${v}${String(v).length > 16 ? copy(v) : ""}</dd></div>`);
}

const seconds = s => s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
const longHash = v => h`<dd class="mono">${v.slice(0, 10)}…${v.slice(-6)}${copy(v)}</dd>`;
const TX_NAMES = [["escrow", "Escrow tx"], ["key_release", "Key release tx"], ["settlement", "Settlement tx"]];

function evaluation(e) {
  if (!e || e.passed === undefined || e.passed === null) return "Not finished";
  const parts = [e.passed ? "Passed" : "Did not pass"];
  if (e.before !== null && e.before !== undefined) parts.push(`hidden test ${e.before.toFixed(2)} → ${e.after.toFixed(2)}`);
  if (e.asked) parts.push(`answers ${e.base_correct}/${e.asked} → ${e.adapter_correct}/${e.asked}`);
  return parts.join(", ");
}

function receipt(r, proved) {
  if (!r) return "";
  const gpu = r.gpu?.name ? `${r.gpu.name}, ${r.gpu.memory_gb} GB, as the seller reports` : "Not recorded for this job";
  const row = (name, value) => h`<div><dt>${name}</dt><dd>${value}</dd></div>`;
  const hashed = (name, value) => value ? h`<div><dt>${name}</dt>${longHash(value)}</div>` : "";
  const txs = TX_NAMES.filter(([key]) => r.transactions?.[key]);
  return h`<div class="section"><span class="label">Job record</span>
    ${proved ? "" : h`<p class="note">The GPU and model here are what was reported and ordered. At this tier nothing proves they ran.</p>`}
    <dl class="rows">
    ${row("GPU", gpu)}${row("Model", r.model)}${hashed("Revision", r.model_revision)}${hashed("Model hash", r.model_hash)}
    ${hashed("Dataset hash", r.dataset_hash)}${hashed("Job ID", r.job_id)}${hashed("Channel", r.channel)}
    ${r.duration_s !== undefined && r.duration_s !== null ? row("Duration", seconds(r.duration_s)) : ""}
    ${"evaluation" in r ? row("Evaluation", evaluation(r.evaluation)) : ""}
    ${r.cost_usd !== null && r.cost_usd !== undefined ? row("Cost", `${usd(r.cost_usd)} paid`) : r.held_usd ? row("Cost", `${usd(r.held_usd)} held in escrow`) : ""}
    ${row("Settlement", r.settlement)}
    ${txs.map(([key, name]) => hashed(name, r.transactions[key]))}
    ${r.transactions && !txs.length ? row("Transactions", "Not recorded for this job") : ""}
  </dl></div>`;
}

function proofCard(id) {
  const p = data.proofs[id];
  const close = h`<button class="close" data-close>Close</button>`;
  if (!p || p.loading) return h`${close}${loading()}`;
  if (p.failed) return h`${close}<p class="note">${p.failed}</p>`;
  const bad = TIER_TONE[p.tier] === "bad" || p.color === "red";
  return h`${close}<div class="cert">
    <div class="top"><span class="label">Proof</span><svg aria-hidden="true"><use href="#mark"/></svg></div>
    <h2 class="${bad ? "bad" : ""}">${p.headline}</h2><p>${p.detail}</p>
    ${lamps(p)}
    <dl class="rows">
      <div><dt>Tier</dt><dd>${p.tier}</dd></div>
      <div><dt>Path</dt><dd>${p.path}</dd></div>
      ${detailRows(p.peer)}${detailRows(p.evidence)}${detailRows(p.bindings)}
    </dl>
    ${receipt(p.receipt, !readable(p.tier))}
    ${p.known_weaknesses?.length ? h`<div class="section"><span class="label">Known weaknesses</span><ul>${p.known_weaknesses.map(w => h`<li>${w}</li>`)}</ul></div>` : ""}
  </div>`;
}

async function openTrain(seller) {
  const s = { dataset: "", base: "", alias: "me", max: "2.00", seller: seller || null, quote: null, error: null, busy: false };
  state.sheet = s;
  state.drawer = trainSheet;
  render(true);
  if (!data.datasets || !data.doctor) await refresh("datasets", "doctor");
  if (state.sheet !== s) return;
  s.dataset = Object.keys(data.datasets || {})[0] || "";
  s.base = Object.entries(data.doctor?.models || {}).find(([, m]) => m.sellers?.train)?.[0] || "";
  if (s.dataset && s.base) quote();
  else {
    s.error = errors.doctor || errors.datasets || (UNSET.includes(errors.wallet?.code) ? errors.wallet : null)
      || (s.dataset ? { code: "no_seller", message: "no one is selling training right now" } : null);
    render(true);
  }
}

async function quote() {
  const s = state.sheet;
  s.quote = null;
  s.error = null;
  render(true);
  if (!s.dataset || !s.base) return;
  try {
    s.quote = await call("/api/beetle/quote", { dataset: s.dataset, base: s.base, min_tier: floor(), seller: s.seller || undefined });
  } catch (e) {
    s.error = e;
  }
  render(true);
}

async function startTraining() {
  const s = state.sheet;
  s.busy = true;
  s.error = null;
  render(true);
  try {
    await call("/api/beetle/jobs", { dataset: s.dataset, base: s.base, alias: s.alias, min_tier: floor(), max_usd: Number(s.max),
      seller: s.seller || undefined, idempotency_key: randomKey(), approved: true });
    state.drawer = null;
    state.sheet = null;
    go("train");
  } catch (e) {
    s.busy = false;
    s.error = e;
    render(true);
  }
}

function trainSheet() {
  const s = state.sheet, q = s.quote;
  const close = h`<button class="close" data-close>Close</button>`;
  const names = Object.entries(data.datasets || {});
  const bases = Object.entries(data.doctor?.models || {}).filter(([, m]) => m.sellers?.train);
  const over = q && q.usd > Number(s.max);
  const seller = q && (data.market || []).find(o => o.offer === q.offer);
  return h`${close}<div class="cert">
    <div class="top"><span class="label">New training job</span></div>
    <h2>Train a model</h2><p>Your data is encrypted here before it leaves. An ordinary seller's owner can still read it, so only public or synthetic data can go to one.</p>
    <label class="field"><span>Dataset</span><select data-bind="dataset">${names.map(([n, d]) => h`<option value="${n}" ${new Raw(n === s.dataset ? "selected" : "")}>${n} (${d.label}, ${d.records} records)</option>`)}</select></label>
    <label class="field"><span>Base model</span><select data-bind="base">${bases.map(([n]) => h`<option ${new Raw(n === s.base ? "selected" : "")}>${n}</option>`)}</select></label>
    <label class="field"><span>Name</span><input data-bind="alias" value="${s.alias}"></label>
    <label class="field"><span>Spend limit</span><input class="num" data-bind="max" value="${s.max}"></label>
    ${names.length ? "" : h`<p class="note">No datasets yet. Add one with <span class="mono">beetle data add</span>.</p>`}
    ${s.error && !q ? refusal(s.error) : ""}
    ${q ? h`<dl class="rows">
      <div><dt>Seller</dt><dd class="mono">${short(seller?.seller || q.offer)} ${tier(q.tier)}</dd></div>
      ${seller ? h`<div><dt>GPU</dt><dd>${gpuOf(seller)}</dd></div>` : ""}
      <div><dt>Price</dt><dd class="mono">${usd(q.usd, 4)}</dd></div>
      <div><dt>Sellers online</dt><dd class="mono">${q.sellers_online}</dd></div>
      <div><dt>When it passes</dt><dd>The seller is paid once the model passes the check here.</dd></div>
      <div><dt>If it fails</dt><dd>Refunded by the chain's rules. A failed connection can cost $0.01.</dd></div>
      <div><dt>Stay online</dt><dd>Keep this Mac on until the key is released.</dd></div>
    </dl>
    ${over ? h`<p class="err">The price is over your spend limit.</p>` : ""}
    ${readable(q.tier) ? h`<p class="warn section">This seller's owner can read your data and the trained model. Use public or synthetic data only.</p>` : ""}
    ${s.error ? refusal(s.error) : ""}
    <p class="section"><button class="btn primary" data-start ${new Raw(s.busy || over ? "disabled" : "")}>${s.busy ? "Starting…" : `Hold ${usd(q.usd, 2)} in escrow and start`}</button></p>` : s.error || !names.length ? "" : h`<p class="note section">Getting a price…</p>`}
  </div>`;
}

async function send(text) {
  const reply = { who: state.model, text: "", live: true,
    waiting: state.route === "local" ? "Loading the model…" : "Connecting to a seller. The first reply can take a minute." };
  // What was said on another route stays there: a local chat must never reach a seller.
  const ctx = `${state.route}|${state.model}|${state.seller || ""}`;
  reply.ctx = ctx;
  const history = data.thread.filter(m => m.ctx === ctx && m.text && !m.error).slice(-12)
    .map(m => ({ role: m.who === "you" ? "user" : "assistant", content: m.text }));
  data.thread.push({ who: "you", text, ctx }, reply);
  state.draft = "";
  state.busy = true;
  render(true);
  try {
    const response = await fetch("/api/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: state.model, stream: true, messages: [...history, { role: "user", content: text }],
        beetle: { route: state.route, min_tier: floor(), max_usd: INFER_CAP_USD, seller: state.seller || undefined } }),
    });
    if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
    const get = name => response.headers.get(name);
    reply.meta = { route: get("x-beetle-route") === "local" ? "This Mac" : "Seller", tier: get("x-beetle-tier"), proof: get("x-beetle-proof") };
    if (reply.meta.proof) state.lastProof = reply.meta.proof;
    let complete = false, held = "";
    const decoder = new TextDecoder(), reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      held += decoder.decode(value, { stream: true });
      const events = held.split("\n\n");
      held = events.pop();
      for (const event of events) {
        const line = event.replace(/^data: /, "");
        if (line === "[DONE]") { complete = true; continue; }
        const chunk = JSON.parse(line);
        if (chunk.beetle) reply.meta.cost = chunk.beetle.cost_usd;
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) showPiece(reply, piece);
      }
    }
    if (!complete) reply.error = { message: "The answer stopped early." };
  } catch (e) {
    reply.error = e;
  }
  reply.live = false;
  state.busy = false;
  refresh("wallet");
  render(true);
}

function showPiece(reply, piece) {
  const first = !reply.text;
  reply.text += piece;
  const live = document.getElementById("live");
  if (first || !live) return render(true);
  live.textContent = reply.text;
  const thread = document.getElementById("thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

const go2 = id => h`<button data-go="${id}" ${new Raw(id === state.page ? 'aria-current="page"' : "")}>${TITLES[id]}</button>`;

function rail() {
  const w = data.wallet;
  return h`<div class="brand"><svg aria-hidden="true"><use href="#mark"/></svg><span>Beetle Desktop</span></div>
    <div class="modes" role="group" aria-label="Mode">
      <button data-mode="use" aria-pressed="${state.mode === "use"}">Use</button>
      <button data-mode="host" aria-pressed="${state.mode === "host"}">Host</button></div>
    ${NAV[state.mode].map(ids => h`<nav class="nav">${ids.map(go2)}</nav>`)}
    <button class="purse" data-go="wallet"><span class="figure">${w ? usd(w.usdc) : errors.wallet?.code === "local_only" ? "Local only" : noWallet() ? "Not set up" : "…"}</span><small>${noWallet() ? "No wallet" : data.info?.network === "mainnet" ? "USDC" : "USDC, test tokens"}</small></button>`;
}

function renderChrome() {
  const w = data.wallet, nat = data.doctor?.network?.nat;
  document.getElementById("rail").innerHTML = esc(rail());
  const themes = ["Auto", "Light", "Dark"], theme = window.beetleTheme.get();
  document.getElementById("status").innerHTML = esc(h`
    <span>Chain <b>${noWallet() ? "none" : data.info?.network ?? "…"}</b></span>
    <span title="${data.doctor?.network?.advice ?? ""}">Network <b>${NETWORK[nat] ?? nat ?? dash()}</b></span>
    <span>Privacy floor <b>${floor() ?? dash()}</b></span>
    <span>Today <b>${w ? cents(w.spending.used_today) : dash()}</b></span>
    <span>Serving <b>${data.host?.serving ? "on" : "off"}</b></span>
    <span class="right"><span class="theme" role="group" aria-label="Appearance">${themes.map(t =>
      h`<button data-theme-pick="${t.toLowerCase()}" aria-pressed="${t.toLowerCase() === theme}">${t}</button>`)}</span></span>`);
}

function render(force) {
  renderChrome();
  // A poll mustn't take the text someone is typing.
  if (!force && document.activeElement?.matches("input, textarea, select")) return;
  const page = pages[state.page] || pages.overview;
  document.getElementById("main").innerHTML = esc(page());
  document.querySelectorAll("[data-x]").forEach(e => { e.style.left = `${e.dataset.x * 100}%`; });
  const thread = document.getElementById("thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
  const drawer = document.getElementById("drawer");
  drawer.hidden = !state.drawer;
  if (state.drawer) drawer.innerHTML = esc(state.drawer());
}

function go(page) {
  state.page = page;
  state.drawer = null;
  if (HOST_PAGES.includes(page)) state.mode = "host";
  if (location.hash.slice(1) !== page) location.hash = page;
  render(true);
  refresh(...(NEEDS[page] || []));
}

document.addEventListener("click", async e => {
  const t = e.target.closest("button, tr[data-offer], tr[data-scenario]");
  if (!t) return;
  const d = t.dataset;
  if ("copy" in d) {
    await call("/native/copy", { text: d.copy }).catch(() => {});
    t.classList.add("done");
    t.querySelector("use").setAttribute("href", "#check");
    setTimeout(() => { t.classList.remove("done"); t.querySelector("use").setAttribute("href", "#copy"); }, 1200);
  }
  else if (d.themePick) { window.beetleTheme.set(d.themePick); render(); }
  else if (d.mode) { state.mode = d.mode; go(NAV[d.mode][0][0]); }
  else if (d.go) go(d.go);
  else if (d.seg) { state[d.seg] = d.value; render(true); }
  else if ("use" in d) {
    if (state.kind === "train") openTrain(d.use);
    else {  // a seller sells one model, so the chat takes that model with it
      state.seller = d.use;
      state.model = data.market.find(o => o.offer === d.use)?.model || state.model;
      state.route = "remote";
      go("chat");
    }
  }
  else if (d.scenario === "rent") {
    go("chat");  // at once: the machine report can take several seconds to arrive
    if (!data.doctor) await refresh("doctor");
    const big = Object.entries(data.doctor?.models || {}).find(([, m]) => m.path === "remote" && m.sellers?.infer)?.[0];
    if (big) { chooseModel(big); render(true); } else { state.kind = "infer"; go("market"); }
  }
  else if (d.scenario) openTrain();
  else if (d.offer) { state.open = state.open === d.offer ? null : d.offer; render(true); }
  else if ("all" in d) { state.all = !state.all; render(true); }
  else if ("clearSeller" in d) { state.seller = null; render(true); }
  else if ("chat" in d) { chooseModel(d.chat); go("chat"); }
  else if ("rollback" in d) { await call(`/api/beetle/models/${encodeURIComponent(d.rollback)}/rollback`, {}).catch(() => {}); refresh("models"); }
  else if ("fetch" in d) { await call(`/api/beetle/jobs/${encodeURIComponent(d.fetch)}/fetch`, {}).catch(() => {}); refresh("jobs", "wallet"); }
  else if ("cancel" in d) { await call(`/api/beetle/jobs/${encodeURIComponent(d.cancel)}/cancel`, {}).catch(() => {}); refresh("jobs", "wallet"); }
  else if ("start" in d) startTraining();
  else if ("proof" in d) { state.drawer = () => proofCard(d.proof); loadProof(d.proof); render(true); }  // a job moves on after its card was read
  else if ("close" in d) { state.drawer = null; state.sheet = null; render(true); }
  else if ("list" in d) hostAction("/native/host/list", { model: state.hostForm.model, in: Number(state.hostForm.in),
    out: Number(state.hostForm.out), slots: Number(state.hostForm.slots) }, "host");
  else if (d.serve) hostAction("/native/host/serve", { on: d.serve === "true" });
  else if (d.agent) {
    state.agentBusy = d.agent;
    state.agentError = null;
    render(true);
    const out = await call(`/native/agents/${d.agent}/${d.to}`, {}).catch(err => ({ ok: false, error: err.message }));
    state.agentBusy = null;
    if (!out.ok) state.agentError = out.error;
    refresh("agents");
  }
});

async function hostAction(path, body, next) {
  state.hostBusy = true;
  state.hostError = null;
  render(true);
  const out = await call(path, body).catch(e => ({ ok: false, error: e.message }));
  state.hostBusy = false;
  if (!out.ok) state.hostError = out.error;
  else if (next) return go(next);
  refresh("host", "wallet", "market");
}

// Text fields keep their menu, for paste. `make dev` keeps it everywhere, for Inspect Element.
document.addEventListener("contextmenu", e => {
  if (!data.info?.dev && !e.target.closest("input, textarea, .msg")) e.preventDefault();
});

document.addEventListener("input", e => {
  if (e.target.dataset.host) state.hostForm[e.target.dataset.host] = e.target.value;
  if (e.target.id === "draft") state.draft = e.target.value;
  if (e.target.dataset.bind && state.sheet) state.sheet[e.target.dataset.bind] = e.target.value;
});

document.addEventListener("change", e => {
  const d = e.target.dataset;
  if (d.pick === "model") { chooseModel(e.target.value); render(true); }
  if (d.bind && state.sheet && (d.bind === "dataset" || d.bind === "base")) { state.sheet[d.bind] = e.target.value; quote(); }
});

document.addEventListener("submit", e => {
  e.preventDefault();
  const text = state.draft.trim();
  if (text && !state.busy && state.model) send(text);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.drawer) { state.drawer = null; state.sheet = null; render(true); }
  if (e.key === "Enter" && !e.shiftKey && e.target.id === "draft") { e.preventDefault(); e.target.form.requestSubmit(); }
});

window.addEventListener("hashchange", () => { if (location.hash.slice(1) !== state.page) go(location.hash.slice(1) || "overview"); });

let ticks = 0;
setInterval(() => {
  ticks += 1;
  if (activeJob() || ticks % 5 === 0) refresh("jobs");
  if (ticks % 10 === 0) refresh("wallet");
  if (ticks % 3 === 0 && Object.values(errors).some(e => ["not_set_up", "not_installed", "no_daemon"].includes(e.code)))
    refresh("info", "wallet", "doctor", ...(NEEDS[state.page] || []));
}, 3000);

render(true);  // the frame first: a slow daemon must not mean an empty window
refresh("info", "wallet", "jobs").then(() => { go(state.page); refresh("doctor"); });
