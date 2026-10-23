// Hands-on exercises.
//  kind "sql":     runs in the browser on DuckDB-WASM. The learner's result set is
//                  compared with the solution's (column count and values; row order
//                  only when ordered: true).
//  kind "pattern": Spark-only syntax (Auto Loader, MERGE, pipelines, UC grants) that
//                  can't run in the browser. The code is checked against required patterns.

window.TRAINER = window.TRAINER || {};

// Sample retail dataset, loaded into DuckDB. One statement per entry.
TRAINER.datasetSql = [
  `CREATE OR REPLACE TABLE customers (customer_id INTEGER, name VARCHAR, email VARCHAR, country VARCHAR, signup_date DATE)`,
  `INSERT INTO customers VALUES
    (1,'Ava Patel','ava@example.com','US','2023-11-02'),
    (2,'Ben Okafor','ben@example.com','UK','2023-12-15'),
    (3,'Chen Li',NULL,'US','2024-01-07'),
    (4,'Dara Novak','dara@example.com','DE','2024-01-20'),
    (5,'Eli Moreau','eli@example.com','FR','2024-02-03'),
    (6,'Fatima Khan',NULL,'UK','2024-02-18'),
    (7,'Gus Romero','gus@example.com',NULL,'2024-03-01'),
    (8,'Hana Sato','hana@example.com','JP','2024-03-09'),
    (9,'Ivan Petrov','ivan@example.com','DE','2024-03-22'),
    (10,'Jo Kim','jo@example.com','US','2024-04-02')`,
  `CREATE OR REPLACE TABLE products (product_id INTEGER, product_name VARCHAR, category VARCHAR, price DOUBLE)`,
  `INSERT INTO products VALUES
    (101,'Spark Guide','Books',39.0),
    (102,'Delta Deep Dive','Books',45.0),
    (103,'Lakehouse Mug','Merch',12.5),
    (104,'Cluster Hoodie','Merch',55.0),
    (105,'Streaming Course','Courses',199.0),
    (106,'SQL Bootcamp','Courses',149.0),
    (107,'Sticker Pack','Merch',4.0)`,
  `CREATE OR REPLACE TABLE orders (order_id INTEGER, customer_id INTEGER, order_date DATE, status VARCHAR)`,
  `INSERT INTO orders VALUES
    (1001,1,'2024-02-10','COMPLETED'),
    (1002,2,'2024-02-14','COMPLETED'),
    (1003,1,'2024-03-02','COMPLETED'),
    (1004,3,'2024-03-05','CANCELLED'),
    (1005,4,'2024-03-11','COMPLETED'),
    (1006,5,'2024-03-18','PENDING'),
    (1007,2,'2024-03-25','COMPLETED'),
    (1008,8,'2024-04-01','COMPLETED'),
    (1009,9,'2024-04-03','COMPLETED'),
    (1010,1,'2024-04-12','COMPLETED'),
    (1011,4,'2024-04-20','CANCELLED'),
    (1012,10,'2024-04-28','COMPLETED')`,
  `CREATE OR REPLACE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER)`,
  `INSERT INTO order_items VALUES
    (1001,101,1),(1001,103,2),
    (1002,105,1),
    (1003,102,1),(1003,107,5),
    (1004,104,1),
    (1005,106,1),(1005,103,1),
    (1006,101,2),
    (1007,104,1),(1007,107,3),
    (1008,105,1),(1008,101,1),
    (1009,103,4),
    (1010,106,1),
    (1011,102,2),
    (1012,101,1),(1012,102,1),(1012,107,10)`,
  `CREATE OR REPLACE TABLE bronze_events (event_id VARCHAR, customer_id INTEGER, event_type VARCHAR, event_ts TIMESTAMP, ingest_ts TIMESTAMP)`,
  `INSERT INTO bronze_events VALUES
    ('e1',1,'page_view','2024-04-01 09:00:00','2024-04-01 09:05:00'),
    ('e2',1,'add_to_cart','2024-04-01 09:02:00','2024-04-01 09:05:00'),
    ('e2',1,'add_to_cart','2024-04-01 09:02:00','2024-04-01 10:05:00'),
    ('e3',2,'page_view','2024-04-01 11:15:00','2024-04-01 11:20:00'),
    ('e4',3,'purchase','2024-04-02 08:30:00','2024-04-02 08:35:00'),
    ('e4',3,'purchase','2024-04-02 08:30:00','2024-04-02 09:35:00'),
    ('e4',3,'purchase','2024-04-02 08:30:00','2024-04-02 10:35:00'),
    ('e5',NULL,'page_view','2024-04-02 12:00:00','2024-04-02 12:05:00'),
    ('e6',4,'page_view','2024-04-03 14:40:00','2024-04-03 14:45:00'),
    ('e7',4,'purchase','2024-04-03 14:55:00','2024-04-03 15:00:00')`
];

