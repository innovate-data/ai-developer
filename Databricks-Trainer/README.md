# Databricks Data Engineer Associate Trainer

A static, single-page web app for preparing for the **Databricks Certified Data Engineer Associate** exam. There's no backend and no build step. Progress is saved in the browser's `localStorage`.

## What's inside

| | |
|---|---|
| **Lessons** | 13 short lessons across the 5 exam domains: Platform, Ingestion, Transformations, Production pipelines, Governance |
| **Quizzes** | 46 multiple-choice questions with explanations. There's a quiz per domain (70% counts as passing) and a 20-question mixed practice quiz with a per-domain breakdown |
| **SQL exercises** | 9 exercises that run **real SQL in your browser** on [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) against a small retail dataset. Your result set is compared with the expected one |
| **Spark pattern exercises** | 6 exercises for syntax that can't run in a browser (notebooks and widgets, Auto Loader, MERGE, Lakeflow Declarative Pipelines expectations, Unity Catalog grants, time travel and RESTORE). Your code is checked against the required patterns, with specific feedback |
| **SQL sandbox** | Free-form queries against the sample tables |

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
js/app.js                   router, views, progress, DuckDB engine, answer checking
```

## Adding content

- **Question**: add an object to `TRAINER.questions` with `domain`, `q`, `options`, `answer` (index of the correct option) and `explain`. Text wrapped in backticks is shown as inline code.
- **Lesson**: add an object to `TRAINER.lessons`. `body` is trusted HTML.
- **SQL exercise**: `kind: "sql"`, plus `starter`, `solution` and optionally `ordered: true`. Column names are ignored, but column order and values must match. Numbers are compared to 4 decimal places.
- **Pattern exercise**: `kind: "pattern"`, `lang` (`"sql"` or `"python"`), and `checks: [{ re, msg, absent? }]`. Comments are stripped before checking. SQL checks are case-insensitive.

## Notes

- The SQL exercises use SQL that works in both DuckDB and Databricks (ANSI SQL plus `QUALIFY`, `count_if`, `date_trunc`). Spark-only features are covered by the pattern exercises.
- The content follows the public exam guide topics as of 2025/2026, including newer names such as Lakeflow Declarative Pipelines (formerly DLT) and Lakeflow Jobs. Check the [official exam page](https://www.databricks.com/learn/certification/data-engineer-associate) for the current outline and weights.
