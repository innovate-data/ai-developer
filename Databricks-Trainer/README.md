# Databricks Trainer

A static, single-page web app for learning Databricks, with three tracks: preparation for the **Databricks Certified Data Engineer Associate** exam, a hands-on **PySpark** track, and an **Azure Solutions Architect** track. There's no backend and no build step. Progress is saved in the browser's `localStorage`.

## What's inside

| | |
|---|---|
| **Lessons** | 13 short lessons across the 5 exam domains: Platform, Ingestion, Transformations, Production pipelines, Governance |
| **Quizzes** | 205 multiple-choice questions with explanations across the three tracks: a quiz per domain or module (70% counts as passing) and a 20-question mixed quiz per track with a per-topic breakdown |
| **SQL exercises** | 9 exercises that run **real SQL in your browser** on [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) against a small retail dataset. Your result set is compared with the expected one |
| **Spark pattern exercises** | 6 exercises for syntax that can't run in a browser (notebooks and widgets, Auto Loader, MERGE, Lakeflow Declarative Pipelines expectations, Unity Catalog grants, time travel and RESTORE). Your code is checked against the required patterns, with specific feedback |
| **SQL sandbox** | Free-form queries against the sample tables |
| **PySpark track** | 4 modules (DataFrame fundamentals, window and advanced functions, reading/writing and Delta, performance and internals), 10 lessons with "Try it" examples, 26 quiz questions |
| **PySpark exercises** | 15 exercises where your PySpark code **actually runs** in the browser and your `result` DataFrame is compared with the expected one, plus 3 syntax-checked Delta/I/O exercises |
| **PySpark sandbox** | A notebook-style Python session with `spark` and `display()` ready to use |
| **Solutions Architect track (Azure)** | 5 modules (platform architecture and networking, identity/security/Unity Catalog design, reference architectures, sizing and cost, migration/DR/operations), 10 lessons with architecture diagrams |
| **Architecture case studies** | 5 customer scenarios (private bank workspace, real-time retail, multi-BU governance, Synapse migration, cost reduction) where each design decision gets feedback |
| **Sizing & cost calculations** | 5 exercises: subnet capacity, classic job cost, jobs vs all-purpose savings, SQL warehouse scale-out, Event Hubs throughput units |

## Run it

The SQL engine is loaded from `cdn.jsdelivr.net`, so you need an internet connection. Serve the folder over HTTP; opening `index.html` from disk isn't reliable for web workers:

```bash
cd Databricks-Trainer
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works too (GitHub Pages, Azure Static Web Apps, S3, ...).

## Project layout

```
index.html
css/styles.css              light/dark theme, responsive layout
js/content-lessons.js       domains + lesson HTML
js/content-quiz.js          question bank
js/content-exercises.js     sample dataset + SQL and pattern exercises
js/content-pyspark.js       PySpark track: modules, lessons, questions, exercises
js/content-architect.js     Solutions Architect track: modules, lessons with SVG diagrams, questions, case studies, calculations
js/content-quiz-extra.js    second half of the question bank (all tracks)
js/engine.js                DuckDB-WASM (sync build) + Pyodide loading, Arrow conversion
js/app.js                   router, views, progress, answer checking
py/pyspark_shim.py          PySpark-compatible DataFrame API that compiles to SQL on DuckDB
tests/                      pytest checks for the shim and every PySpark exercise
tools/build_artifact.py     single-page build for sandboxed hosts
```

## How PySpark runs in the browser

Python runs in [Pyodide](https://pyodide.org). `py/pyspark_shim.py` installs `pyspark`, `pyspark.sql.functions`, `pyspark.sql.window` and `pyspark.sql.types` modules whose DataFrames compile to SQL and run on the same DuckDB-WASM database as the SQL exercises.

- **DataFrame API**: joins, aggregations, pivots, window functions, arrays and higher-order functions, dates, `fillna`/`dropna`, `show()`, `printSchema()`, temp views, `saveAsTable`. Casts follow Spark (truncating, timestamp to epoch seconds), NULL ordering matches Spark, and result types are the ones Spark returns (`int` for `year()`, `bigint` for `ceil()`, ...).
- **Spark SQL**: `spark.sql()`, `F.expr()`, `selectExpr()` and string filters pass through a token-based rewriter that maps Spark SQL to DuckDB: functions (`datediff`, `date_add`, `size`, `explode`, `collect_list`, `to_date(s, fmt)`, higher-order functions, ...), backtick identifiers, `LEFT ANTI/SEMI JOIN`, `LATERAL VIEW explode`, `:named` parameters, 0-based array subscripts, `RLIKE`, `DIV`, `array<T>` types and three-part table names (`main.sales.orders` maps to the sample table `orders`). `SHOW TABLES`, `DESCRIBE`, `USE` and `SET` are handled.
- **Not available** (they need a cluster) and raising a clear `NotAvailableInTrainer` error: file I/O, `DeltaTable`, `OPTIMIZE`/`VACUUM`/`MERGE`/`COPY INTO`, `GRANT`/`REVOKE`, declarative pipelines, streaming, RDDs, Python UDFs, JSON functions.
- **Safety**: a Python cell is stopped after 30 seconds (`CELL_TIMEOUT`). SQL queries can't be interrupted, so a very large query (for example `range(10000000000)`) will freeze the tab until it finishes.
- **Known cosmetic differences**: auto-generated names of unaliased window and lambda columns, `void` types for NULL literals, SQL `PIVOT` counting 0 instead of NULL, `explain()` output, and a last-digit float difference in `describe()`. The full list is in `tests/diff_known.py`.

### Tests

```bash
pip install duckdb==1.1.1 pytest            # needs Node.js
pytest tests/                                # shim + every PySpark exercise

pip install pyspark==3.5.3                   # also needs Java 11, 17 or 21
pytest tests/test_matches_real_pyspark.py    # ~350 snippets compared with real Spark 3.5
```

The second suite runs each snippet on real PySpark and on the shim and compares column names, types, rows and `show()` text. It is skipped when PySpark or Java isn't installed.

## Publishing as a single page (e.g. a claude.ai Artifact)

Some hosts only allow a page to fetch its own files. `tools/build_artifact.py` inlines the CSS and JS into one page and switches the SQL engine to load from a `duckdb/` folder next to it:

```bash
python3 tools/build_artifact.py out/
mkdir -p out/duckdb out/pyodide && cd out
npm pack @duckdb/duckdb-wasm@1.29.0 pyodide@0.27.7
tar xzf duckdb-duckdb-wasm-1.29.0.tgz && gzip -9 -c package/dist/duckdb-eh.wasm > duckdb/duckdb-eh.gz.wasm && rm -rf package
tar xzf pyodide-0.27.7.tgz && cp package/pyodide.asm.wasm package/pyodide-lock.json pyodide/ \
  && cp package/python_stdlib.zip pyodide/python_stdlib.zip.wasm && rm -rf package *.tgz
```

Scripts (DuckDB's blocking build, `pyodide.js`, `pyodide.asm.js`) still load from cdn.jsdelivr.net; only binary and data files are served from the page's folder. File names end in `.wasm` because that's a type such hosts serve; the app gunzips the DuckDB file itself.

## Notes

- The SQL exercises use SQL that works in both DuckDB and Databricks (ANSI SQL plus `QUALIFY`, `count_if`, `date_trunc`). Spark-only features are covered by the pattern exercises.
- The content follows the public exam guide topics as of 2025/2026, including newer names such as Lakeflow Declarative Pipelines (formerly DLT) and Lakeflow Jobs. Check the [official exam page](https://www.databricks.com/learn/certification/data-engineer-associate) for the current outline and weights.
