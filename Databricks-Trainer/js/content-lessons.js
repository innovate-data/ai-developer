// Domains and lessons for the Databricks Certified Data Engineer Associate trainer.
// Lesson bodies are trusted, hand-written HTML.

window.TRAINER = window.TRAINER || {};

TRAINER.domains = [
  { id: "platform", title: "Databricks Intelligence Platform", short: "Platform",
    summary: "Lakehouse architecture, workspace, compute choices, notebooks and Git folders." },
  { id: "ingest", title: "Development & Ingestion", short: "Ingestion",
    summary: "Reading files, CTAS, COPY INTO, Auto Loader and Lakeflow Connect." },
  { id: "transform", title: "Data Processing & Transformations", short: "Transform",
    summary: "Spark SQL and PySpark transformations, Delta Lake operations and table maintenance." },
  { id: "production", title: "Productionizing Data Pipelines", short: "Production",
    summary: "Medallion architecture, Structured Streaming, Lakeflow Declarative Pipelines, Jobs and Asset Bundles." },
  { id: "governance", title: "Data Governance & Quality", short: "Governance",
    summary: "Unity Catalog, privileges, managed vs external tables, lineage and Delta Sharing." }
];

TRAINER.lessons = [
  // ---------------------------------------------------------------- platform
  {
    id: "lakehouse", domain: "platform", title: "The Lakehouse and Delta Lake", minutes: 8,
    body: `
<p>A <strong>lakehouse</strong> combines the cheap, open storage of a data lake with the reliability and performance features of a data warehouse. On Databricks, the piece that makes this possible is <strong>Delta Lake</strong>.</p>

<h3>What Delta Lake adds on top of Parquet</h3>
<ul>
  <li><strong>ACID transactions</strong>: every write is atomic. Readers never see half-written data.</li>
  <li><strong>Transaction log</strong>: a <code>_delta_log/</code> folder of ordered JSON commit files (with Parquet checkpoint files written periodically) that records every change to the table.</li>
  <li><strong>Time travel</strong>: because the log keeps history, you can query older versions of a table.</li>
  <li><strong>Schema enforcement and evolution</strong>: writes that don't match the table schema are rejected unless you explicitly allow evolution.</li>
  <li><strong>DML</strong>: <code>UPDATE</code>, <code>DELETE</code> and <code>MERGE</code> on files in cloud object storage.</li>
</ul>
<p>The data itself is stored as ordinary <strong>Parquet</strong> files. Delta is the default table format on Databricks, so <code>CREATE TABLE t (...)</code> creates a Delta table unless you say otherwise.</p>

<h3>Control plane vs. compute plane</h3>
<ul>
  <li>The <strong>control plane</strong> is run by Databricks: the web UI, notebooks, job scheduler, cluster manager and Unity Catalog services.</li>
  <li>The <strong>compute plane</strong> is where data is processed. For classic compute it runs in <em>your</em> cloud account; for <strong>serverless</strong> compute it runs in Databricks' account.</li>
  <li>Your table data lives in <strong>cloud object storage</strong> (S3, ADLS, GCS), not in the control plane.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> If a question asks where customer data is stored or where classic clusters run, the answer is your cloud account. The control plane holds metadata and code, not your table data.</div>

<h3>Photon</h3>
<p><strong>Photon</strong> is Databricks' vectorized query engine written in C++. It speeds up SQL and DataFrame workloads with no code changes. It's on by default for SQL warehouses and serverless, and optional for classic clusters.</p>
`
  },
  {
    id: "compute", domain: "platform", title: "Compute: Clusters, Warehouses and Serverless", minutes: 8,
    body: `
<p>Picking the right compute comes up a lot on the exam. Here are the main options.</p>
<table class="ref">
  <tr><th>Compute</th><th>Use it for</th><th>Notes</th></tr>
  <tr><td><strong>All-purpose cluster</strong></td><td>Interactive development in notebooks</td><td>Shared by users, started and stopped manually, can auto-terminate after inactivity. More expensive per DBU.</td></tr>
  <tr><td><strong>Job cluster</strong></td><td>Scheduled, automated workloads</td><td>Created when a job run starts and terminated when it ends. Cheaper than all-purpose.</td></tr>
  <tr><td><strong>SQL warehouse</strong></td><td>SQL queries, dashboards, BI tools</td><td>Classic, Pro or Serverless. Photon enabled.</td></tr>
  <tr><td><strong>Serverless compute</strong></td><td>Notebooks, jobs and pipelines without managing clusters</td><td>Starts in seconds, managed and auto-scaled by Databricks.</td></tr>
</table>

<h3>Cluster settings to know</h3>
<ul>
  <li><strong>Databricks Runtime (DBR)</strong>: the Spark version plus libraries. <em>ML</em> runtimes add ML libraries. <em>LTS</em> versions are supported longer.</li>
  <li><strong>Autoscaling</strong>: set a minimum and maximum number of workers.</li>
  <li><strong>Auto termination</strong>: shuts the cluster down after N idle minutes to save cost.</li>
  <li><strong>Pools</strong>: keep idle, ready-to-use instances so clusters start and scale faster.</li>
  <li><strong>Access mode</strong>: <em>Standard</em> (formerly Shared) and <em>Dedicated</em> (formerly Single user) both support Unity Catalog.</li>
  <li><strong>Single node</strong>: driver only, no workers. Good for small data and lightweight ML.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> Running a nightly production job on an all-purpose cluster is a classic wrong answer. Use a job cluster or serverless jobs compute.</div>

<h3>Restarting vs. terminating</h3>
<p>Restarting a cluster clears its state (cached data, Python variables, notebook-installed libraries). Terminating keeps the cluster configuration so you can start it again later. Deleting removes the configuration.</p>
`
  },
  {
    id: "notebooks", domain: "platform", title: "Notebooks, Magic Commands and Git Folders", minutes: 7,
    body: `
<p>Databricks notebooks support several languages in one notebook. Each notebook has a <strong>default language</strong>, and you can switch per cell with a <strong>magic command</strong>.</p>
<table class="ref">
  <tr><th>Magic</th><th>What it does</th></tr>
  <tr><td><code>%python</code>, <code>%sql</code>, <code>%scala</code>, <code>%r</code></td><td>Run this cell in that language</td></tr>
  <tr><td><code>%md</code></td><td>Render the cell as Markdown</td></tr>
  <tr><td><code>%run ./other_notebook</code></td><td>Run another notebook <em>inline</em>, so its functions and variables become available in this one</td></tr>
  <tr><td><code>%pip install pkg</code></td><td>Install a Python library scoped to this notebook session</td></tr>
  <tr><td><code>%sh</code></td><td>Run shell commands on the driver node</td></tr>
  <tr><td><code>%fs ls /path</code></td><td>Shortcut for <code>dbutils.fs</code> commands</td></tr>
</table>

<h3>dbutils</h3>
<pre><code>dbutils.fs.ls("/Volumes/main/raw/landing")        # list files
dbutils.widgets.text("run_date", "2024-01-01")     # create a notebook parameter
run_date = dbutils.widgets.get("run_date")         # read the parameter
dbutils.notebook.run("./child", 600, {"x": "1"})   # run a notebook as a separate job, with timeout</code></pre>
<p><code>%run</code> shares scope with the caller. <code>dbutils.notebook.run()</code> starts the child as a separate run, passes parameters, and gets back a string through <code>dbutils.notebook.exit(value)</code>.</p>

<h3>Running SQL from Python</h3>
<pre><code>df = spark.sql("SELECT * FROM main.sales.orders WHERE status = 'COMPLETED'")
df.createOrReplaceTempView("completed_orders")   # now queryable from %sql cells</code></pre>

<h3>Git folders (formerly Repos)</h3>
<ul>
  <li>Clone a remote Git repo (GitHub, GitLab, Azure DevOps, ...) into the workspace.</li>
  <li>From the UI you can create branches, pull, commit, push, and resolve merge conflicts.</li>
  <li>For CI/CD, merges and pull request reviews happen in your Git provider, not inside Databricks.</li>
</ul>
`
  },

  // ---------------------------------------------------------------- ingest
  {
    id: "read-files", domain: "ingest", title: "Querying Files and Creating Tables", minutes: 9,
    body: `
<p>Spark SQL can query files directly, with no table needed. Put the format before the path in backticks:</p>
<pre><code>SELECT * FROM json.&#96;/Volumes/main/raw/landing/events/&#96;;
SELECT * FROM parquet.&#96;/Volumes/main/raw/landing/orders.parquet&#96;;
SELECT * FROM text.&#96;/Volumes/main/raw/landing/logs/&#96;;          -- one row per line
SELECT * FROM binaryFile.&#96;/Volumes/main/raw/images/&#96;;       -- path, length, content</code></pre>
<p>For CSV, or when you need options such as a header row or delimiter, use <code>read_files</code>:</p>
<pre><code>SELECT * FROM read_files(
  '/Volumes/main/raw/landing/customers/',
  format => 'csv', header => true, delimiter => ';'
);</code></pre>

<h3>CTAS: CREATE TABLE AS SELECT</h3>
<pre><code>CREATE OR REPLACE TABLE main.bronze.events AS
SELECT *, current_timestamp() AS ingest_ts
FROM json.&#96;/Volumes/main/raw/landing/events/&#96;;</code></pre>
<ul>
  <li>CTAS <strong>infers the schema</strong> from the query. You can't declare column types in a CTAS.</li>
  <li>It is a one-time load. Running it again reprocesses all files.</li>
</ul>

<h3>Overwrite vs. append</h3>
<table class="ref">
  <tr><th>Statement</th><th>Behaviour</th></tr>
  <tr><td><code>CREATE OR REPLACE TABLE ... AS</code></td><td>Replaces the table completely. The schema can change. History is kept, so time travel still works.</td></tr>
  <tr><td><code>INSERT OVERWRITE t SELECT ...</code></td><td>Replaces the data only. The new data must match the existing schema.</td></tr>
  <tr><td><code>INSERT INTO t SELECT ...</code></td><td>Appends rows. Running it twice creates duplicates.</td></tr>
</table>

<h3>Views</h3>
<ul>
  <li><strong>View</strong>: stored in the catalog and available to anyone with permission.</li>
  <li><strong>Temporary view</strong>: exists only in the current Spark session.</li>
  <li><strong>Global temporary view</strong>: shared across notebooks on the same cluster. Query it through the <code>global_temp</code> schema.</li>
</ul>
`
  },
  {
    id: "copy-into", domain: "ingest", title: "Incremental Loads: COPY INTO and Auto Loader", minutes: 10,
    body: `
<p>Incremental ingestion means loading only <em>new</em> files on each run. There are two built-in tools for it.</p>

<h3>COPY INTO</h3>
<pre><code>COPY INTO main.bronze.orders
FROM '/Volumes/main/raw/landing/orders/'
FILEFORMAT = JSON
COPY_OPTIONS ('mergeSchema' = 'true');</code></pre>
<ul>
  <li><strong>Idempotent</strong>: it remembers which files it has loaded and skips them on later runs.</li>
  <li>Simple SQL. Works best for thousands of files, not millions.</li>
</ul>

<h3>Auto Loader (cloudFiles)</h3>
<pre><code>(spark.readStream
   .format("cloudFiles")
   .option("cloudFiles.format", "json")
   .option("cloudFiles.schemaLocation", "/Volumes/main/raw/_schemas/orders")
   .load("/Volumes/main/raw/landing/orders/")
 .writeStream
   .option("checkpointLocation", "/Volumes/main/raw/_checkpoints/orders")
   .trigger(availableNow=True)
   .toTable("main.bronze.orders"))</code></pre>
<ul>
  <li>Built on <strong>Structured Streaming</strong>. Scales to millions of files and can use file notification mode instead of directory listing.</li>
  <li><code>cloudFiles.schemaLocation</code> stores the inferred schema and tracks schema changes over time.</li>
  <li>The <strong>checkpoint</strong> records which files have been processed, which gives exactly-once ingestion.</li>
  <li>Data that doesn't fit the schema goes into the <code>_rescued_data</code> column instead of being lost.</li>
  <li>The default <code>cloudFiles.schemaEvolutionMode</code> is <code>addNewColumns</code>: the stream stops when a new column appears and picks it up on restart.</li>
</ul>
<p>In SQL, Lakeflow Declarative Pipelines use Auto Loader through <code>STREAM read_files(...)</code>.</p>

<div class="callout"><strong>Exam tip:</strong> For millions of files or files arriving continuously, choose Auto Loader. For a simple idempotent SQL load of a moderate number of files, choose COPY INTO. Choose plain CTAS only for a one-time load.</div>

<h3>Lakeflow Connect</h3>
<p><strong>Lakeflow Connect</strong> provides managed connectors that ingest from SaaS apps (Salesforce, Workday, ...) and databases (SQL Server, ...) into Delta tables. <strong>Lakehouse Federation</strong> is different: it lets you <em>query</em> external databases in place, without copying the data.</p>
`
  },

  // ---------------------------------------------------------------- transform
  {
    id: "sql-transforms", domain: "transform", title: "Spark SQL Transformations", minutes: 10,
    body: `
<p>Most transformations on the exam are ordinary SQL with some Spark extras. Try these yourself in the <a href="#/sandbox">SQL Sandbox</a>.</p>

<h3>Dedup with window functions</h3>
<pre><code>SELECT *
FROM bronze_events
QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingest_ts DESC) = 1;</code></pre>
<p><code>SELECT DISTINCT *</code> removes only rows that are identical in every column. Use <code>ROW_NUMBER()</code> when you need to keep one row per key.</p>

<h3>NULL behaviour</h3>
<ul>
  <li><code>count(*)</code> counts all rows. <code>count(col)</code> skips NULLs.</li>
  <li><code>count_if(cond)</code> counts the rows where the condition is true.</li>
  <li><code>col = NULL</code> is never true. Use <code>col IS NULL</code>.</li>
  <li><code>coalesce(a, b)</code> returns the first value that isn't NULL.</li>
</ul>

<h3>Joins</h3>
<p>Spark supports <code>INNER</code>, <code>LEFT</code>, <code>RIGHT</code>, <code>FULL</code>, <code>CROSS</code>, plus <code>LEFT SEMI</code> (rows from the left side that have a match) and <code>LEFT ANTI</code> (rows from the left side with <em>no</em> match).</p>

<h3>Nested and semi-structured data</h3>
<pre><code>-- JSON string column: path syntax with a colon
SELECT raw:customer.id, raw:items[0].sku FROM bronze_json;

-- parse a JSON string into a struct
SELECT from_json(raw, schema_of_json('{"id":1,"tags":["a"]}')) AS parsed FROM t;

-- struct fields: dot syntax
SELECT parsed.id FROM t2;

-- arrays: one row per element
SELECT order_id, explode(items) AS item FROM orders_nested;</code></pre>

<h3>Higher-order functions</h3>
<pre><code>SELECT
  transform(prices, p -> p * 1.1)        AS with_tax,
  filter(items, i -> i.qty > 0)          AS in_stock,
  exists(tags, t -> t = 'vip')           AS is_vip,
  aggregate(prices, 0D, (acc, p) -> acc + p) AS total
FROM carts;</code></pre>

<h3>Pivot</h3>
<pre><code>SELECT * FROM (SELECT country, category, revenue FROM sales)
PIVOT (sum(revenue) FOR category IN ('Books', 'Toys'));</code></pre>

<h3>SQL UDFs</h3>
<pre><code>CREATE FUNCTION main.util.to_eur(usd DOUBLE) RETURNS DOUBLE
RETURN usd * 0.92;</code></pre>
<p>SQL UDFs are stored in Unity Catalog and governed like other objects. Spark can optimize them better than Python UDFs.</p>
`
  },
  {
    id: "pyspark", domain: "transform", title: "PySpark DataFrames", minutes: 9,
    body: `
<p>Everything you can do in Spark SQL you can also do with the DataFrame API. Both compile to the same plan.</p>
<pre><code>from pyspark.sql import functions as F
from pyspark.sql.window import Window

orders = spark.table("main.silver.orders")

daily = (orders
  .filter(F.col("status") == "COMPLETED")
  .withColumn("order_day", F.to_date("order_ts"))
  .groupBy("order_day")
  .agg(F.count("*").alias("orders"),
       F.sum("amount").alias("revenue"))
  .orderBy("order_day"))

w = Window.partitionBy("event_id").orderBy(F.col("ingest_ts").desc())
latest = (spark.table("bronze_events")
  .withColumn("rn", F.row_number().over(w))
  .filter("rn = 1")
  .drop("rn"))

latest.write.mode("overwrite").saveAsTable("main.silver.events")</code></pre>

<h3>Transformations vs. actions</h3>
<ul>
  <li><strong>Transformations</strong> (<code>filter</code>, <code>select</code>, <code>withColumn</code>, <code>join</code>, <code>groupBy</code>) are <em>lazy</em>. They only build a plan.</li>
  <li><strong>Actions</strong> (<code>count</code>, <code>collect</code>, <code>show</code>, <code>display</code>, <code>write</code>) actually run it.</li>
</ul>

<h3>Writing data</h3>
<table class="ref">
  <tr><th>Mode</th><th>Effect</th></tr>
  <tr><td><code>append</code></td><td>Add rows</td></tr>
  <tr><td><code>overwrite</code></td><td>Replace the data</td></tr>
  <tr><td><code>error</code> / <code>errorifexists</code> (default)</td><td>Fail if the table exists</td></tr>
  <tr><td><code>ignore</code></td><td>Do nothing if the table exists</td></tr>
</table>
<p>To add new columns while appending, use <code>.option("mergeSchema", "true")</code>.</p>

<h3>Python UDFs</h3>
<p>Python UDFs send rows between the JVM and Python, which is slow. Prefer built-in functions. If you need custom Python, <code>pandas_udf</code> (vectorized with Arrow) is much faster than a row-at-a-time <code>udf</code>.</p>
`
  },
  {
    id: "delta-ops", domain: "transform", title: "Delta Lake: MERGE, Time Travel and Maintenance", minutes: 11,
    body: `
<h3>MERGE (upsert)</h3>
<pre><code>MERGE INTO main.silver.customers AS t
USING updates AS s
ON t.customer_id = s.customer_id
WHEN MATCHED AND s.is_deleted THEN DELETE
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;</code></pre>
<p>To insert only new records and ignore duplicates, use just <code>WHEN NOT MATCHED THEN INSERT *</code>. MERGE fails if more than one source row matches the same target row, so dedupe the source first.</p>

<h3>History and time travel</h3>
<pre><code>DESCRIBE HISTORY main.silver.customers;            -- version, timestamp, operation, user
SELECT * FROM main.silver.customers VERSION AS OF 12;
SELECT * FROM main.silver.customers TIMESTAMP AS OF '2024-06-01';
SELECT * FROM main.silver.customers@v12;           -- shorthand
RESTORE TABLE main.silver.customers TO VERSION AS OF 12;</code></pre>
<p>RESTORE is itself recorded as a new version, so you can undo it too.</p>

<h3>Table details</h3>
<pre><code>DESCRIBE DETAIL main.silver.customers;     -- location, format, numFiles, sizeInBytes
DESCRIBE EXTENDED main.silver.customers;   -- columns plus table properties, type (MANAGED/EXTERNAL)</code></pre>

<h3>OPTIMIZE, Z-ORDER and liquid clustering</h3>
<pre><code>OPTIMIZE main.silver.events;                          -- compact small files
OPTIMIZE main.silver.events ZORDER BY (customer_id);  -- co-locate related values
ALTER TABLE main.silver.events CLUSTER BY (customer_id);  -- liquid clustering</code></pre>
<ul>
  <li>Small files hurt read performance. OPTIMIZE rewrites them into larger ones.</li>
  <li><strong>Z-ordering</strong> enables data skipping on high-cardinality filter columns.</li>
  <li><strong>Liquid clustering</strong> (<code>CLUSTER BY</code>) replaces partitioning and Z-order for new tables. Clustering keys can change without rewriting the data.</li>
  <li><strong>Predictive optimization</strong> can run OPTIMIZE and VACUUM automatically on Unity Catalog managed tables.</li>
</ul>

<h3>VACUUM</h3>
<pre><code>VACUUM main.silver.events;                 -- default: keep 7 days of history
VACUUM main.silver.events RETAIN 240 HOURS;</code></pre>
<ul>
  <li>Deletes data files that are no longer referenced and are older than the retention period (default <strong>7 days / 168 hours</strong>).</li>
  <li>After VACUUM, you can't time travel to versions older than the retention period.</li>
  <li>Setting a shorter retention fails unless you disable <code>spark.databricks.delta.retentionDurationCheck.enabled</code>, and doing so is risky.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Time travel stopped working for old versions" usually means VACUUM ran. "Queries are slow because of many small files" points to OPTIMIZE.</div>
`
  },

  // ---------------------------------------------------------------- production
  {
    id: "medallion-streaming", domain: "production", title: "Medallion Architecture and Structured Streaming", minutes: 9,
    body: `
<h3>Medallion layers</h3>
<table class="ref">
  <tr><th>Layer</th><th>Contents</th><th>Typical consumers</th></tr>
  <tr><td><strong>Bronze</strong></td><td>Raw data as ingested, plus metadata (source file, ingest time)</td><td>Data engineers, replay and debugging</td></tr>
  <tr><td><strong>Silver</strong></td><td>Cleaned, deduplicated, typed and joined data</td><td>Analysts, data scientists</td></tr>
  <tr><td><strong>Gold</strong></td><td>Business-level aggregates and features</td><td>Dashboards, reports, ML</td></tr>
</table>

<h3>Structured Streaming basics</h3>
<pre><code>(spark.readStream.table("main.bronze.orders")
   .filter("amount > 0")
 .writeStream
   .option("checkpointLocation", "/Volumes/main/silver/_chk/orders")
   .outputMode("append")
   .trigger(availableNow=True)
   .toTable("main.silver.orders"))</code></pre>
<ul>
  <li>A stream treats a table as an <em>unbounded</em> input. Each micro-batch processes only new data.</li>
  <li>The <strong>checkpoint</strong> stores progress. Together with an idempotent sink like Delta, it gives exactly-once processing. Every stream needs its own checkpoint.</li>
  <li>A Delta table used as a streaming source must be <strong>append-only</strong>. Updates or deletes in the source break the stream unless you set options such as <code>skipChangeCommits</code>.</li>
</ul>

<h3>Triggers</h3>
<table class="ref">
  <tr><th>Trigger</th><th>Behaviour</th></tr>
  <tr><td>(default)</td><td>Start the next micro-batch as soon as the previous one finishes</td></tr>
  <tr><td><code>processingTime="5 minutes"</code></td><td>One micro-batch every 5 minutes, running continuously</td></tr>
  <tr><td><code>availableNow=True</code></td><td>Process everything available in one or more batches, then stop. Good for scheduled incremental jobs.</td></tr>
  <tr><td><code>once=True</code></td><td>Deprecated. Replaced by availableNow.</td></tr>
</table>

<h3>Output modes</h3>
<p><code>append</code> writes only new rows (the default, and most common). <code>complete</code> rewrites the whole result each batch, which aggregations use. <code>update</code> writes only the rows that changed.</p>
`
  },
  {
    id: "declarative-pipelines", domain: "production", title: "Lakeflow Declarative Pipelines (DLT)", minutes: 11,
    body: `
<p><strong>Lakeflow Declarative Pipelines</strong> (formerly <strong>Delta Live Tables / DLT</strong>) let you declare <em>what</em> tables should contain. Databricks works out dependencies, orchestration, retries, and infrastructure.</p>

<h3>Dataset types</h3>
<table class="ref">
  <tr><th>Type</th><th>Use for</th></tr>
  <tr><td><strong>Streaming table</strong></td><td>Incremental, append-style processing. Each input row is processed once. Usually used for bronze and silver.</td></tr>
  <tr><td><strong>Materialized view</strong></td><td>Results kept up to date with the source, recomputed incrementally when possible. Usually used for gold aggregates.</td></tr>
  <tr><td><strong>View</strong></td><td>Intermediate logic that isn't published to the catalog</td></tr>
</table>

<h3>SQL syntax</h3>
<pre><code>CREATE OR REFRESH STREAMING TABLE orders_bronze
AS SELECT *, _metadata.file_path AS source_file
FROM STREAM read_files('/Volumes/main/raw/landing/orders/', format => 'json');

CREATE OR REFRESH STREAMING TABLE orders_silver (
  CONSTRAINT valid_id     EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT valid_amount EXPECT (amount >= 0)          ON VIOLATION FAIL UPDATE,
  CONSTRAINT has_email    EXPECT (email IS NOT NULL)
)
AS SELECT * FROM STREAM(orders_bronze);

CREATE OR REFRESH MATERIALIZED VIEW daily_revenue
AS SELECT date(order_ts) AS day, sum(amount) AS revenue
FROM orders_silver GROUP BY 1;</code></pre>

<h3>Expectations (data quality)</h3>
<table class="ref">
  <tr><th>On violation</th><th>Python decorator</th><th>Effect</th></tr>
  <tr><td>(none)</td><td><code>@dlt.expect</code></td><td>Keep the row and record the violation in metrics</td></tr>
  <tr><td><code>DROP ROW</code></td><td><code>@dlt.expect_or_drop</code></td><td>Drop the bad row and record it</td></tr>
  <tr><td><code>FAIL UPDATE</code></td><td><code>@dlt.expect_or_fail</code></td><td>Stop the update. The transaction is rolled back.</td></tr>
</table>
<p>Quality metrics appear in the pipeline UI and in the <strong>event log</strong>.</p>

<h3>Python syntax</h3>
<pre><code>import dlt   # newer runtimes: from pyspark import pipelines as dp

@dlt.table(comment="Cleaned orders")
@dlt.expect_or_drop("valid_id", "order_id IS NOT NULL")
def orders_silver():
    return spark.readStream.table("orders_bronze")</code></pre>

<h3>CDC with AUTO CDC / APPLY CHANGES</h3>
<pre><code>CREATE OR REFRESH STREAMING TABLE customers;
APPLY CHANGES INTO customers          -- newer name: AUTO CDC INTO
FROM STREAM(customers_cdc)
KEYS (customer_id)
APPLY AS DELETE WHEN op = 'DELETE'
SEQUENCE BY event_ts
STORED AS SCD TYPE 1;                 -- or SCD TYPE 2 to keep history</code></pre>

<h3>Development vs. production mode</h3>
<ul>
  <li><strong>Development</strong>: reuses the cluster between updates and doesn't retry on failure, so you iterate faster.</li>
  <li><strong>Production</strong>: restarts the cluster on recoverable errors and retries automatically.</li>
  <li>A <strong>triggered</strong> pipeline runs once and stops. A <strong>continuous</strong> pipeline keeps running.</li>
</ul>
`
  },
  {
    id: "jobs", domain: "production", title: "Lakeflow Jobs and Asset Bundles", minutes: 8,
    body: `
<h3>Lakeflow Jobs (Workflows)</h3>
<ul>
  <li>A <strong>job</strong> is a set of <strong>tasks</strong> arranged as a DAG. Task types include notebook, Python script, SQL, pipeline, dbt, JAR and other jobs.</li>
  <li>Tasks declare <strong>dependencies</strong>. Run-if conditions (for example <em>All succeeded</em> or <em>At least one failed</em>) control what runs after a failure.</li>
  <li><strong>If/else</strong> and <strong>For each</strong> tasks add control flow. <strong>Task values</strong> pass small values between tasks.</li>
  <li><strong>Triggers</strong>: scheduled (cron), file arrival, table update, or continuous.</li>
  <li>Per-task <strong>retries</strong> with timeouts, and <strong>notifications</strong> by email, Slack or webhook on start, success or failure.</li>
  <li><strong>Repair run</strong>: re-run only the failed tasks and the tasks that depend on them, without re-running the tasks that succeeded.</li>
  <li>Job and task <strong>parameters</strong> reach notebooks as widgets.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> One task in a 10-task job failed and you want to fix it without re-running the other 9? Use <em>Repair run</em>.</div>

<h3>Databricks Asset Bundles (DABs)</h3>
<p>Bundles describe jobs, pipelines and other resources as YAML in a <code>databricks.yml</code> file kept in source control. You deploy them with the Databricks CLI:</p>
<pre><code>databricks bundle validate
databricks bundle deploy -t dev
databricks bundle run -t dev nightly_job</code></pre>
<pre><code># databricks.yml (excerpt)
bundle:
  name: sales_pipeline
targets:
  dev:
    mode: development
    default: true
  prod:
    mode: production
resources:
  jobs:
    nightly_job:
      tasks:
        - task_key: ingest
          notebook_task:
            notebook_path: ./src/ingest.py</code></pre>
<p>Targets let you deploy the same code to different workspaces and environments. That is the recommended approach for CI/CD.</p>

<h3>Troubleshooting</h3>
<ul>
  <li>Use the <strong>Spark UI</strong> to look for skew, spill, and slow stages.</li>
  <li>Job run history shows the output and error for each task.</li>
  <li><strong>System tables</strong> (<code>system.billing.usage</code>, <code>system.lakeflow.*</code>, <code>system.access.audit</code>) let you monitor cost and runs with SQL.</li>
</ul>
`
  },

  // ---------------------------------------------------------------- governance
  {
    id: "unity-catalog", domain: "governance", title: "Unity Catalog Fundamentals", minutes: 10,
    body: `
<p><strong>Unity Catalog (UC)</strong> is Databricks' unified governance layer. It handles access control, auditing, lineage and discovery across workspaces.</p>

<h3>Object hierarchy</h3>
<pre><code>metastore                (one per region, attached to workspaces)
 └── catalog             main
      └── schema         sales
           ├── table     orders
           ├── view      v_orders
           ├── volume    landing      (governed non-tabular files)
           ├── function  to_eur
           └── model     churn_model</code></pre>
<p>Objects are named with a <strong>three-level namespace</strong>: <code>catalog.schema.object</code>, for example <code>main.sales.orders</code>. Use <code>USE CATALOG</code> and <code>USE SCHEMA</code> to set defaults.</p>

<h3>Managed vs. external tables</h3>
<table class="ref">
  <tr><th></th><th>Managed</th><th>External</th></tr>
  <tr><td>Storage location</td><td>Chosen and managed by UC</td><td>You provide a <code>LOCATION</code> path</td></tr>
  <tr><td><code>DROP TABLE</code></td><td>Deletes metadata <strong>and data</strong> (files are removed after a short recovery window)</td><td>Deletes metadata only. <strong>Files stay.</strong></td></tr>
  <tr><td>Recommended?</td><td>Yes, and they get predictive optimization</td><td>When other tools must read the files directly</td></tr>
</table>

<h3>Securables for storage</h3>
<ul>
  <li><strong>Storage credential</strong>: a cloud identity (IAM role, managed identity) that can reach storage.</li>
  <li><strong>External location</strong>: a storage path combined with a credential. Needed before you can create external tables or volumes there.</li>
  <li><strong>Volumes</strong>: govern files (CSV, images, ...) at paths like <code>/Volumes/catalog/schema/volume/</code>.</li>
</ul>

<h3>Lineage and auditing</h3>
<p>UC automatically records <strong>table and column lineage</strong> for queries run on UC-enabled compute. You can view it in Catalog Explorer. Audit logs are in <code>system.access.audit</code>.</p>

<h3>The legacy Hive metastore</h3>
<p>Before UC, each workspace had its own <code>hive_metastore</code> with workspace-local permissions. With UC it appears as a catalog called <code>hive_metastore</code>, and you can upgrade its tables into UC.</p>
`
  },
  {
    id: "privileges", domain: "governance", title: "Privileges, Row Filters and Delta Sharing", minutes: 9,
    body: `
<h3>Granting access</h3>
<pre><code>GRANT USE CATALOG ON CATALOG main TO &#96;analysts&#96;;
GRANT USE SCHEMA  ON SCHEMA main.sales TO &#96;analysts&#96;;
GRANT SELECT      ON TABLE  main.sales.orders TO &#96;analysts&#96;;

REVOKE SELECT ON TABLE main.sales.orders FROM &#96;analysts&#96;;
SHOW GRANTS ON TABLE main.sales.orders;</code></pre>
<ul>
  <li>To read a table, a user needs <code>USE CATALOG</code> on the catalog, <code>USE SCHEMA</code> on the schema, <strong>and</strong> <code>SELECT</code> on the table.</li>
  <li>Privileges <strong>inherit downwards</strong>: <code>GRANT SELECT ON SCHEMA main.sales</code> covers every current and future table in that schema.</li>
  <li>Other common privileges: <code>MODIFY</code> (insert, update, delete), <code>CREATE TABLE</code>, <code>CREATE SCHEMA</code>, <code>READ VOLUME</code>, <code>WRITE VOLUME</code>, <code>EXECUTE</code> (functions), <code>ALL PRIVILEGES</code>.</li>
  <li>An object's <strong>owner</strong> has all privileges on it and can grant them to others. Metastore admins and catalog owners can manage everything below them.</li>
  <li>Grant to <strong>groups</strong> rather than individual users. Groups are managed at the account level.</li>
</ul>

<h3>Fine-grained access</h3>
<pre><code>-- row filter: non-admins only see US rows
CREATE FUNCTION main.sec.us_only(country STRING)
RETURN is_account_group_member('admins') OR country = 'US';
ALTER TABLE main.sales.customers SET ROW FILTER main.sec.us_only ON (country);

-- column mask
CREATE FUNCTION main.sec.mask_email(email STRING)
RETURN CASE WHEN is_account_group_member('pii_readers') THEN email ELSE '***' END;
ALTER TABLE main.sales.customers ALTER COLUMN email SET MASK main.sec.mask_email;</code></pre>
<p>Dynamic views that use <code>current_user()</code> or <code>is_account_group_member()</code> are the older way to get the same effect.</p>

<h3>Delta Sharing</h3>
<ul>
  <li>An <strong>open protocol</strong> for sharing live data without copying it.</li>
  <li><strong>Databricks-to-Databricks</strong> sharing: the recipient has a UC-enabled workspace, and the shared data appears in their catalog.</li>
  <li><strong>Open sharing</strong>: recipients on any platform (pandas, Spark, Power BI, ...) connect with a credential file or token.</li>
  <li>Objects: a <strong>share</strong> (what you share) and a <strong>recipient</strong> (who receives it). Shares are read-only for recipients.</li>
  <li>Sharing across clouds or regions can incur <strong>egress costs</strong>.</li>
</ul>
<pre><code>CREATE SHARE sales_share;
ALTER SHARE sales_share ADD TABLE main.sales.orders;
CREATE RECIPIENT partner_co;
GRANT SELECT ON SHARE sales_share TO RECIPIENT partner_co;</code></pre>
`
  }
];