TRAINER.datasetDocs = [
  { table: "customers", cols: "customer_id, name, email, country, signup_date", note: "10 rows. Some emails and one country are NULL." },
  { table: "products", cols: "product_id, product_name, category, price", note: "7 products in Books, Merch and Courses." },
  { table: "orders", cols: "order_id, customer_id, order_date, status", note: "12 orders. status is COMPLETED, CANCELLED or PENDING." },
  { table: "order_items", cols: "order_id, product_id, quantity", note: "Line items. Revenue is quantity * price." },
  { table: "bronze_events", cols: "event_id, customer_id, event_type, event_ts, ingest_ts", note: "Raw events with duplicates: the same event_id ingested more than once." }
];

TRAINER.exercises = [
  // ---------------------------------------------------------------- SQL (runnable)
  {
    id: "sql-filter", kind: "sql", domain: "transform", level: "Easy",
    title: "Filter completed March orders",
    prompt: "Return <code>order_id</code> and <code>order_date</code> for every order with status <code>'COMPLETED'</code> placed in <strong>March 2024</strong>, sorted by <code>order_date</code>.",
    starter: "SELECT order_id, order_date\nFROM orders\nWHERE -- your conditions here\nORDER BY order_date;",
    solution: "SELECT order_id, order_date\nFROM orders\nWHERE status = 'COMPLETED'\n  AND order_date >= DATE '2024-03-01'\n  AND order_date <  DATE '2024-04-01'\nORDER BY order_date;",
    ordered: true,
    hints: ["Combine two conditions with AND.", "A half-open date range (>= first day, < first day of the next month) avoids end-of-month mistakes."]
  },
  {
    id: "sql-having", kind: "sql", domain: "transform", level: "Easy",
    title: "Countries with at least two customers",
    prompt: "For each <code>country</code> with <strong>two or more</strong> customers, return the country and the number of customers as <code>num_customers</code>. Leave out the NULL country.",
    starter: "SELECT country, count(*) AS num_customers\nFROM customers\n-- ...",
    solution: "SELECT country, count(*) AS num_customers\nFROM customers\nWHERE country IS NOT NULL\nGROUP BY country\nHAVING count(*) >= 2;",
    hints: ["Filter rows with WHERE before grouping, and filter groups with HAVING after.", "Use country IS NOT NULL. country != NULL is never true."]
  },
  {
    id: "sql-nulls", kind: "sql", domain: "transform", level: "Easy",
    title: "count(*) vs count(col)",
    prompt: "Return one row with three columns: <code>total_customers</code> (all rows), <code>with_email</code> (customers whose email isn't NULL), and <code>missing_email</code> (customers with a NULL email).",
    starter: "SELECT\n  count(*) AS total_customers,\n  -- with_email,\n  -- missing_email\nFROM customers;",
    solution: "SELECT\n  count(*) AS total_customers,\n  count(email) AS with_email,\n  count_if(email IS NULL) AS missing_email\nFROM customers;",
    hints: ["count(col) skips NULLs.", "count_if(condition) works in Databricks and here. sum(CASE WHEN ... THEN 1 ELSE 0 END) works anywhere."]
  },
  {
    id: "sql-revenue-category", kind: "sql", domain: "transform", level: "Medium",
    title: "Revenue by category (completed orders only)",
    prompt: "Calculate total revenue (<code>quantity * price</code>) per product <code>category</code>, counting only <code>COMPLETED</code> orders. Return <code>category</code> and <code>revenue</code>, highest revenue first.",
    starter: "SELECT p.category, sum(oi.quantity * p.price) AS revenue\nFROM order_items oi\n-- join orders and products ...\n",
    solution: "SELECT p.category, sum(oi.quantity * p.price) AS revenue\nFROM order_items oi\nJOIN orders o   ON oi.order_id = o.order_id\nJOIN products p ON oi.product_id = p.product_id\nWHERE o.status = 'COMPLETED'\nGROUP BY p.category\nORDER BY revenue DESC;",
    ordered: true,
    hints: ["You need three tables: order_items for quantity, products for price and category, and orders for status.", "Filter on o.status before you aggregate."]
  },
  {
    id: "sql-dedup", kind: "sql", domain: "production", level: "Medium",
    title: "Bronze → Silver: deduplicate events",
    prompt: "<code>bronze_events</code> has the same <code>event_id</code> ingested more than once. Build the silver version: return <strong>one row per event_id</strong> (all columns), keeping the row with the <strong>latest</strong> <code>ingest_ts</code>.",
    starter: "SELECT *\nFROM bronze_events\n-- keep only the latest ingest per event_id\n",
    solution: "SELECT *\nFROM bronze_events\nQUALIFY row_number() OVER (PARTITION BY event_id ORDER BY ingest_ts DESC) = 1;",
    hints: ["SELECT DISTINCT * won't work, because the duplicate rows have different ingest_ts values.", "Use row_number() OVER (PARTITION BY event_id ORDER BY ingest_ts DESC). Filter on it with QUALIFY, or in an outer query."]
  },
  {
    id: "sql-anti", kind: "sql", domain: "transform", level: "Medium",
    title: "Customers who never ordered",
    prompt: "Return <code>customer_id</code> and <code>name</code> for customers who have <strong>never placed any order</strong>, whatever its status.",
    starter: "SELECT c.customer_id, c.name\nFROM customers c\n-- ...",
    solution: "SELECT c.customer_id, c.name\nFROM customers c\nWHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id);",
    hints: ["This is an anti-join. In Spark SQL you can write LEFT ANTI JOIN.", "Portable options: NOT EXISTS (...), or a LEFT JOIN and then WHERE o.order_id IS NULL."]
  },
  {
    id: "sql-top-product", kind: "sql", domain: "transform", level: "Hard",
    title: "Best-selling product per category",
    prompt: "Using <code>COMPLETED</code> orders only, find the product with the <strong>highest total quantity sold</strong> in each category. Return <code>category</code>, <code>product_name</code> and <code>total_qty</code>. If products tie, return all of them.",
    starter: "WITH qty AS (\n  SELECT p.category, p.product_name, sum(oi.quantity) AS total_qty\n  FROM order_items oi\n  -- joins and filter ...\n  GROUP BY p.category, p.product_name\n)\nSELECT ...\n",
    solution: "WITH qty AS (\n  SELECT p.category, p.product_name, sum(oi.quantity) AS total_qty\n  FROM order_items oi\n  JOIN orders o   ON oi.order_id = o.order_id\n  JOIN products p ON oi.product_id = p.product_id\n  WHERE o.status = 'COMPLETED'\n  GROUP BY p.category, p.product_name\n)\nSELECT category, product_name, total_qty\nFROM qty\nQUALIFY rank() OVER (PARTITION BY category ORDER BY total_qty DESC) = 1;",
    hints: ["First aggregate quantity per product in a CTE.", "Then rank within each category with a window function and keep rank 1. Use rank() rather than row_number() so ties are kept."]
  },
  {
    id: "sql-tiers", kind: "sql", domain: "transform", level: "Hard",
    title: "Customer spend tiers",
    prompt: "For <strong>every</strong> customer (including those with no completed orders), return <code>customer_id</code>, <code>total_spend</code> (completed orders only, 0 if none) and <code>tier</code>: <code>'GOLD'</code> if spend ≥ 200, <code>'SILVER'</code> if ≥ 50, otherwise <code>'BRONZE'</code>.",
    starter: "WITH spend AS (\n  -- total completed spend per customer\n)\nSELECT c.customer_id, ...\nFROM customers c\nLEFT JOIN spend s ON ...",
    solution: "WITH spend AS (\n  SELECT o.customer_id, sum(oi.quantity * p.price) AS amt\n  FROM orders o\n  JOIN order_items oi ON o.order_id = oi.order_id\n  JOIN products p     ON oi.product_id = p.product_id\n  WHERE o.status = 'COMPLETED'\n  GROUP BY o.customer_id\n)\nSELECT c.customer_id,\n       coalesce(s.amt, 0) AS total_spend,\n       CASE WHEN coalesce(s.amt, 0) >= 200 THEN 'GOLD'\n            WHEN coalesce(s.amt, 0) >= 50  THEN 'SILVER'\n            ELSE 'BRONZE' END AS tier\nFROM customers c\nLEFT JOIN spend s ON c.customer_id = s.customer_id;",
    hints: ["A LEFT JOIN from customers keeps people without orders. Their spend comes back as NULL.", "Wrap it in coalesce(..., 0), then use a CASE WHEN with the highest threshold first."]
  },
  {
    id: "sql-gold-monthly", kind: "sql", domain: "production", level: "Medium",
    title: "Gold table: monthly revenue",
    prompt: "Build a gold aggregate: for each month, return <code>month</code> (the first day of the month, as a DATE), <code>orders</code> (number of distinct completed orders) and <code>revenue</code>. Sort by month.",
    starter: "SELECT\n  CAST(date_trunc('month', o.order_date) AS DATE) AS month,\n  -- orders, revenue\nFROM orders o\n-- ...",
    solution: "SELECT\n  CAST(date_trunc('month', o.order_date) AS DATE) AS month,\n  count(DISTINCT o.order_id) AS orders,\n  sum(oi.quantity * p.price) AS revenue\nFROM orders o\nJOIN order_items oi ON o.order_id = oi.order_id\nJOIN products p     ON oi.product_id = p.product_id\nWHERE o.status = 'COMPLETED'\nGROUP BY 1\nORDER BY 1;",
    ordered: true,
    hints: ["Joining to order_items repeats each order once per line item, so use count(DISTINCT o.order_id).", "date_trunc('month', d) works in both Databricks and DuckDB."]
  },

  // ---------------------------------------------------------------- Spark patterns
  {
    id: "pat-notebook", kind: "pattern", domain: "platform", level: "Easy", lang: "python",
    title: "Parameterize a notebook",
    prompt: "This notebook runs as a job task. Complete it so that it (1) runs the shared notebook <code>./includes/setup</code> <strong>inline</strong>, so its helper functions are available, (2) reads the job parameter <code>run_date</code> from a widget, and (3) registers the result as a temporary view called <code>orders_for_day</code> that later <code>%sql</code> cells can query.",
    starter: "# Cell 1\n____ ./includes/setup\n\n# Cell 2\ndbutils.widgets.text(\"run_date\", \"2024-01-01\")\nrun_date = ____\n\ndf = spark.sql(\n    \"SELECT * FROM main.sales.orders WHERE order_date = :run_date\",\n    args={\"run_date\": run_date})\ndf.____(\"orders_for_day\")",
    solution: "# Cell 1\n%run ./includes/setup\n\n# Cell 2\ndbutils.widgets.text(\"run_date\", \"2024-01-01\")\nrun_date = dbutils.widgets.get(\"run_date\")\n\ndf = spark.sql(\n    \"SELECT * FROM main.sales.orders WHERE order_date = :run_date\",\n    args={\"run_date\": run_date})\ndf.createOrReplaceTempView(\"orders_for_day\")",
    checks: [
      { re: "^\\s*%run\\s+\\./includes/setup", msg: "Use %run ./includes/setup at the start of a cell. It runs the notebook inline and shares its definitions." },
      { re: "run_date\\s*=\\s*dbutils\\.widgets\\.get\\(\\s*['\"]run_date['\"]\\s*\\)", msg: "Read the parameter with dbutils.widgets.get(\"run_date\")." },
      { re: "\\.createOrReplaceTempView\\(\\s*['\"]orders_for_day['\"]\\s*\\)", msg: "Register the DataFrame with df.createOrReplaceTempView(\"orders_for_day\")." }
    ],
    hints: ["dbutils.notebook.run() would start a separate run, so its functions wouldn't be shared. You want the magic command.", "Job parameters reach notebooks as widgets."]
  },
  {
    id: "pat-autoloader", kind: "pattern", domain: "ingest", level: "Medium", lang: "python",
    title: "Auto Loader into a bronze table",
    prompt: "Complete the PySpark code so that it incrementally ingests <strong>JSON</strong> files from <code>/Volumes/main/raw/landing/orders/</code> with <strong>Auto Loader</strong>, stores the schema at <code>/Volumes/main/raw/_schemas/orders</code>, uses a checkpoint, processes all available files <strong>and then stops</strong>, and writes to <code>main.bronze.orders</code>.",
    starter: "(spark.readStream\n   .format(\"____\")\n   .option(\"cloudFiles.format\", \"____\")\n   .option(\"____\", \"/Volumes/main/raw/_schemas/orders\")\n   .load(\"/Volumes/main/raw/landing/orders/\")\n .writeStream\n   .option(\"____\", \"/Volumes/main/raw/_checkpoints/orders\")\n   .trigger(____)\n   .toTable(\"main.bronze.orders\"))",
    solution: "(spark.readStream\n   .format(\"cloudFiles\")\n   .option(\"cloudFiles.format\", \"json\")\n   .option(\"cloudFiles.schemaLocation\", \"/Volumes/main/raw/_schemas/orders\")\n   .load(\"/Volumes/main/raw/landing/orders/\")\n .writeStream\n   .option(\"checkpointLocation\", \"/Volumes/main/raw/_checkpoints/orders\")\n   .trigger(availableNow=True)\n   .toTable(\"main.bronze.orders\"))",
    checks: [
      { re: "readStream", msg: "Auto Loader is a streaming source: start with spark.readStream." },
      { re: "\\.format\\(\\s*['\"]cloudFiles['\"]\\s*\\)", msg: "The Auto Loader source format is \"cloudFiles\"." },
      { re: "['\"]cloudFiles\\.format['\"]\\s*,\\s*['\"]json['\"]", msg: "Set cloudFiles.format to \"json\"." },
      { re: "['\"]cloudFiles\\.schemaLocation['\"]", msg: "Use the cloudFiles.schemaLocation option to store the inferred schema." },
      { re: "['\"]checkpointLocation['\"]", msg: "The writer needs a checkpointLocation option." },
      { re: "availableNow\\s*=\\s*True", msg: "To process everything available and then stop, use trigger(availableNow=True)." },
      { re: "toTable\\(\\s*['\"]main\\.bronze\\.orders['\"]", msg: "Write to the table main.bronze.orders with .toTable()." }
    ],
    hints: ["The format name is the Auto Loader 'cloud files' source.", "The trigger that runs once over the backlog and stops is availableNow."]
  },
  {
    id: "pat-merge", kind: "pattern", domain: "transform", level: "Medium", lang: "sql",
    title: "Upsert with MERGE INTO",
    prompt: "Write a Spark SQL <code>MERGE</code> that upserts <code>updates</code> into <code>main.silver.customers</code> on <code>customer_id</code>: <strong>delete</strong> matched rows where <code>s.is_deleted</code> is true, <strong>update</strong> other matches with all columns, and <strong>insert</strong> new customers.",
    starter: "MERGE INTO main.silver.customers AS t\nUSING updates AS s\nON ____\n-- WHEN ... clauses\n",
    solution: "MERGE INTO main.silver.customers AS t\nUSING updates AS s\nON t.customer_id = s.customer_id\nWHEN MATCHED AND s.is_deleted THEN DELETE\nWHEN MATCHED THEN UPDATE SET *\nWHEN NOT MATCHED THEN INSERT *;",
    checks: [
      { re: "MERGE\\s+INTO\\s+main\\.silver\\.customers", msg: "Start with MERGE INTO main.silver.customers." },
      { re: "USING\\s+updates", msg: "The source is USING updates." },
      { re: "ON\\s+(t\\.customer_id\\s*=\\s*s\\.customer_id|s\\.customer_id\\s*=\\s*t\\.customer_id)", msg: "Match on t.customer_id = s.customer_id." },
      { re: "WHEN\\s+MATCHED\\s+AND\\s+s\\.is_deleted(\\s*=\\s*true)?\\s+THEN\\s+DELETE", msg: "Add WHEN MATCHED AND s.is_deleted THEN DELETE." },
      { re: "WHEN\\s+MATCHED\\s+THEN\\s+UPDATE\\s+SET\\s+\\*", msg: "Add WHEN MATCHED THEN UPDATE SET *." },
      { re: "WHEN\\s+NOT\\s+MATCHED\\s+THEN\\s+INSERT\\s+\\*", msg: "Add WHEN NOT MATCHED THEN INSERT *." },
      { re: "MATCHED\\s+AND\\s+s\\.is_deleted[\\s\\S]*WHEN\\s+MATCHED\\s+THEN\\s+UPDATE", msg: "Put the conditional DELETE clause before the unconditional UPDATE. MATCHED clauses are evaluated in order." }
    ],
    hints: ["Clauses are evaluated in order, so the more specific WHEN MATCHED AND ... goes first.", "UPDATE SET * and INSERT * copy all columns by name."]
  },
  {
    id: "pat-pipeline", kind: "pattern", domain: "production", level: "Medium", lang: "sql",
    title: "Declarative pipeline silver table with expectations",
    prompt: "Write a Lakeflow Declarative Pipelines (DLT) SQL statement that creates a <strong>streaming table</strong> <code>orders_silver</code> from <code>orders_bronze</code>, <strong>drops</strong> rows where <code>order_id</code> is NULL (constraint <code>valid_id</code>), and <strong>fails the update</strong> if <code>amount &lt; 0</code> (constraint <code>valid_amount</code>).",
    starter: "CREATE OR REFRESH ____ orders_silver (\n  CONSTRAINT valid_id EXPECT (____) ON VIOLATION ____,\n  CONSTRAINT valid_amount EXPECT (____) ON VIOLATION ____\n)\nAS SELECT * FROM ____(orders_bronze);",
    solution: "CREATE OR REFRESH STREAMING TABLE orders_silver (\n  CONSTRAINT valid_id EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW,\n  CONSTRAINT valid_amount EXPECT (amount >= 0) ON VIOLATION FAIL UPDATE\n)\nAS SELECT * FROM STREAM(orders_bronze);",
    checks: [
      { re: "CREATE\\s+OR\\s+REFRESH\\s+STREAMING\\s+TABLE\\s+orders_silver", msg: "Start with CREATE OR REFRESH STREAMING TABLE orders_silver." },
      { re: "CONSTRAINT\\s+valid_id\\s+EXPECT\\s*\\(\\s*order_id\\s+IS\\s+NOT\\s+NULL\\s*\\)\\s*ON\\s+VIOLATION\\s+DROP\\s+ROW", msg: "valid_id should be EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW." },
      { re: "CONSTRAINT\\s+valid_amount\\s+EXPECT\\s*\\(\\s*amount\\s*>=\\s*0\\s*\\)\\s*ON\\s+VIOLATION\\s+FAIL\\s+UPDATE", msg: "valid_amount should be EXPECT (amount >= 0) ON VIOLATION FAIL UPDATE." },
      { re: "FROM\\s+STREAM\\s*\\(\\s*orders_bronze\\s*\\)", msg: "Read the source incrementally with FROM STREAM(orders_bronze)." }
    ],
    hints: ["The expectation states what valid data looks like, so for the amount rule write amount >= 0.", "The three ON VIOLATION options are none (keep the row), DROP ROW and FAIL UPDATE."]
  },
  {
    id: "pat-grants", kind: "pattern", domain: "governance", level: "Easy", lang: "sql",
    title: "Unity Catalog grants for analysts",
    prompt: "Write the minimum <code>GRANT</code> statements so the group <code>analysts</code> can query the table <code>main.sales.orders</code>.",
    starter: "GRANT ____ ON CATALOG main TO `analysts`;\n-- ...",
    solution: "GRANT USE CATALOG ON CATALOG main TO `analysts`;\nGRANT USE SCHEMA ON SCHEMA main.sales TO `analysts`;\nGRANT SELECT ON TABLE main.sales.orders TO `analysts`;",
    checks: [
      { re: "GRANT\\s+USE\\s+CATALOG\\s+ON\\s+CATALOG\\s+main\\s+TO\\s+`?analysts`?", msg: "Grant USE CATALOG ON CATALOG main TO `analysts`." },
      { re: "GRANT\\s+USE\\s+SCHEMA\\s+ON\\s+SCHEMA\\s+main\\.sales\\s+TO\\s+`?analysts`?", msg: "Grant USE SCHEMA ON SCHEMA main.sales TO `analysts`." },
      { re: "GRANT\\s+SELECT\\s+ON\\s+(TABLE\\s+)?main\\.sales\\.orders\\s+TO\\s+`?analysts`?", msg: "Grant SELECT ON TABLE main.sales.orders TO `analysts`." },
      { re: "ALL\\s+PRIVILEGES", absent: true, msg: "Don't use ALL PRIVILEGES. Grant only what's needed (least privilege)." }
    ],
    hints: ["Reading a table needs a privilege at each level of the three-level namespace.", "USE CATALOG, then USE SCHEMA, then SELECT."]
  },
  {
    id: "pat-timetravel", kind: "pattern", domain: "transform", level: "Easy", lang: "sql",
    title: "Recover from a bad write",
    prompt: "Someone ran a bad <code>DELETE</code> on <code>main.silver.orders</code>. Write three statements: (1) show the table's version history, (2) query the table as of <strong>version 8</strong> to check the data, (3) restore the table to version 8.",
    starter: "-- 1. history\n\n-- 2. query version 8\n\n-- 3. restore\n",
    solution: "DESCRIBE HISTORY main.silver.orders;\nSELECT * FROM main.silver.orders VERSION AS OF 8;\nRESTORE TABLE main.silver.orders TO VERSION AS OF 8;",
    checks: [
      { re: "DESCRIBE\\s+HISTORY\\s+main\\.silver\\.orders", msg: "Use DESCRIBE HISTORY main.silver.orders to list versions." },
      { re: "SELECT[\\s\\S]+FROM\\s+main\\.silver\\.orders(\\s+VERSION\\s+AS\\s+OF\\s+8|@v8)", msg: "Query an old version with ... FROM main.silver.orders VERSION AS OF 8 (or @v8)." },
      { re: "RESTORE\\s+(TABLE\\s+)?main\\.silver\\.orders\\s+TO\\s+VERSION\\s+AS\\s+OF\\s+8", msg: "Use RESTORE TABLE main.silver.orders TO VERSION AS OF 8." }
    ],
    hints: ["Time travel syntax: VERSION AS OF n, or TIMESTAMP AS OF 'ts'.", "RESTORE is recorded as a new version, so you can undo it too."]
  }
];
