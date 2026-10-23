// Databricks trainer: routing, views, progress and answer checking.
// The SQL and Python engines live in engine.js (TRAINER.engine).
(function () {
  "use strict";

  const T = window.TRAINER;
  const E = T.engine;
  const $app = document.getElementById("app");
  const $engine = document.getElementById("engine-status");

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Plain text with `inline code` → safe HTML
  // (a backtick right after "." is Spark path syntax such as json.`/path/`, so it's left as is)
  const fmt = (s) => esc(s).replace(/(^|[^.\w])`([^`]+)`/g, "$1<code>$2</code>");
  const domainById = (id) => T.domains.find((d) => d.id === id);
  const examDomains = T.domains.filter((d) => !d.track);
  const pyDomains = T.domains.filter((d) => d.track === "pyspark");
  const saDomains = T.domains.filter((d) => d.track === "architect");
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ------------------------------------------------------------------ progress
  const STORE_KEY = "dbx-trainer-v1";
  const emptyProgress = () => ({ lessons: {}, quiz: {}, exercises: {}, drafts: {}, cases: {} });
  let progress = emptyProgress();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved) progress = Object.assign(progress, saved);
  } catch (e) { /* storage unavailable: progress lasts for this visit only */ }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) { /* ignore */ }
  }

  function domainStats(domainId) {
    const lessons = T.lessons.filter((l) => l.domain === domainId);
    const exercises = T.exercises.filter((x) => x.domain === domainId);
    return {
      lessons: lessons.length,
      lessonsDone: lessons.filter((l) => progress.lessons[l.id]).length,
      exercises: exercises.length,
      exercisesDone: exercises.filter((x) => progress.exercises[x.id]).length,
      quizBest: progress.quiz[domainId] // percentage or undefined
    };
  }
  function trackPct(domains) {
    const ids = new Set(domains.map((d) => d.id));
    const lessons = T.lessons.filter((l) => ids.has(l.domain));
    const exercises = T.exercises.filter((x) => ids.has(x.domain));
    const total = lessons.length + exercises.length + domains.length;
    const done = lessons.filter((l) => progress.lessons[l.id]).length +
      exercises.filter((x) => progress.exercises[x.id]).length +
      domains.filter((d) => (progress.quiz[d.id] || 0) >= 70).length;
    return Math.round((done / total) * 100);
  }

  // ------------------------------------------------------------------ engine status
  E.onStatus((s) => {
    let state = "idle", text = "Engines load when needed";
    if (s.sql === "loading") { state = "loading"; text = "SQL engine loading…"; }
    if (s.sql === "ready") { state = "ready"; text = "SQL engine ready"; }
    if (s.python === "loading") { state = "loading"; text = "Python loading…"; }
    if (s.python === "ready") { state = "ready"; text = "SQL + PySpark ready"; }
    if (s.sql === "error" || s.python === "error") { state = "error"; text = "Engine unavailable"; }
    $engine.className = "engine " + state;
    $engine.textContent = text;
    $engine.title = text; // the badge truncates on narrow screens
  });

  function engineError(e) {
    return `<div class="feedback bad"><strong>The in-browser engine couldn't load.</strong> It is downloaded from cdn.jsdelivr.net, so you need an internet connection. If you opened the file directly, serve the folder instead (for example <code>python3 -m http.server</code>).<br><span class="muted small">${esc(e.message || e)}</span></div>`;
  }

  function resultTable(res, limit = 200, label = "") {
    if (!res.columns.length) return `<p class="muted">Statement ran. No result set.</p>`;
    const head = res.columns.map((c) => `<th>${esc(c)}</th>`).join("");
    const body = res.rows.slice(0, limit).map((row) =>
      "<tr>" + row.map((v) => v === null ? `<td class="null">NULL</td>` : `<td>${esc(v)}</td>`).join("") + "</tr>"
    ).join("");
    const more = res.rows.length > limit ? ` · showing the first ${limit}` : "";
    return `<div class="table-wrap"><table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted small">${label}${res.rows.length} row${res.rows.length === 1 ? "" : "s"}${more}</p>`;
  }

  function compareResults(mine, expected, ordered, checkNames) {
    if (mine.columns.length !== expected.columns.length) {
      return { ok: false, msg: `Your result has ${mine.columns.length} column(s), but ${expected.columns.length} are expected (${expected.columns.join(", ")}).` };
    }
    if (checkNames) {
      const lower = (cols) => cols.map((c) => c.toLowerCase()).join(", ");
      if (lower(mine.columns) !== lower(expected.columns)) {
        return { ok: false, msg: `Your columns are (${mine.columns.join(", ")}), but the expected columns are (${expected.columns.join(", ")}). Use .alias() or .withColumnRenamed() to name them.` };
      }
    }
    if (mine.rows.length !== expected.rows.length) {
      return { ok: false, msg: `Your result has ${mine.rows.length} row(s), but ${expected.rows.length} are expected.` };
    }
    const key = (row) => JSON.stringify(row);
    const a = mine.rows.map(key), b = expected.rows.map(key);
    if (!ordered) { a.sort(); b.sort(); }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        const sameSet = ordered && a.slice().sort().join("|") === b.slice().sort().join("|");
        return { ok: false, msg: sameSet
          ? "The rows are right, but the order isn't. Check your sorting."
          : "The values don't match the expected result. Check your filters, joins and aggregates. Column order matters too." };
      }
    }
    return { ok: true };
  }

  // Strip comments so commented-out code doesn't satisfy pattern checks.
  function stripComments(code, lang) {
    if (lang === "python") return code.replace(/#[^\n]*/g, "");
    return code.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  function checkPattern(ex, code) {
    const src = stripComments(code, ex.lang);
    if (/____/.test(src)) return { ok: false, failures: ["Fill in all the ____ blanks."] };
    const flags = ex.lang === "python" ? "m" : "im";
    const failures = ex.checks.filter((c) => new RegExp(c.re, flags).test(src) === !!c.absent).map((c) => c.msg);
    return { ok: failures.length === 0, failures };
  }

  // Collects Python output (printed text and display() tables) into a container, in order.
  function outputSink(el) {
    let pre = null;
    return {
      text(s) {
        if (!pre) { pre = document.createElement("pre"); pre.className = "stdout"; el.appendChild(pre); }
        pre.textContent += s;
      },
      table(res) {
        pre = null;
        const div = document.createElement("div");
        div.innerHTML = resultTable(res, 1000, "display() · ");
        el.appendChild(div);
      },
      error(msg) {
        pre = null;
        const p = document.createElement("pre");
        p.className = "error";
        p.textContent = msg;
        el.appendChild(p);
      },
      html(h) {
        pre = null;
        const div = document.createElement("div");
        div.innerHTML = h;
        el.appendChild(div);
      }
    };
  }

  // ------------------------------------------------------------------ editor helpers
  function wireEditor(textarea, onRun) {
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: end, value } = textarea;
        const n = Number(textarea.dataset.indent || 2);
        textarea.value = value.slice(0, s) + " ".repeat(n) + value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = s + n;
        textarea.dispatchEvent(new Event("input"));
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onRun && onRun();
      }
    });
  }

  // ------------------------------------------------------------------ views
  function domainCards(domains, label) {
    return domains.map((d, i) => {
      const s = domainStats(d.id);
      const quiz = s.quizBest === undefined ? "Not taken" : s.quizBest + "%";
      return `<a class="card domain-card" href="#/domain/${d.id}">
        <div class="domain-num">${label} ${i + 1}</div>
        <h3>${esc(d.title)}</h3>
        <p>${esc(d.summary)}</p>
        <ul class="stats">
          <li><span>${s.lessonsDone}/${s.lessons}</span> lessons</li>
          ${s.exercises ? `<li><span>${s.exercisesDone}/${s.exercises}</span> exercises</li>` : ""}
          <li><span>${quiz}</span> quiz best</li>
        </ul>
      </a>`;
    }).join("");
  }

  function viewHome() {
    const examPct = trackPct(examDomains), pyPct = trackPct(pyDomains), saPct = trackPct(saDomains);
    const ids = (ds) => new Set(ds.map((d) => d.id));
    const examIds = ids(examDomains), pyIds = ids(pyDomains), saIds = ids(saDomains);
    const next = T.lessons.find((l) => examIds.has(l.domain) && !progress.lessons[l.id]);
    const nextPy = T.lessons.find((l) => pyIds.has(l.domain) && !progress.lessons[l.id]);
    const nextSa = T.lessons.find((l) => saIds.has(l.domain) && !progress.lessons[l.id]);
    const cta = next
      ? `<a class="btn primary" href="#/lesson/${next.id}">${examPct ? "Continue" : "Start"}: ${esc(next.title)}</a>`
      : `<a class="btn primary" href="#/quiz/all">Take the mixed exam quiz</a>`;

    return `<section class="hero">
        <h1>Databricks Trainer</h1>
        <p class="lead">Three tracks: prepare for the Data Engineer Associate exam, learn PySpark with code that runs in your browser, and practise designing Azure Databricks solutions as an architect.</p>
        <div class="actions">${cta}
          <a class="btn" href="#/exercises">Hands-on exercises</a>
          <a class="btn" href="#/pyspark">PySpark sandbox</a>
          <a class="btn" href="#/sandbox">SQL sandbox</a>
        </div>
      </section>
      <div class="track-head">
        <h2>Exam domains</h2>
        <div class="progress-row"><div class="bar"><div style="width:${examPct}%"></div></div><span>${examPct}%</span></div>
      </div>
      <div class="grid">${domainCards(examDomains, "Domain")}</div>
      <div class="track-head">
        <h2>PySpark track</h2>
        <div class="progress-row"><div class="bar"><div style="width:${pyPct}%"></div></div><span>${pyPct}%</span></div>
      </div>
      <p class="muted">Write real PySpark (<code>spark.table</code>, <code>pyspark.sql.functions</code>, <code>Window</code>) and run it in the browser. ${nextPy ? `Next up: <a href="#/lesson/${nextPy.id}">${esc(nextPy.title)}</a>.` : ""}</p>
      <div class="grid two">${domainCards(pyDomains, "Module")}</div>
      <div class="track-head">
        <h2>Solutions Architect track · Azure</h2>
        <div class="progress-row"><div class="bar"><div style="width:${saPct}%"></div></div><span>${saPct}%</span></div>
      </div>
      <p class="muted">Design Azure Databricks platforms: networking, security, Unity Catalog topology, reference architectures, sizing and cost, migration and DR. Practise with case studies and cost calculations. ${nextSa ? `Next up: <a href="#/lesson/${nextSa.id}">${esc(nextSa.title)}</a>.` : ""}</p>
      <div class="grid">${domainCards(saDomains, "Module")}</div>
      <p class="muted small">Progress is saved in this browser only. A domain or module counts as complete once you score 70% or more on its quiz. Exam content follows the public exam guide topics; check the <a href="https://www.databricks.com/learn/certification/data-engineer-associate" target="_blank" rel="noopener">official exam page</a> for the current outline.</p>`;
  }

  function viewDomain(id) {
    const d = domainById(id);
    if (!d) return viewNotFound();
    const s = domainStats(id);
    const lessons = T.lessons.filter((l) => l.domain === id).map((l) =>
      `<li><a href="#/lesson/${l.id}">${progress.lessons[l.id] ? '<span class="tick">✓</span>' : '<span class="dot"></span>'}${esc(l.title)}</a><span class="muted">${l.minutes} min</span></li>`
    ).join("");
    const exercises = T.exercises.filter((x) => x.domain === id).map(exerciseRow).join("");
    const nq = T.questions.filter((q) => q.domain === id).length;
    const trackName = { pyspark: "PySpark / ", architect: "Solutions Architect / " }[d.track] || "";
    return `<nav class="crumbs"><a href="#/">Home</a> / ${trackName}${esc(d.title)}</nav>
      <h1>${esc(d.title)}</h1>
      <p class="lead">${esc(d.summary)}</p>
      <h2>Lessons</h2><ul class="list">${lessons}</ul>
      <h2>Quiz</h2>
      <div class="card row">
        <div><strong>${nq} questions</strong><br><span class="muted">${s.quizBest === undefined ? "Not taken yet" : "Best score: " + s.quizBest + "%"}</span></div>
        <a class="btn primary" href="#/quiz/${id}">Start quiz</a>
      </div>
      ${exercises ? `<h2>Exercises</h2><ul class="list">${exercises}</ul>` : ""}`;
  }

  function viewLesson(id) {
    const idx = T.lessons.findIndex((l) => l.id === id);
    if (idx < 0) return viewNotFound();
    const l = T.lessons[idx];
    const d = domainById(l.domain);
    const prev = T.lessons[idx - 1], next = T.lessons[idx + 1];
    const done = !!progress.lessons[id];
    const sameDomainNext = next && next.domain === l.domain;
    setTimeout(() => {
      document.getElementById("mark-done").addEventListener("click", () => {
        progress.lessons[id] = true; save();
        location.hash = sameDomainNext ? `#/lesson/${next.id}` : `#/quiz/${l.domain}`;
      });
      // "Try it" buttons copy a runnable example into the PySpark sandbox.
      document.querySelectorAll(".lesson pre[data-try]").forEach((pre) => {
        const btn = document.createElement("button");
        btn.className = "btn try";
        btn.type = "button";
        btn.textContent = "Try it in the sandbox";
        btn.addEventListener("click", () => {
          progress.drafts.__pysandbox = pre.textContent;
          save();
          location.hash = "#/pyspark";
        });
        pre.insertAdjacentElement("afterend", btn);
      });
    });
    return `<nav class="crumbs"><a href="#/">Home</a> / <a href="#/domain/${d.id}">${esc(d.title)}</a></nav>
      <article class="lesson">
        <h1>${esc(l.title)}</h1>
        <p class="muted">${l.minutes} min read${done ? ' · <span class="tick">✓ Completed</span>' : ""}</p>
        ${l.body.replace(/<h3>/g, "<h2>").replace(/<\/h3>/g, "</h2>")}
      </article>
      <div class="lesson-nav">
        ${prev && prev.domain === l.domain ? `<a class="btn" href="#/lesson/${prev.id}">← ${esc(prev.title)}</a>` : "<span></span>"}
        <button id="mark-done" class="btn primary">${sameDomainNext ? "Mark complete & next →" : "Mark complete & take the quiz →"}</button>
      </div>`;
  }

  // ---------------- quiz
  const MIXED = {
    all: { title: "Mixed exam quiz", domains: examDomains },
    "py-all": { title: "Mixed PySpark quiz", domains: pyDomains },
    "sa-all": { title: "Mixed architect quiz", domains: saDomains }
  };

  function viewQuiz(scope) {
    const mixed = MIXED[scope];
    const d = mixed ? null : domainById(scope);
    if (!mixed && !d) return viewNotFound();
    let pool;
    if (mixed) {
      const ids = new Set(mixed.domains.map((x) => x.id));
      pool = shuffle(T.questions.filter((q) => ids.has(q.domain))).slice(0, 20);
    } else {
      pool = shuffle(T.questions.filter((q) => q.domain === scope));
    }
    // Shuffle answer options, keeping track of the correct one.
    const qs = pool.map((q) => {
      const order = shuffle(q.options.map((_, i) => i));
      return Object.assign({}, q, { options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) });
    });
    const state = { i: 0, answers: [] };
    const title = mixed ? mixed.title : d.title + " quiz";

    function renderQuestion() {
      const q = qs[state.i];
      const answered = state.answers[state.i] !== undefined;
      const pick = state.answers[state.i];
      const opts = q.options.map((o, k) => {
        let cls = "option";
        if (answered) {
          if (k === q.answer) cls += " correct";
          else if (k === pick) cls += " wrong";
        }
        return `<button class="${cls}" data-k="${k}" ${answered ? "disabled" : ""}><span class="letter">${"ABCD"[k]}</span>${fmt(o)}</button>`;
      }).join("");
      const feedback = answered
        ? `<div class="feedback ${pick === q.answer ? "good" : "bad"}"><strong>${pick === q.answer ? "Correct." : "Not quite."}</strong> ${fmt(q.explain)}</div>
           <button class="btn primary" id="next-q">${state.i + 1 < qs.length ? "Next question →" : "See results"}</button>`
        : "";
      const body = document.getElementById("quiz-body");
      body.innerHTML = `<div class="quiz-meta"><span>Question ${state.i + 1} of ${qs.length}</span>
          ${mixed ? `<span class="tag">${esc(domainById(q.domain).short)}</span>` : ""}</div>
        <div class="bar thin"><div style="width:${(state.i / qs.length) * 100}%"></div></div>
        <p class="question">${fmt(q.q)}</p>
        ${q.code ? `<pre><code>${esc(q.code)}</code></pre>` : ""}
        <div class="options">${opts}</div>${feedback}`;
      body.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => {
        state.answers[state.i] = Number(b.dataset.k);
        renderQuestion();
      }));
      const nx = document.getElementById("next-q");
      if (nx) { nx.addEventListener("click", () => { state.i++; state.i < qs.length ? renderQuestion() : renderResults(); }); nx.focus(); }
    }

    function renderResults() {
      const correct = qs.filter((q, i) => state.answers[i] === q.answer).length;
      const pct = Math.round((correct / qs.length) * 100);
      if (!mixed) {
        progress.quiz[scope] = Math.max(progress.quiz[scope] || 0, pct);
        save();
      }
      const byDomain = T.domains.map((dd) => {
        const idx = qs.map((q, i) => (q.domain === dd.id ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) return "";
        const c = idx.filter((i) => state.answers[i] === qs[i].answer).length;
        return `<li><span>${esc(dd.short)}</span><div class="bar thin"><div style="width:${(c / idx.length) * 100}%"></div></div><span>${c}/${idx.length}</span></li>`;
      }).join("");
      const missed = qs.map((q, i) => ({ q, pick: state.answers[i] })).filter((x) => x.pick !== x.q.answer);
      const review = missed.map(({ q, pick }) => `<div class="card review">
          <p class="question">${fmt(q.q)}</p>
          <p><span class="bad-text">Your answer:</span> ${fmt(q.options[pick])}</p>
          <p><span class="good-text">Correct:</span> ${fmt(q.options[q.answer])}</p>
          <p class="muted">${fmt(q.explain)}</p>
          <a href="#/domain/${q.domain}">Review ${esc(domainById(q.domain).short)} lessons</a>
        </div>`).join("");
      document.getElementById("quiz-body").innerHTML = `
        <div class="score ${pct >= 70 ? "good" : "bad"}"><div class="big">${pct}%</div>
          <div>${correct} of ${qs.length} correct · ${pct >= 70 ? "Passing level. Nice work." : "Below the 70% target. Review the lessons and try again."}</div></div>
        ${mixed ? `<h3>By topic</h3><ul class="breakdown">${byDomain}</ul>` : ""}
        <div class="actions"><a class="btn primary" href="#/quiz/${scope}" id="retry">Try again</a>
          <a class="btn" href="${mixed ? "#/" : "#/domain/" + scope}">${mixed ? "Home" : "Back to " + (d.track ? "module" : "domain")}</a></div>
        ${missed.length ? `<h3>Review your mistakes</h3>${review}` : ""}`;
      document.getElementById("retry").addEventListener("click", (e) => { e.preventDefault(); render(true); });
    }

    setTimeout(renderQuestion);
    return `<nav class="crumbs"><a href="#/">Home</a> / ${mixed ? "Practice" : `<a href="#/domain/${d.id}">${esc(d.title)}</a>`}</nav>
      <h1>${esc(title)}</h1><div class="card quiz" id="quiz-body"></div>`;
  }

  // ---------------- exercises
  function exerciseRow(x) {
    const status = progress.exercises[x.id] ? '<span class="tick">✓</span>' : '<span class="dot"></span>';
    const kind = x.kind === "sql" ? '<span class="tag run">Runs SQL</span>'
      : x.kind === "python" ? '<span class="tag run">Runs PySpark</span>'
      : x.kind === "scenario" ? '<span class="tag run">Case study</span>'
      : x.kind === "calc" ? '<span class="tag">Calculation</span>'
      : `<span class="tag">${x.lang === "python" ? "PySpark" : "Spark SQL"} syntax</span>`;
    return `<li><a href="#/exercise/${x.id}">${status}${esc(x.title)}</a><span class="row-tags">${kind}<span class="tag level-${x.level.toLowerCase()}">${x.level}</span></span></li>`;
  }

  function viewExercises() {
    const rows = (pred) => T.exercises.filter(pred).map(exerciseRow).join("");
    const isPy = (x) => x.domain.startsWith("py-");
    const done = Object.keys(progress.exercises).filter((k) => T.exercises.some((x) => x.id === k)).length;
    return `<nav class="crumbs"><a href="#/">Home</a> / Exercises</nav>
      <h1>Hands-on exercises</h1>
      <p class="lead">${done} of ${T.exercises.length} solved.</p>
      <h2>SQL: runs in your browser</h2>
      <p class="muted">Your query runs on DuckDB-WASM against a small retail dataset, and the results are compared with the expected output. The SQL works in both DuckDB and Databricks (ANSI SQL plus QUALIFY, count_if and date_trunc).</p>
      <ul class="list">${rows((x) => x.kind === "sql")}</ul>
      <h2>PySpark: runs in your browser</h2>
      <p class="muted">Write PySpark DataFrame code and assign your answer to <code>result</code>. It runs in Python in your browser on the same tables, through a PySpark-compatible API.</p>
      <ul class="list">${rows((x) => x.kind === "python")}</ul>
      <h2>Spark & Databricks syntax</h2>
      <p class="muted">Auto Loader, MERGE, pipelines, Unity Catalog, file I/O and the Delta Python API need a real cluster, so these exercises check your code against the required syntax.</p>
      <ul class="list">${rows((x) => x.kind === "pattern" && !isPy(x))}${rows((x) => x.kind === "pattern" && isPy(x))}</ul>
      <h2>Architecture case studies</h2>
      <p class="muted">Work through a customer scenario one design decision at a time. Each choice gets feedback, and 70% or more counts as solved.</p>
      <ul class="list">${rows((x) => x.kind === "scenario")}</ul>
      <h2>Sizing & cost calculations</h2>
      <p class="muted">Size subnets, warehouses and event streams, and estimate DBU and VM costs from given example rates.</p>
      <ul class="list">${rows((x) => x.kind === "calc")}</ul>`;
  }

  function datasetPanel() {
    return `<details class="dataset"><summary>Sample tables</summary><ul>${T.datasetDocs.map((t) =>
      `<li><code>${t.table}</code> (${esc(t.cols)}). <span class="muted">${esc(t.note)}</span></li>`).join("")}</ul></details>`;
  }

  async function runPythonInto(out, code, namespace) {
    out.innerHTML = "";
    const sink = outputSink(out);
    if (E.status().python !== "ready") sink.html(`<p class="muted">Loading Python and PySpark. The first time downloads about 20 MB…</p>`);
    const res = await E.runPython(code, sink, namespace);
    if (out.firstChild && out.firstChild.textContent.startsWith("Loading Python")) out.removeChild(out.firstChild);
    if (res.error) sink.error(res.error);
    return { res, sink };
  }

  function viewExercise(id) {
    const ex = T.exercises.find((x) => x.id === id);
    if (!ex) return viewNotFound();
    if (ex.kind === "scenario") return viewScenario(ex);
    if (ex.kind === "calc") return viewCalc(ex);
    const d = domainById(ex.domain);
    const idx = T.exercises.indexOf(ex);
    const next = T.exercises[idx + 1];
    let hintsShown = 0;

    setTimeout(() => {
      const ed = document.getElementById("editor");
      const out = document.getElementById("output");
      const verdict = document.getElementById("verdict");
      if (ex.kind === "python" || ex.lang === "python") ed.dataset.indent = "4";
      ed.value = progress.drafts[id] || ex.starter;
      ed.addEventListener("input", () => { progress.drafts[id] = ed.value; save(); });

      const pass = () => {
        progress.exercises[id] = true; save();
        verdict.innerHTML = `<div class="feedback good"><strong>Correct!</strong> ${next ? `<a href="#/exercise/${next.id}">Next exercise →</a>` : `<a href="#/exercises">Back to exercises</a>`}</div>`;
      };
      const fail = (html) => { verdict.innerHTML = `<div class="feedback bad">${html}</div>`; };

      if (ex.kind === "sql") {
        const run = async () => {
          out.innerHTML = `<p class="muted">Running…</p>`;
          try { out.innerHTML = resultTable(await E.runSql(ed.value)); }
          catch (e) { out.innerHTML = `<pre class="error">${esc(e.message || e)}</pre>`; }
        };
        const check = async () => {
          verdict.innerHTML = `<p class="muted">Checking…</p>`;
          let mine;
          try {
            await E.resetData(); // start from clean sample data
            mine = await E.runSql(ed.value); out.innerHTML = resultTable(mine);
          }
          catch (e) { out.innerHTML = `<pre class="error">${esc(e.message || e)}</pre>`; return fail("Your query has an error. See the message below the editor."); }
          try {
            await E.resetData(); // undo any changes the learner's SQL made
            const expected = await E.runSql(ex.solution);
            const r = compareResults(mine, expected, ex.ordered);
            r.ok ? pass() : fail(esc(r.msg));
          } catch (e) { fail("Couldn't check the result: " + esc(e.message || e)); }
        };
        wireEditor(ed, run);
        document.getElementById("run").addEventListener("click", run);
        document.getElementById("check").addEventListener("click", check);
        E.duck().catch((e) => { out.innerHTML = engineError(e); });
      } else if (ex.kind === "python") {
        const showResult = async (ns, sink) => {
          const mine = await E.pythonResult(ns);
          if (!mine.error) sink.html(resultTable({ columns: mine.columns, rows: mine.display }, 200, "<code>result</code> · "));
          return mine;
        };
        const run = async () => {
          verdict.innerHTML = "";
          try {
            await E.resetData();
            const { res, sink } = await runPythonInto(out, ed.value);
            if (!res.error) await showResult(res.namespace, sink);
            res.namespace.destroy();
          } catch (e) { out.innerHTML = engineError(e); }
        };
        const check = async () => {
          verdict.innerHTML = `<p class="muted">Checking…</p>`;
          try {
            await E.resetData();
            const { res, sink } = await runPythonInto(out, ed.value);
            if (res.error) { res.namespace.destroy(); return fail("Your code raised an error. See the message below the editor."); }
            const mine = await showResult(res.namespace, sink);
            res.namespace.destroy();
            if (mine.error) return fail(fmt(mine.error));
            await E.resetData();
            const sol = await E.runPython(ex.solution, null);
            if (sol.error) throw new Error(sol.error);
            const expected = await E.pythonResult(sol.namespace);
            sol.namespace.destroy();
            const r = compareResults({ columns: mine.columns, rows: mine.rows }, { columns: expected.columns, rows: expected.rows }, ex.ordered, true);
            if (!r.ok) return fail(esc(r.msg));
            const src = stripComments(ed.value, "python");
            const missing = (ex.requires || []).filter((q) => !new RegExp(q.re, "i").test(src));
            if (missing.length) return fail("<strong>The result is right, but:</strong> " + missing.map((q) => fmt(q.msg)).join(" "));
            pass();
          } catch (e) { fail("Couldn't check your code."); out.innerHTML = engineError(e); }
        };
        wireEditor(ed, check);
        document.getElementById("run").addEventListener("click", run);
        document.getElementById("check").addEventListener("click", check);
        E.python().catch((e) => { out.innerHTML = engineError(e); });
      } else {
        const check = () => {
          const r = checkPattern(ex, ed.value);
          r.ok ? pass() : fail("<strong>Not yet:</strong><ul>" + r.failures.map((f) => `<li>${esc(f)}</li>`).join("") + "</ul>");
        };
        wireEditor(ed, check);
        document.getElementById("check").addEventListener("click", check);
      }

      document.getElementById("hint").addEventListener("click", () => {
        if (hintsShown < ex.hints.length) hintsShown++;
        document.getElementById("hints").innerHTML = ex.hints.slice(0, hintsShown).map((h) => `<li>${fmt(h)}</li>`).join("");
        if (hintsShown >= ex.hints.length) document.getElementById("hint").disabled = true;
      });
      document.getElementById("solution").addEventListener("click", () => {
        document.getElementById("solution-box").innerHTML = `<h3>Solution</h3><pre><code>${esc(ex.solution)}</code></pre>`;
      });
      document.getElementById("reset").addEventListener("click", () => {
        ed.value = ex.starter; progress.drafts[id] = ex.starter; save();
        verdict.innerHTML = ""; out.innerHTML = "";
      });
    });

    const runs = ex.kind === "sql" || ex.kind === "python";
    const note = ex.kind === "sql" ? datasetPanel()
      : ex.kind === "python" ? `${datasetPanel()}<p class="muted small"><code>spark</code> is ready to use. <strong>Run</strong> shows your output, and <strong>Check answer</strong> compares your <code>result</code> DataFrame with the expected one.</p>`
      : `<p class="muted small">This exercise checks your syntax only. In a real workspace you would run it in a notebook or pipeline.</p>`;
    return `<nav class="crumbs"><a href="#/">Home</a> / <a href="#/exercises">Exercises</a> / ${esc(d.short)}</nav>
      <h1>${esc(ex.title)} ${progress.exercises[id] ? '<span class="tick small">✓ Solved</span>' : ""}</h1>
      <div class="card">
        <p class="prompt">${ex.prompt}</p>
        ${note}
      </div>
      <textarea id="editor" class="editor${ex.kind === "python" ? " tall" : ""}" spellcheck="false" aria-label="Code editor"></textarea>
      <div class="toolbar">
        ${runs ? `<button id="run" class="btn">Run${ex.kind === "sql" ? " <kbd>Ctrl</kbd>+<kbd>Enter</kbd>" : ""}</button>` : ""}
        <button id="check" class="btn primary">Check answer${ex.kind === "sql" ? "" : " <kbd>Ctrl</kbd>+<kbd>Enter</kbd>"}</button>
        <button id="hint" class="btn">Hint</button>
        <button id="solution" class="btn ghost">Show solution</button>
        <button id="reset" class="btn ghost">Reset</button>
      </div>
      <ul id="hints" class="hints"></ul>
      <div id="verdict"></div>
      <div id="output" class="output"></div>
      <div id="solution-box"></div>`;
  }

  function exerciseHeader(ex) {
    const d = domainById(ex.domain);
    return `<nav class="crumbs"><a href="#/">Home</a> / <a href="#/exercises">Exercises</a> / ${esc(d.short)}</nav>
      <h1>${esc(ex.title)} ${progress.exercises[ex.id] ? '<span class="tick small">✓ Solved</span>' : ""}</h1>`;
  }

  function nextExerciseLink(ex) {
    const same = T.exercises.filter((x) => x.kind === ex.kind);
    const next = same[same.indexOf(ex) + 1];
    return next ? `<a href="#/exercise/${next.id}">Next: ${esc(next.title)} →</a>` : `<a href="#/exercises">Back to exercises</a>`;
  }

  // ---------------- architecture case studies
  function viewScenario(ex) {
    // Shuffle options once per attempt so the best answer isn't always in the same place.
    const steps = ex.steps.map((st) => Object.assign({}, st, { options: shuffle(st.options) }));
    const state = { i: 0, picks: [] };
    const label = (score) => score === 2 ? "Best choice" : score === 1 ? "Workable, with drawbacks" : "Weak choice";

    function renderStep() {
      const st = steps[state.i];
      const pick = state.picks[state.i];
      const answered = pick !== undefined;
      const opts = st.options.map((o, k) => {
        let cls = "option";
        if (answered) cls += o.score === 2 ? " correct" : k === pick ? (o.score === 1 ? " partial" : " wrong") : "";
        return `<button class="${cls}" data-k="${k}" ${answered ? "disabled" : ""}><span class="letter">${"ABCD"[k]}</span>${fmt(o.text)}</button>`;
      }).join("");
      let feedback = "";
      if (answered) {
        const o = st.options[pick];
        const best = st.options.find((x) => x.score === 2);
        feedback = `<div class="feedback ${o.score === 2 ? "good" : o.score === 1 ? "warn" : "bad"}"><strong>${label(o.score)}.</strong> ${fmt(o.feedback)}</div>
          ${o.score !== 2 ? `<div class="feedback neutral"><strong>Best choice:</strong> ${fmt(best.text)}. ${fmt(best.feedback.replace(/^Right\.\s*/, ""))}</div>` : ""}
          <button class="btn primary" id="next-step">${state.i + 1 < steps.length ? "Next decision →" : "See your design review"}</button>`;
      }
      const body = document.getElementById("scenario-body");
      body.innerHTML = `<div class="quiz-meta"><span>Decision ${state.i + 1} of ${steps.length}</span></div>
        <div class="bar thin"><div style="width:${(state.i / steps.length) * 100}%"></div></div>
        <p class="question">${fmt(st.q)}</p>
        <div class="options">${opts}</div>${feedback}`;
      body.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => {
        state.picks[state.i] = Number(b.dataset.k);
        renderStep();
      }));
      const nx = document.getElementById("next-step");
      if (nx) { nx.addEventListener("click", () => { state.i++; state.i < steps.length ? renderStep() : renderReview(); }); nx.focus(); }
    }

    function renderReview() {
      const points = steps.reduce((sum, st, i) => sum + st.options[state.picks[i]].score, 0);
      const pct = Math.round((points / (steps.length * 2)) * 100);
      progress.cases[ex.id] = Math.max(progress.cases[ex.id] || 0, pct);
      if (pct >= 70) progress.exercises[ex.id] = true;
      save();
      const rowsHtml = steps.map((st, i) => {
        const o = st.options[state.picks[i]];
        const mark = o.score === 2 ? '<span class="pill good">Best</span>' : o.score === 1 ? '<span class="pill warn">Workable</span>' : '<span class="pill bad">Weak</span>';
        return `<li><div class="review-q">${fmt(st.q)}</div><div class="review-a">${mark} ${fmt(o.text)}</div></li>`;
      }).join("");
      document.getElementById("scenario-body").innerHTML = `
        <div class="score ${pct >= 70 ? "good" : "bad"}"><div class="big">${pct}%</div>
          <div>${points} of ${steps.length * 2} points · ${pct >= 70 ? "A sound design. " + nextExerciseLink(ex) : "Some decisions need another look. Review the feedback and try again."}</div></div>
        <h3>Your design</h3>
        <ol class="design-review">${rowsHtml}</ol>
        <div class="actions"><button class="btn primary" id="retry">Try again</button>
          <a class="btn" href="#/domain/${ex.domain}">Review the lessons</a></div>`;
      document.getElementById("retry").addEventListener("click", () => render(true));
    }

    setTimeout(renderStep);
    const best = progress.cases[ex.id];
    return `${exerciseHeader(ex)}
      <div class="card brief"><div class="eyebrow">Customer scenario</div>${ex.brief}
        ${best !== undefined ? `<p class="muted small">Your best score: ${best}%</p>` : ""}</div>
      <div class="card quiz" id="scenario-body"></div>`;
  }

  // ---------------- sizing and cost calculations
  function viewCalc(ex) {
    let hintsShown = 0;
    setTimeout(() => {
      const verdict = document.getElementById("verdict");
      const inputs = ex.answers.map((_, i) => document.getElementById("calc-" + i));
      inputs.forEach((el, i) => {
        const key = ex.id + ":" + i;
        el.value = progress.drafts[key] || "";
        el.addEventListener("input", () => { progress.drafts[key] = el.value; save(); });
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
      });
      const parse = (v) => Number(String(v).replace(/[$,%\s]/g, "").replace(/^\/(?=\d)/, ""));
      function check() {
        const results = ex.answers.map((a, i) => {
          const raw = inputs[i].value.trim();
          const n = parse(raw);
          const ok = raw !== "" && Number.isFinite(n) && Math.abs(n - a.value) <= a.tol + 1e-9;
          inputs[i].classList.toggle("ok", ok);
          inputs[i].classList.toggle("bad", !ok && raw !== "");
          return { a, raw, ok };
        });
        if (results.every((r) => r.ok)) {
          progress.exercises[ex.id] = true; save();
          verdict.innerHTML = `<div class="feedback good"><strong>Correct!</strong> ${nextExerciseLink(ex)}</div>`;
          showSolution();
        } else {
          const items = results.map((r) => `<li>${esc(r.a.label)}: ${r.raw === "" ? "no answer yet" : r.ok ? "correct" : "not quite"}</li>`).join("");
          verdict.innerHTML = `<div class="feedback bad"><strong>Not yet.</strong><ul>${items}</ul></div>`;
        }
      }
      function showSolution() {
        document.getElementById("solution-box").innerHTML = `<h3>Worked solution</h3><div class="card">${ex.explanation}</div>`;
      }
      document.getElementById("check").addEventListener("click", check);
      document.getElementById("solution").addEventListener("click", showSolution);
      document.getElementById("hint").addEventListener("click", () => {
        if (hintsShown < ex.hints.length) hintsShown++;
        document.getElementById("hints").innerHTML = ex.hints.slice(0, hintsShown).map((h) => `<li>${fmt(h)}</li>`).join("");
        if (hintsShown >= ex.hints.length) document.getElementById("hint").disabled = true;
      });
    });
    const fields = ex.answers.map((a, i) => `<div class="calc-field">
        <label for="calc-${i}">${esc(a.label)}</label>
        <div class="calc-input"><input id="calc-${i}" type="text" inputmode="decimal" autocomplete="off"><span>${esc(a.unit)}</span></div>
      </div>`).join("");
    return `${exerciseHeader(ex)}
      <div class="card brief">${ex.prompt}</div>
      <div class="calc-grid">${fields}</div>
      <div class="toolbar">
        <button id="check" class="btn primary">Check answers</button>
        <button id="hint" class="btn">Hint</button>
        <button id="solution" class="btn ghost">Show worked solution</button>
      </div>
      <ul id="hints" class="hints"></ul>
      <div id="verdict"></div>
      <div id="solution-box"></div>`;
  }

  function viewSandbox() {
    setTimeout(() => {
      const ed = document.getElementById("editor");
      const out = document.getElementById("output");
      ed.value = progress.drafts.__sandbox || "SELECT c.name, count(o.order_id) AS orders\nFROM customers c\nLEFT JOIN orders o USING (customer_id)\nGROUP BY c.name\nORDER BY orders DESC;";
      ed.addEventListener("input", () => { progress.drafts.__sandbox = ed.value; save(); });
      const run = async () => {
        out.innerHTML = `<p class="muted">Running…</p>`;
        try { out.innerHTML = resultTable(await E.runSql(ed.value)); }
        catch (e) { out.innerHTML = e && e.message && /import|fetch|Worker|load/i.test(e.message) ? engineError(e) : `<pre class="error">${esc(e.message || e)}</pre>`; }
      };
      wireEditor(ed, run);
      document.getElementById("run").addEventListener("click", run);
      document.getElementById("reset-data").addEventListener("click", async () => {
        try { await E.resetData(); out.innerHTML = `<p class="muted">Sample tables reloaded.</p>`; }
        catch (e) { out.innerHTML = engineError(e); }
      });
      E.duck().catch((e) => { out.innerHTML = engineError(e); });
    });
    return `<nav class="crumbs"><a href="#/">Home</a> / SQL sandbox</nav>
      <h1>SQL sandbox</h1>
      <p class="lead">Run any SQL against the sample tables. You can create tables and views, try window functions, and so on.</p>
      ${datasetPanel()}
      <textarea id="editor" class="editor" spellcheck="false" aria-label="SQL editor"></textarea>
      <div class="toolbar">
        <button id="run" class="btn primary">Run <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
        <button id="reset-data" class="btn ghost">Reload sample data</button>
      </div>
      <div id="output"></div>`;
  }

  // The PySpark sandbox keeps one Python namespace, like a notebook session.
  let pySession = null;

  function viewPySandbox() {
    setTimeout(() => {
      const ed = document.getElementById("editor");
      const out = document.getElementById("output");
      ed.dataset.indent = "4";
      ed.value = progress.drafts.__pysandbox || "from pyspark.sql import functions as F\n\norders = spark.table(\"orders\")\norders.printSchema()\n\ndisplay(orders.groupBy(\"status\").count().orderBy(F.desc(\"count\")))";
      ed.addEventListener("input", () => { progress.drafts.__pysandbox = ed.value; save(); });
      const run = async () => {
        try {
          if (!pySession) pySession = await E.newNamespace();
          await runPythonInto(out, ed.value, pySession);
        } catch (e) { out.innerHTML = engineError(e); }
      };
      wireEditor(ed, run);
      document.getElementById("run").addEventListener("click", run);
      document.getElementById("reset-session").addEventListener("click", async () => {
        try {
          if (pySession) { pySession.destroy(); pySession = null; }
          await E.resetData();
          out.innerHTML = `<p class="muted">Session cleared and sample tables reloaded.</p>`;
        } catch (e) { out.innerHTML = engineError(e); }
      });
      E.python().catch((e) => { out.innerHTML = engineError(e); });
    });
    return `<nav class="crumbs"><a href="#/">Home</a> / PySpark sandbox</nav>
      <h1>PySpark sandbox</h1>
      <p class="lead">A notebook-style session with <code>spark</code> ready to use. Variables persist between runs until you reset the session.</p>
      ${datasetPanel()}
      <details class="dataset"><summary>What works here</summary>
        <p class="small">DataFrame transformations and actions, <code>pyspark.sql.functions</code>, <code>Window</code>, <code>Row</code>, <code>pyspark.sql.types</code>, temp views, <code>saveAsTable</code> and <code>display()</code>. Results, column names and types were checked against real Spark 3.5.</p>
        <p class="small"><code>spark.sql()</code>, <code>F.expr()</code>, <code>selectExpr()</code> and string filters take Spark SQL: backticks, <code>datediff</code>, <code>date_add</code>, <code>size</code>, <code>explode</code>, <code>collect_list</code>, higher-order functions, <code>LEFT ANTI JOIN</code>, <code>LATERAL VIEW</code>, <code>:named</code> parameters, 0-based array indexing and Java date patterns. They are translated to run on DuckDB. <code>SHOW TABLES</code> and <code>DESCRIBE</code> work too.</p>
        <p class="small">Not available (they need a real cluster): file reads and writes, the Delta Python API and <code>OPTIMIZE</code>/<code>VACUUM</code>/<code>MERGE</code>, streaming, RDDs, Python UDFs and JSON functions. They raise a clear error. <code>explain()</code> shows DuckDB's plan. A cell that runs longer than 30 seconds is stopped.</p>
      </details>
      <textarea id="editor" class="editor tall" spellcheck="false" aria-label="Python editor"></textarea>
      <div class="toolbar">
        <button id="run" class="btn primary">Run <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
        <button id="reset-session" class="btn ghost">Reset session</button>
      </div>
      <div id="output" class="output"></div>`;
  }

  function viewNotFound() {
    return `<h1>Page not found</h1><p><a href="#/">Back to home</a></p>`;
  }

  // ------------------------------------------------------------------ nav + router
  function renderNav(route) {
    const group = (domains) => domains.map((d, i) => {
      const s = domainStats(d.id);
      const active = route.domain === d.id ? " active" : "";
      const lessons = T.lessons.filter((l) => l.domain === d.id).map((l) =>
        `<a class="sub${route.lesson === l.id ? " active" : ""}" href="#/lesson/${l.id}">${progress.lessons[l.id] ? "✓ " : ""}${esc(l.title)}</a>`).join("");
      return `<div class="nav-group"><a class="nav-domain${active}" href="#/domain/${d.id}"><span class="num">${i + 1}</span>${esc(d.short)}
          <span class="mini">${s.lessonsDone}/${s.lessons}</span></a>${route.domain === d.id ? lessons : ""}</div>`;
    }).join("");
    const top = (name, href, label) => `<a class="nav-top${route.name === name ? " active" : ""}" href="${href}">${label}</a>`;
    document.getElementById("nav").innerHTML = `
      ${top("home", "#/", "Overview")}
      <div class="nav-label">Exam domains</div>${group(examDomains)}
      ${top("quiz-all", "#/quiz/all", "Mixed exam quiz")}
      <div class="nav-label">PySpark track</div>${group(pyDomains)}
      ${top("quiz-py-all", "#/quiz/py-all", "Mixed PySpark quiz")}
      <div class="nav-label">Solutions Architect</div>${group(saDomains)}
      ${top("quiz-sa-all", "#/quiz/sa-all", "Mixed architect quiz")}
      <div class="nav-label">Practice</div>
      ${top("exercises", "#/exercises", "Exercises")}
      ${top("pyspark", "#/pyspark", "PySpark sandbox")}
      ${top("sandbox", "#/sandbox", "SQL sandbox")}
      <button class="nav-reset" id="reset-progress">Reset progress</button>`;
    // Two-step confirm in the page itself (no confirm() dialog, which embedded viewers suppress).
    const resetBtn = document.getElementById("reset-progress");
    resetBtn.addEventListener("click", () => {
      if (!resetBtn.classList.contains("armed")) {
        resetBtn.classList.add("armed");
        resetBtn.textContent = "Click again to clear all progress";
        setTimeout(() => { resetBtn.classList.remove("armed"); resetBtn.textContent = "Reset progress"; }, 4000);
        return;
      }
      progress = emptyProgress(); save(); render(true);
    });
  }

  function parseRoute() {
    const [, a, b] = (location.hash || "#/").replace(/^#/, "").split("/");
    switch (a) {
      case "domain": return { name: "domain", domain: b, view: () => viewDomain(b) };
      case "lesson": {
        const l = T.lessons.find((x) => x.id === b);
        return { name: "lesson", lesson: b, domain: l && l.domain, view: () => viewLesson(b) };
      }
      case "quiz": return { name: MIXED[b] ? "quiz-" + b : "quiz", domain: b, view: () => viewQuiz(b) };
      case "exercises": return { name: "exercises", view: viewExercises };
      case "exercise": {
        const x = T.exercises.find((e) => e.id === b);
        return { name: "exercises", domain: x && x.domain, view: () => viewExercise(b) };
      }
      case "sandbox": return { name: "sandbox", view: viewSandbox };
      case "pyspark": return { name: "pyspark", view: viewPySandbox };
      default: return { name: "home", view: viewHome };
    }
  }

  function render(keepScroll) {
    const route = parseRoute();
    renderNav(route);
    $app.innerHTML = route.view();
    if (!keepScroll) window.scrollTo(0, 0);
    document.body.classList.remove("nav-open");
  }

  document.getElementById("menu-toggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  window.addEventListener("hashchange", () => render());
  render();
})();
