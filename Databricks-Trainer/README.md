# Databricks Trainer

A static, single-page web app for learning Databricks: preparation for the **Databricks Certified Data Engineer Associate** exam, plus a hands-on **PySpark** track. There's no backend and no build step. Progress is saved in the browser's `localStorage`.

## What's inside

| | |
|---|---|
| **Lessons** | 13 short lessons across the 5 exam domains: Platform, Ingestion, Transformations, Production pipelines, Governance |
| **Quizzes** | 46 multiple-choice questions with explanations. There's a quiz per domain (70% counts as passing) and a 20-question mixed practice quiz with a per-domain breakdown |
| **SQL exercises** | 9 exercises that run **real SQL in your browser** on [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) against a small retail dataset. Your result set is compared with the expected one |
| **Spark pattern exercises** | 6 exercises for syntax that can't run in a browser (notebooks and widgets, Auto Loader, MERGE, Lakeflow Declarative Pipelines expectations, Unity Catalog grants, time travel and RESTORE). Your code is checked against the required patterns, with specific feedback |
| **SQL sandbox** | Free-form queries against the sample tables |
| **PySpark track** | 4 modules (DataFrame fundamentals, window and advanced functions, reading/writing and Delta, performance and internals), 10 lessons with "Try it" examples, 26 quiz questions |
| **PySpark exercises** | 15 exercises where your PySpark code **actually runs** in the browser and your `result` DataFrame is compared with the expected one, plus 3 syntax-checked Delta/I/O exercises |
| **PySpark sandbox** | A notebook-style Python session with `spark` and `display()` ready to use |

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
js/engine.js                DuckDB-WASM (sync build) + Pyodide loading, Arrow conversion
js/app.js                   router, views, progress, answer checking
py/pyspark_shim.py          PySpark-compatible DataFrame API that compiles to SQL on DuckDB
tests/                      pytest checks for the shim and every PySpark exercise
tools/build_artifact.py     single-page build for sandboxed hosts
```

## How PySpark runs in the browser

Python runs in [Pyodide](https://pyodide.org). `py/pyspark_shim.py` installs `pyspark`, `pyspark.sql.functions`, `pyspark.sql.window` and `pyspark.sql.types` modules whose DataFrames compile to SQL and run on the same DuckDB-WASM database as the SQL exercises. It aims to match Spark's results and names for the commonly used API (joins, aggregations, pivots, window functions, arrays and higher-order functions, dates, `fillna`/`dropna`, `show()`, `printSchema()`, temp views, `saveAsTable`). Features that need a cluster (file I/O, `DeltaTable`, streaming, RDDs, Python UDFs) raise a clear `NotAvailableInTrainer` error.

Run the tests with `pip install duckdb==1.1.1 pytest && pytest tests/` (needs Node.js).

## Adding content

- **Question**: add an object to `TRAINER.questions` with `domain`, `q`, `options`, `answer` (index of the correct option) and `explain`. Text wrapped in backticks is shown as inline code.
- **Lesson**: add an object to `TRAINER.lessons`. `body` is trusted HTML.
- **PySpark exercise**: `kind: "python"`, plus `starter` and `solution` that assign a DataFrame to `result`, optionally `ordered: true` and `requires: [{ re, msg }]`. Column names must match (case-insensitively).
- **SQL exercise**: `kind: "sql"`, plus `starter`, `solution` and optionally `ordered: true`. Column names are ignored, but column order and values must match. Numbers are compared to 4 decimal places.
- **Pattern exercise**: `kind: "pattern"`, `lang` (`"sql"` or `"python"`), and `checks: [{ re, msg, absent? }]`. Comments are stripped before checking. SQL checks are case-insensitive.

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
