// In-browser engines: DuckDB-WASM (synchronous "blocking" build, shared by SQL and Python)
// and Pyodide running the PySpark-compatible layer in py/pyspark_shim.py.
//
// By default everything loads from cdn.jsdelivr.net. Hosts that only allow a page to fetch its
// own files set window.TRAINER_DUCKDB_LOCAL / window.TRAINER_PYODIDE_LOCAL to folders that hold
// the .wasm and data files (see tools/build_artifact.py); scripts still come from the CDN.
(function () {
  "use strict";

  const T = window.TRAINER;
  const DUCKDB_ESM = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-blocking.mjs/+esm";
  const DUCKDB_DIST = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/";
  const PYODIDE_CDN = "https://cdn.jsdelivr.net/npm/pyodide@0.27.7/";

  const listeners = [];
  const status = { sql: "idle", python: "idle" };
  function setStatus(kind, state) {
    status[kind] = state;
    listeners.forEach((fn) => fn(status));
  }

  // ------------------------------------------------------------------ Arrow → plain values
  function kindOf(type) {
    const t = String(type);
    // Nested types first: their text also contains the names of their child types (Struct<{a: Utf8}>).
    if (/^List|^FixedSizeList|^LargeList/.test(t)) return "list";
    if (/^Struct/.test(t)) return "struct";
    if (/^Map/.test(t)) return "other";
    if (/^Date/.test(t)) return "date";
    if (/^Timestamp/.test(t)) return "timestamp";
    if (/^Decimal/.test(t)) return type.scale === 0 ? "int" : "float";
    if (/^Float/.test(t)) return "float";
    if (/^u?int/i.test(t)) return "int";
    if (/^Bool/.test(t)) return "bool";
    if (/Utf8/.test(t)) return "string";
    return "other";
  }

  function isoTimestamp(ms) {
    const d = new Date(ms);
    const s = d.toISOString().slice(0, 19).replace("T", " ");
    const frac = d.getUTCMilliseconds();
    return frac ? s + "." + String(frac).padStart(3, "0") : s;
  }

  function convert(v, type) {
    if (v === null || v === undefined) return null;
    switch (kindOf(type)) {
      case "date": return new Date(v instanceof Date ? v.getTime() : Number(v)).toISOString().slice(0, 10);
      case "timestamp": return isoTimestamp(v instanceof Date ? v.getTime() : Number(v));
      case "int": {
        if (/^Decimal/.test(String(type))) return Number(String(v));
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : BigInt(v); // keep 64-bit ids exact; serialized as digits below
      }
      case "float":
        return /^Decimal/.test(String(type)) ? Number(String(v)) / Math.pow(10, type.scale) : Number(v);
      case "list": {
        const child = type.children[0].type;
        return Array.from(v, (x) => convert(x, child));
      }
      case "struct": {
        const o = {};
        for (const f of type.children) o[f.name] = convert(v[f.name], f.type);
        return o;
      }
      default:
        if (typeof v === "bigint") return Number(v);
        if (typeof v === "object" && v.toJSON) return v.toJSON();
        return v;
    }
  }

  // JSON text for plain values, writing BigInt as exact integer digits (JSON.stringify can't).
  function jsonText(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? '"NaN"' : v > 0 ? '"Infinity"' : '"-Infinity"');
    if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(jsonText).join(",") + "]";
    return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + jsonText(v[k])).join(",") + "}";
  }

  function tableToJson(table) {
    const fields = table.schema.fields;
    const vectors = fields.map((_, i) => table.getChildAt(i));
    const rows = [];
    for (let r = 0; r < table.numRows; r++) rows.push(fields.map((f, c) => convert(vectors[c].get(r), f.type)));
    return { columns: fields.map((f) => f.name), kinds: fields.map((f) => kindOf(f.type)), rows };
  }

  // Display string for the SQL result tables and answer checking.
  function displayCell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return String(Math.round(v * 10000) / 10000);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object") return jsonText(v);
    return String(v);
  }

  // ------------------------------------------------------------------ DuckDB
  let duckPromise = null;

  async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't load ${url} (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function gunzipIfNeeded(bytes) {
    // The server may already have decoded the gzip; only decompress when the magic bytes are there.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }

  function duck() {
    if (duckPromise) return duckPromise;
    setStatus("sql", "loading");
    duckPromise = (async () => {
      const duckdb = await import(DUCKDB_ESM);
      let ehWasm = DUCKDB_DIST + "duckdb-eh.wasm", mvpWasm = DUCKDB_DIST + "duckdb-mvp.wasm";
      if (window.TRAINER_DUCKDB_LOCAL) {
        const bytes = await gunzipIfNeeded(await fetchBytes(window.TRAINER_DUCKDB_LOCAL + "duckdb-eh.gz.wasm"));
        ehWasm = mvpWasm = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
      }
      const db = await duckdb.createDuckDB(
        { mvp: { mainModule: mvpWasm, mainWorker: "" }, eh: { mainModule: ehWasm, mainWorker: "" } },
        new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
      await db.instantiate(() => {});
      const conn = db.connect();
      // Same NULL ordering as Spark and Databricks SQL: NULLs first ascending, last descending.
      conn.query("SET default_null_order = 'nulls_first_on_asc_last_on_desc'");
      resetData(conn);
      setStatus("sql", "ready");
      return conn;
    })().catch((err) => {
      duckPromise = null;
      setStatus("sql", "error");
      throw err;
    });
    return duckPromise;
  }

  function names(conn, sql) {
    return tableToJson(conn.query(sql)).rows.map((r) => r[0]);
  }

  // Drop everything learners created, then reload the sample tables.
  function resetData(conn) {
    for (const v of names(conn, "SELECT view_name FROM duckdb_views() WHERE NOT internal")) {
      conn.query(`DROP VIEW IF EXISTS "${v.replace(/"/g, '""')}"`);
    }
    for (const t of names(conn, "SELECT table_name FROM duckdb_tables() WHERE NOT internal")) {
      conn.query(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
    }
    for (const stmt of T.datasetSql) conn.query(stmt);
  }

  // Splits SQL text into statements on ";", ignoring semicolons inside quotes and comments.
  function splitSql(sql) {
    const out = [];
    let cur = "", i = 0;
    while (i < sql.length) {
      const c = sql[i], two = sql.substr(i, 2);
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
        cur += sql.slice(i, j + 1); i = j + 1;
      } else if (two === "--") {
        let j = sql.indexOf("\n", i); if (j < 0) j = sql.length;
        cur += sql.slice(i, j); i = j;
      } else if (two === "/*") {
        let j = sql.indexOf("*/", i + 2); j = j < 0 ? sql.length : j + 2;
        cur += sql.slice(i, j); i = j;
      } else if (c === ";") {
        out.push(cur); cur = ""; i++;
      } else { cur += c; i++; }
    }
    out.push(cur);
    // drop pieces that hold only whitespace and comments
    return out.filter((st) => st.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "");
  }

  // Runs every statement and returns the result of the last one.
  async function runSql(sql) {
    const conn = await duck();
    const stmts = splitSql(sql);
    if (!stmts.length) return { columns: [], rows: [] };
    let last;
    for (const st of stmts) last = conn.query(st);
    const res = tableToJson(last);
    return { columns: res.columns, rows: res.rows.map((r) => r.map(displayCell)) };
  }

  // ------------------------------------------------------------------ Pyodide
  let pyPromise = null;
  let sink = null; // { text(str), table({columns, rows}) } for the code that's running

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Couldn't load ${src}`));
      document.head.appendChild(s);
    });
  }

  function python() {
    if (pyPromise) return pyPromise;
    pyPromise = (async () => {
      const conn = await duck();
      setStatus("python", "loading");
      if (!window.loadPyodide) await loadScript(PYODIDE_CDN + "pyodide.js");
      let opts = { indexURL: PYODIDE_CDN };
      if (window.TRAINER_PYODIDE_LOCAL) {
        // Pyodide skips fetching pyodide.asm.js if it's already loaded, so take the script from the CDN
        // and only the binary files from this page's own folder.
        if (typeof window._createPyodideModule !== "function") await loadScript(PYODIDE_CDN + "pyodide.asm.js");
        const base = new URL(window.TRAINER_PYODIDE_LOCAL, document.baseURI).href;
        opts = { indexURL: base, stdLibURL: base + "python_stdlib.zip.wasm", lockFileURL: base + "pyodide-lock.json" };
      }
      const py = await window.loadPyodide(opts);
      const write = (s) => { if (sink) sink.text(s); };
      py.setStdout({ batched: (s) => write(s + "\n") });
      py.setStderr({ batched: (s) => write(s + "\n") });

      const source = T.pysparkShimSource || await (await fetch("py/pyspark_shim.py")).text();
      py.FS.mkdirTree("/home/pyodide/trainer");
      py.FS.writeFile("/home/pyodide/trainer/pyspark_shim.py", source);
      py.runPython("import sys; sys.path.insert(0, '/home/pyodide/trainer'); sys.dont_write_bytecode = True");
      const shim = py.pyimport("pyspark_shim");
      shim.setup(
        (sql) => jsonText(tableToJson(conn.query(sql))),
        (json) => { if (sink) sink.table(JSON.parse(json)); });
      setStatus("python", "ready");
      return { py, shim };
    })().catch((err) => {
      pyPromise = null;
      setStatus("python", "error");
      throw err;
    });
    return pyPromise;
  }

  // Runs code in a namespace (a fresh one unless one is passed) and reports output to `out`.
  // Returns { error, namespace }. The caller owns the namespace and should destroy() it when done.
  async function runPython(code, out, namespace) {
    const { py, shim } = await python();
    await new Promise((r) => setTimeout(r, 0)); // let "Running…" paint before Python blocks the page
    const ns = namespace || shim.new_namespace();
    sink = out || null;
    let error;
    try {
      error = shim.run_cell(code, ns);
      py.runPython("import sys; sys.stdout.flush(); sys.stderr.flush()");
    } finally {
      sink = null;
    }
    return { error: error === undefined || error === null ? null : String(error), namespace: ns };
  }

  async function pythonResult(namespace) {
    const { shim } = await python();
    return JSON.parse(shim.result_json(namespace));
  }

  async function newNamespace() {
    const { shim } = await python();
    return shim.new_namespace();
  }

  T.engine = {
    duck, runSql, splitSql, python, runPython, pythonResult, newNamespace,
    resetData: async () => resetData(await duck()),
    status: () => Object.assign({}, status),
    onStatus: (fn) => { listeners.push(fn); fn(status); }
  };
})();
