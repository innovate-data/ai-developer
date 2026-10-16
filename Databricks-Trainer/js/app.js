// Databricks Data Engineer Associate trainer: routing, views, progress and the SQL engine.
(function () {
  "use strict";

  const T = window.TRAINER;
  const $app = document.getElementById("app");
  const $engine = document.getElementById("engine-status");

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Plain text with `inline code` → safe HTML
  // (a backtick right after "." is Spark path syntax such as json.`/path/`, so it's left as is)
  const fmt = (s) => esc(s).replace(/(^|[^.\w])`([^`]+)`/g, "$1<code>$2</code>");
  const domainById = (id) => T.domains.find((d) => d.id === id);
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
  let progress = { lessons: {}, quiz: {}, exercises: {}, drafts: {} };
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
  function overallPct() {
    const total = T.lessons.length + T.exercises.length + T.domains.length;
    const done = Object.keys(progress.lessons).length +
      Object.keys(progress.exercises).length +
      T.domains.filter((d) => (progress.quiz[d.id] || 0) >= 70).length;
    return Math.round((done / total) * 100);
  }

  // ------------------------------------------------------------------ SQL engine (DuckDB-WASM)
  const DUCKDB_URL = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
  let enginePromise = null;

  function setEngine(state, text) {
    $engine.className = "engine " + state;
    $engine.textContent = text;
  }

  function getEngine() {
    if (enginePromise) return enginePromise;
    setEngine("loading", "SQL engine loading…");
    enginePromise = (async () => {
      const duckdb = await import(DUCKDB_URL);
      const db = window.TRAINER_DUCKDB_LOCAL
        ? await instantiateLocal(duckdb, window.TRAINER_DUCKDB_LOCAL)
        : await instantiateCdn(duckdb);
      const conn = await db.connect();
      await loadDataset(conn);
      setEngine("ready", "SQL engine ready");
      return conn;
    })().catch((err) => {
      enginePromise = null;
      setEngine("error", "SQL engine unavailable");
      throw err;
    });
    return enginePromise;
  }

  async function instantiateCdn(duckdb) {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    return db;
  }

  // Hosts that only allow fetching same-origin files (e.g. a sandboxed embed) ship the
  // worker and a gzipped .wasm next to the page; both are turned into blob: URLs here.
  async function instantiateLocal(duckdb, base) {
    const get = async (path) => {
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`Couldn't load ${path} (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [workerJs, wasmGz] = await Promise.all([get("duckdb-browser-eh.worker.js"), get("duckdb-eh.gz.wasm")]);
    // The server may already have decoded the gzip; only decompress if the gzip magic bytes are there.
    const wasm = wasmGz[0] === 0x1f && wasmGz[1] === 0x8b
      ? await new Response(new Blob([wasmGz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
      : wasmGz;
    const workerUrl = URL.createObjectURL(new Blob([workerJs], { type: "text/javascript" }));
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await db.instantiate(wasmUrl);
    return db;
  }

  async function loadDataset(conn) {
    for (const stmt of T.datasetSql) await conn.query(stmt);
  }

  function formatCell(v, typeName) {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") v = Number(v);
    if (/^Date/.test(typeName)) {
      const d = v instanceof Date ? v : new Date(Number(v));
      return d.toISOString().slice(0, 10);
    }
    if (/^Timestamp/.test(typeName)) {
      const d = v instanceof Date ? v : new Date(Number(v));
      return d.toISOString().slice(0, 19).replace("T", " ");
    }
    if (typeof v === "number") return String(Math.round(v * 10000) / 10000);
    if (typeof v === "object") {
      try { return JSON.stringify(v.toJSON ? v.toJSON() : v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  // Runs one or more statements and returns {columns, rows} for the last one.
  async function runSql(sql) {
    const conn = await getEngine();
    const table = await conn.query(sql);
    const fields = table.schema.fields;
    const columns = fields.map((f) => f.name);
    const rows = [];
    for (let r = 0; r < table.numRows; r++) {
      rows.push(fields.map((f, c) => formatCell(table.getChildAt(c).get(r), String(f.type))));
    }
    return { columns, rows };
  }

  function resultTable(res, limit = 200) {
    if (!res.columns.length) return `<p class="muted">Statement ran. No result set.</p>`;
    const head = res.columns.map((c) => `<th>${esc(c)}</th>`).join("");
    const body = res.rows.slice(0, limit).map((row) =>
      "<tr>" + row.map((v) => v === null ? `<td class="null">NULL</td>` : `<td>${esc(v)}</td>`).join("") + "</tr>"
    ).join("");
    const more = res.rows.length > limit ? `<p class="muted">Showing ${limit} of ${res.rows.length} rows.</p>` : "";
    return `<div class="table-wrap"><table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted">${res.rows.length} row${res.rows.length === 1 ? "" : "s"}</p>${more}`;
  }

  function compareResults(mine, expected, ordered) {
    if (mine.columns.length !== expected.columns.length) {
      return { ok: false, msg: `Your query returns ${mine.columns.length} column(s), but ${expected.columns.length} are expected (${expected.columns.join(", ")}).` };
    }
    if (mine.rows.length !== expected.rows.length) {
      return { ok: false, msg: `Your query returns ${mine.rows.length} row(s), but ${expected.rows.length} are expected.` };
    }
    const key = (row) => JSON.stringify(row);
    const a = mine.rows.map(key), b = expected.rows.map(key);
    if (!ordered) { a.sort(); b.sort(); }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        const sameSet = ordered && a.slice().sort().join("|") === b.slice().sort().join("|");
        return { ok: false, msg: sameSet
          ? "The rows are right, but the order isn't. Check your ORDER BY."
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

  // ------------------------------------------------------------------ editor helpers
  function wireEditor(textarea, onRun) {
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: end, value } = textarea;
        textarea.value = value.slice(0, s) + "  " + value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = s + 2;
        textarea.dispatchEvent(new Event("input"));
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onRun && onRun();
      }
    });
  }

  // ------------------------------------------------------------------ views
  function viewHome() {
    const pct = overallPct();
    const cards = T.domains.map((d, i) => {
      const s = domainStats(d.id);
      const quiz = s.quizBest === undefined ? "Not taken" : s.quizBest + "%";
      return `<a class="card domain-card" href="#/domain/${d.id}">
        <div class="domain-num">Domain ${i + 1}</div>
        <h3>${esc(d.title)}</h3>
        <p>${esc(d.summary)}</p>
        <ul class="stats">
          <li><span>${s.lessonsDone}/${s.lessons}</span> lessons</li>
          ${s.exercises ? `<li><span>${s.exercisesDone}/${s.exercises}</span> exercises</li>` : ""}
          <li><span>${quiz}</span> quiz best</li>
        </ul>
      </a>`;
    }).join("");

    const next = T.lessons.find((l) => !progress.lessons[l.id]);
    const cta = next
      ? `<a class="btn primary" href="#/lesson/${next.id}">${Object.keys(progress.lessons).length ? "Continue" : "Start"}: ${esc(next.title)}</a>`
      : `<a class="btn primary" href="#/quiz/all">Take the mixed practice quiz</a>`;

    return `<section class="hero">
        <h1>Databricks Data Engineer Associate trainer</h1>
        <p class="lead">Study each exam domain with short lessons, check yourself with quizzes, and practise SQL on real tables that run in your browser.</p>
        <div class="progress-row">
          <div class="bar"><div style="width:${pct}%"></div></div>
          <span>${pct}% complete</span>
        </div>
        <div class="actions">${cta}
          <a class="btn" href="#/exercises">Hands-on exercises</a>
          <a class="btn" href="#/sandbox">SQL sandbox</a>
        </div>
      </section>
      <h2>Exam domains</h2>
      <div class="grid">${cards}</div>
      <p class="muted small">Progress is saved in this browser only. A domain counts as complete once you score 70% or more on its quiz. Content is based on the public exam guide topics; check the <a href="https://www.databricks.com/learn/certification/data-engineer-associate" target="_blank" rel="noopener">official exam page</a> for the current outline.</p>`;
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
    return `<nav class="crumbs"><a href="#/">Home</a> / ${esc(d.title)}</nav>
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
    });
    return `<nav class="crumbs"><a href="#/">Home</a> / <a href="#/domain/${d.id}">${esc(d.title)}</a></nav>
      <article class="lesson">
        <h1>${esc(l.title)}</h1>
        <p class="muted">${l.minutes} min read${done ? ' · <span class="tick">✓ Completed</span>' : ""}</p>
        ${l.body}
      </article>
      <div class="lesson-nav">
        ${prev ? `<a class="btn" href="#/lesson/${prev.id}">← ${esc(prev.title)}</a>` : "<span></span>"}
        <button id="mark-done" class="btn primary">${sameDomainNext ? "Mark complete & next →" : "Mark complete & take the quiz →"}</button>
      </div>`;
  }

  // ---------------- quiz
  function viewQuiz(scope) {
    const isAll = scope === "all";
    const d = isAll ? null : domainById(scope);
    if (!isAll && !d) return viewNotFound();
    const pool = isAll ? shuffle(T.questions).slice(0, 20) : shuffle(T.questions.filter((q) => q.domain === scope));
    // Shuffle answer options, keeping track of the correct one.
    const qs = pool.map((q) => {
      const order = shuffle(q.options.map((_, i) => i));
      return Object.assign({}, q, { options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) });
    });
    const state = { i: 0, answers: [] };
    const title = isAll ? "Mixed practice quiz" : d.title + " quiz";

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
          ${isAll ? `<span class="tag">${esc(domainById(q.domain).short)}</span>` : ""}</div>
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
      if (!isAll) {
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
        ${isAll ? `<h3>By domain</h3><ul class="breakdown">${byDomain}</ul>` : ""}
        <div class="actions"><a class="btn primary" href="#/quiz/${scope}" id="retry">Try again</a>
          <a class="btn" href="${isAll ? "#/" : "#/domain/" + scope}">${isAll ? "Home" : "Back to domain"}</a></div>
        ${missed.length ? `<h3>Review your mistakes</h3>${review}` : ""}`;
      document.getElementById("retry").addEventListener("click", (e) => { e.preventDefault(); render(true); });
    }

    setTimeout(renderQuestion);
    return `<nav class="crumbs"><a href="#/">Home</a> / ${isAll ? "Practice" : `<a href="#/domain/${d.id}">${esc(d.title)}</a>`}</nav>
      <h1>${esc(title)}</h1><div class="card quiz" id="quiz-body"></div>`;
  }

  // ---------------- exercises
  function exerciseRow(x) {
    const status = progress.exercises[x.id] ? '<span class="tick">✓</span>' : '<span class="dot"></span>';
    const kind = x.kind === "sql" ? '<span class="tag run">Runs SQL</span>' : `<span class="tag">${x.lang === "python" ? "PySpark" : "Spark SQL"} pattern</span>`;
    return `<li><a href="#/exercise/${x.id}">${status}${esc(x.title)}</a><span class="row-tags">${kind}<span class="tag level-${x.level.toLowerCase()}">${x.level}</span></span></li>`;
  }

  function viewExercises() {
    const sql = T.exercises.filter((x) => x.kind === "sql").map(exerciseRow).join("");
    const pat = T.exercises.filter((x) => x.kind === "pattern").map(exerciseRow).join("");
    const done = Object.keys(progress.exercises).length;
    return `<nav class="crumbs"><a href="#/">Home</a> / Exercises</nav>
      <h1>Hands-on exercises</h1>
      <p class="lead">${done} of ${T.exercises.length} solved.</p>
      <h2>SQL: runs in your browser</h2>
      <p class="muted">Your query runs on DuckDB-WASM against a small retail dataset. Your results are compared with the expected output. The SQL is portable between DuckDB and Databricks (ANSI SQL plus QUALIFY, count_if and date_trunc).</p>
      <ul class="list">${sql}</ul>
      <h2>Spark & Databricks syntax</h2>
      <p class="muted">Auto Loader, MERGE, pipelines and Unity Catalog can't run in a browser, so these exercises check your code against the required syntax.</p>
      <ul class="list">${pat}</ul>`;
  }

  function datasetPanel() {
    return `<details class="dataset"><summary>Sample tables</summary><ul>${T.datasetDocs.map((t) =>
      `<li><code>${t.table}</code> (${esc(t.cols)}). <span class="muted">${esc(t.note)}</span></li>`).join("")}</ul></details>`;
  }

  function viewExercise(id) {
    const ex = T.exercises.find((x) => x.id === id);
    if (!ex) return viewNotFound();
    const d = domainById(ex.domain);
    const idx = T.exercises.indexOf(ex);
    const next = T.exercises[idx + 1];
    let hintsShown = 0;

    setTimeout(() => {
      const ed = document.getElementById("editor");
      const out = document.getElementById("output");
      const verdict = document.getElementById("verdict");
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
          try { out.innerHTML = resultTable(await runSql(ed.value)); }
          catch (e) { out.innerHTML = `<pre class="error">${esc(e.message || e)}</pre>`; }
        };
        const check = async () => {
          verdict.innerHTML = `<p class="muted">Checking…</p>`;
          let mine;
          try {
            await loadDataset(await getEngine()); // start from clean sample data
            mine = await runSql(ed.value); out.innerHTML = resultTable(mine);
          }
          catch (e) { out.innerHTML = `<pre class="error">${esc(e.message || e)}</pre>`; return fail("Your query has an error. See the message below the editor."); }
          try {
            const conn = await getEngine();
            await loadDataset(conn); // undo any changes the learner's SQL made
            const expected = await runSql(ex.solution);
            const r = compareResults(mine, expected, ex.ordered);
            r.ok ? pass() : fail(esc(r.msg));
          } catch (e) { fail("Couldn't check the result: " + esc(e.message || e)); }
        };
        wireEditor(ed, run);
        document.getElementById("run").addEventListener("click", run);
        document.getElementById("check").addEventListener("click", check);
        getEngine().catch((e) => { out.innerHTML = engineError(e); });
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

    const isSql = ex.kind === "sql";
    return `<nav class="crumbs"><a href="#/">Home</a> / <a href="#/exercises">Exercises</a> / ${esc(d.short)}</nav>
      <h1>${esc(ex.title)} ${progress.exercises[id] ? '<span class="tick small">✓ Solved</span>' : ""}</h1>
      <div class="card">
        <p class="prompt">${ex.prompt}</p>
        ${isSql ? datasetPanel() : `<p class="muted small">This exercise checks your syntax only. In a real workspace you would run it in a notebook or pipeline.</p>`}
      </div>
      <textarea id="editor" class="editor" spellcheck="false" aria-label="Code editor"></textarea>
      <div class="toolbar">
        ${isSql ? `<button id="run" class="btn">Run <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>` : ""}
        <button id="check" class="btn primary">Check answer${isSql ? "" : " <kbd>Ctrl</kbd>+<kbd>Enter</kbd>"}</button>
        <button id="hint" class="btn">Hint</button>
        <button id="solution" class="btn ghost">Show solution</button>
        <button id="reset" class="btn ghost">Reset</button>
      </div>
      <ul id="hints" class="hints"></ul>
      <div id="verdict"></div>
      <div id="output"></div>
      <div id="solution-box"></div>`;
  }

  function engineError(e) {
    return `<div class="feedback bad"><strong>The in-browser SQL engine couldn't load.</strong> It is downloaded from cdn.jsdelivr.net, so you need an internet connection. If you opened the file directly, serve the folder instead (for example <code>python3 -m http.server</code>).<br><span class="muted small">${esc(e.message || e)}</span></div>`;
  }

  function viewSandbox() {
    setTimeout(() => {
      const ed = document.getElementById("editor");
      const out = document.getElementById("output");
      ed.value = progress.drafts.__sandbox || "SELECT c.name, count(o.order_id) AS orders\nFROM customers c\nLEFT JOIN orders o USING (customer_id)\nGROUP BY c.name\nORDER BY orders DESC;";
      ed.addEventListener("input", () => { progress.drafts.__sandbox = ed.value; save(); });
      const run = async () => {
        out.innerHTML = `<p class="muted">Running…</p>`;
        try { out.innerHTML = resultTable(await runSql(ed.value)); }
        catch (e) { out.innerHTML = e && e.message && /import|fetch|Worker/i.test(e.message) ? engineError(e) : `<pre class="error">${esc(e.message || e)}</pre>`; }
      };
      wireEditor(ed, run);
      document.getElementById("run").addEventListener("click", run);
      document.getElementById("reset-data").addEventListener("click", async () => {
        try { await loadDataset(await getEngine()); out.innerHTML = `<p class="muted">Sample tables reloaded.</p>`; }
        catch (e) { out.innerHTML = engineError(e); }
      });
      getEngine().catch((e) => { out.innerHTML = engineError(e); });
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

  function viewNotFound() {
    return `<h1>Page not found</h1><p><a href="#/">Back to home</a></p>`;
  }

  // ------------------------------------------------------------------ nav + router
  function renderNav(route) {
    const links = T.domains.map((d, i) => {
      const s = domainStats(d.id);
      const active = route.domain === d.id ? " active" : "";
      const lessons = T.lessons.filter((l) => l.domain === d.id).map((l) =>
        `<a class="sub${route.lesson === l.id ? " active" : ""}" href="#/lesson/${l.id}">${progress.lessons[l.id] ? "✓ " : ""}${esc(l.title)}</a>`).join("");
      return `<div class="nav-group"><a class="nav-domain${active}" href="#/domain/${d.id}"><span class="num">${i + 1}</span>${esc(d.short)}
          <span class="mini">${s.lessonsDone}/${s.lessons}</span></a>${route.domain === d.id ? lessons : ""}</div>`;
    }).join("");
    document.getElementById("nav").innerHTML = `
      <a class="nav-top${route.name === "home" ? " active" : ""}" href="#/">Overview</a>
      <div class="nav-label">Domains</div>${links}
      <div class="nav-label">Practice</div>
      <a class="nav-top${route.name === "exercises" ? " active" : ""}" href="#/exercises">Exercises</a>
      <a class="nav-top${route.name === "quiz-all" ? " active" : ""}" href="#/quiz/all">Mixed quiz</a>
      <a class="nav-top${route.name === "sandbox" ? " active" : ""}" href="#/sandbox">SQL sandbox</a>
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
      progress = { lessons: {}, quiz: {}, exercises: {}, drafts: {} }; save(); render(true);
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
      case "quiz": return { name: b === "all" ? "quiz-all" : "quiz", domain: b, view: () => viewQuiz(b) };
      case "exercises": return { name: "exercises", view: viewExercises };
      case "exercise": {
        const x = T.exercises.find((e) => e.id === b);
        return { name: "exercises", domain: x && x.domain, view: () => viewExercise(b) };
      }
      case "sandbox": return { name: "sandbox", view: viewSandbox };
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
