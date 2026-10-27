// Data Engineer Professional track: modules and lessons.
// Exercises and case studies are in content-professional-practice.js, questions in content-professional-quiz.js.

window.TRAINER = window.TRAINER || {};

// Nine modules, one per section of the official exam guide (effective Oct 9, 2026). "weight" is the
// section's share of the exam (%); the timed mock exams pick questions per section in proportion to it.
TRAINER.domains.push(
  { id: "pro-code", track: "professional", weight: 23, title: "Developing Code for Data Processing (Python & SQL)", short: "Developing code",
    summary: "Bundle project structure, dependencies, UDFs, Lakeflow Jobs control flow, Structured Streaming state, Lakeflow Pipelines, AUTO CDC and testing." },
  { id: "pro-ingest", track: "professional", weight: 12, title: "Data Ingestion & Acquisition", short: "Ingestion",
    summary: "Auto Loader and message buses, Lakeflow Connect CDC from databases, OpenSharing (D2D and open), Clean Rooms and Lakehouse Federation." },
  { id: "pro-manip", track: "professional", weight: 12, title: "Data Manipulation", short: "Manipulation",
    summary: "Advanced window, join and aggregation logic, VARIANT for semi-structured data, AI functions, deduplication and quality expectations." },
  { id: "pro-monitor", track: "professional", weight: 10, title: "Monitoring & Alerting", short: "Monitoring",
    summary: "System tables, REST API, CLI and SDK, pipeline event logs, alerts, job run monitoring and streaming metrics." },
  { id: "pro-perf", track: "professional", weight: 15, title: "Cost & Performance Optimization", short: "Performance",
    summary: "Managed tables, predictive optimization, liquid clustering, deletion vectors, Change Data Feed, caching, the query profile and compute cost." },
  { id: "pro-security", track: "professional", weight: 8, title: "Ensuring Data Security & Compliance", short: "Security",
    summary: "Least-privilege ACLs, ABAC with governed tags, row filters and column masks, anonymization, PII controls and data purging." },
  { id: "pro-gov", track: "professional", weight: 5, title: "Data Governance", short: "Governance",
    summary: "Unity Catalog tags and comments for discoverability, and the permission inheritance model." },
  { id: "pro-deploy", track: "professional", weight: 10, title: "Debugging & Deploying", short: "Deploying",
    summary: "Diagnosing failures with the Spark UI, logs, system tables and query profiles, repair runs, Declarative Automation Bundles and Git-based CI/CD." },
  { id: "pro-model", track: "professional", weight: 5, title: "Data Modeling", short: "Modeling",
    summary: "Table layouts for large data assets, dimensional models, materialized views and Unity Catalog metric views, slowly changing dimensions." }
);

TRAINER.lessons.push(
  // ---------------------------------------------------------------- pipelines
  {
    id: "pro-streaming", domain: "pro-code", title: "Structured Streaming in Depth", minutes: 12,
    body: `
<p>The Professional exam assumes you know the streaming basics and asks what happens at the edges: late data, state, restarts and changed queries.</p>

<h3>Triggers</h3>
<table class="ref">
  <tr><th>Trigger</th><th>Behaviour</th><th>Typical use</th></tr>
  <tr><td>Default (none set)</td><td>Starts the next micro-batch as soon as the previous one finishes</td><td>Lowest latency on an always-on cluster</td></tr>
  <tr><td><code>processingTime="1 minute"</code></td><td>One micro-batch per interval</td><td>Steady near-real-time loads</td></tr>
  <tr><td><code>availableNow=True</code></td><td>Processes everything available in several rate-limited batches, then stops</td><td>Incremental batch jobs on a schedule. Replaces <code>once=True</code>, which ran one unbounded batch</td></tr>
</table>

<h3>Output modes</h3>
<ul>
  <li><strong>append</strong> (default): only new rows. With an aggregation it needs a watermark, and a window is emitted once the watermark passes its end.</li>
  <li><strong>complete</strong>: rewrites the whole result each batch. Only for aggregations, and only for small results.</li>
  <li><strong>update</strong>: only rows that changed in this batch. Common with <code>foreachBatch</code> + MERGE.</li>
</ul>

<h3>Watermarks and state</h3>
<p>Aggregations, deduplication and stream-stream joins keep <strong>state</strong> between batches. Without a bound, state grows forever. A watermark sets that bound:</p>
<pre><code>(events
  .withWatermark("event_ts", "10 minutes")
  .groupBy(F.window("event_ts", "5 minutes"), "device_id")
  .agg(F.avg("temp").alias("avg_temp")))</code></pre>
<ul>
  <li>Watermark = the latest event time seen minus the delay (10 minutes). State for windows that end before the watermark is dropped.</li>
  <li>Records later than the watermark <em>may</em> be dropped. Spark guarantees to keep data within the delay, not to drop data beyond it.</li>
  <li><code>dropDuplicates(["id", "event_ts"])</code> after a watermark bounds dedup state. <code>dropDuplicatesWithinWatermark(["id"])</code> removes duplicates whose event times differ slightly.</li>
  <li><strong>Stream-stream joins</strong> need watermarks on both sides plus a time-range condition so old state can be cleaned up. It's required for outer joins.</li>
  <li><strong>Stream-static joins</strong> keep no state. The static Delta table is read again (latest version) for every micro-batch.</li>
</ul>
<p>On Databricks, use the <strong>RocksDB state store</strong> for large state. It keeps state off the JVM heap, avoiding garbage-collection pauses.</p>

<h3>Checkpoints</h3>
<p>The checkpoint stores source offsets, committed batches and state. Together with an idempotent sink like Delta, it gives exactly-once results.</p>
<ul>
  <li>Use one checkpoint location per query, and never share it between queries.</li>
  <li>Some changes are safe across a restart: filters, projections, trigger interval, and adding a rate limit such as <code>maxFilesPerTrigger</code>.</li>
  <li>Other changes are incompatible with the existing checkpoint: grouping keys, the stateful operation itself, or the number or type of sources. They need a new checkpoint, and usually a backfill.</li>
</ul>

<h3>foreachBatch for upserts</h3>
<pre><code>def upsert(batch_df, batch_id):
    latest = (batch_df
        .withColumn("rn", F.row_number().over(
            Window.partitionBy("id").orderBy(F.col("seq").desc())))
        .filter("rn = 1").drop("rn"))           # MERGE needs one source row per key
    (DeltaTable.forName(spark, "silver.customers").alias("t")
        .merge(latest.alias("s"), "t.id = s.id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute())

(spark.readStream.table("bronze.customer_changes")
   .writeStream
   .foreachBatch(upsert)
   .option("checkpointLocation", "/Volumes/main/chk/customers")
   .trigger(availableNow=True)
   .start())</code></pre>
<p>A micro-batch can be replayed after a failure, so the function must be idempotent. MERGE on a key is naturally idempotent. For plain appends inside <code>foreachBatch</code>, set the Delta writer options <code>txnAppId</code> and <code>txnVersion</code> (the batch id) so replays are skipped.</p>

<h3>Delta as a streaming source</h3>
<ul>
  <li>By default a stream fails if the source table has updates or deletes, because those rewrite files. <code>skipChangeCommits</code> ignores commits that change existing rows. To process them, read the <strong>Change Data Feed</strong> instead.</li>
  <li>Rate limits: <code>maxFilesPerTrigger</code> (default 1000) and <code>maxBytesPerTrigger</code>.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "The job must run every hour, process only new data and shut down" → <code>trigger(availableNow=True)</code> on a job cluster or serverless. "State keeps growing" → add a watermark. "Changed the aggregation keys and the stream fails on restart" → it needs a new checkpoint.</div>
`
  },
  {
    id: "pro-lakeflow", domain: "pro-code", title: "Lakeflow Declarative Pipelines and AUTO CDC", minutes: 12,
    body: `
<p>Lakeflow Declarative Pipelines (formerly Delta Live Tables, DLT) let you declare tables and their queries. Databricks works out the dependency graph, compute, retries and checkpoints.</p>

<h3>Dataset types</h3>
<table class="ref">
  <tr><th>Type</th><th>Processes</th><th>Use for</th></tr>
  <tr><td><strong>Streaming table</strong></td><td>Each input row once (append-only sources)</td><td>Ingestion and bronze/silver steps. Also the target of AUTO CDC</td></tr>
  <tr><td><strong>Materialized view</strong></td><td>Recomputes results, incrementally where possible</td><td>Aggregations, joins and gold tables that must reflect updates and deletes</td></tr>
  <tr><td><strong>Temporary view</strong></td><td>Not persisted, only visible inside the pipeline</td><td>Intermediate steps</td></tr>
</table>

<h3>SQL and Python</h3>
<pre><code>CREATE OR REFRESH STREAMING TABLE orders_bronze
AS SELECT * FROM STREAM read_files('/Volumes/main/raw/orders', format =&gt; 'json');

CREATE OR REFRESH MATERIALIZED VIEW daily_revenue
AS SELECT order_date, sum(amount) AS revenue FROM orders_silver GROUP BY order_date;</code></pre>
<pre><code>from pyspark import pipelines as dp     # older code: import dlt

@dp.table(comment="Cleaned orders")
@dp.expect_or_drop("valid_id", "order_id IS NOT NULL")
@dp.expect_or_fail("valid_amount", "amount &gt;= 0")
def orders_silver():
    return spark.readStream.table("orders_bronze")</code></pre>
<p>Python decorators: <code>@dp.table</code> (a streaming table when the function returns a streaming DataFrame), <code>@dp.materialized_view</code>, <code>@dp.temporary_view</code>. With the older <code>dlt</code> module you'll also see <code>@dlt.table</code> and <code>@dlt.view</code>.</p>

<h3>Expectations</h3>
<table class="ref">
  <tr><th>SQL</th><th>Python</th><th>On a bad row</th></tr>
  <tr><td><code>EXPECT (cond)</code></td><td><code>@dp.expect</code></td><td>Keeps it and records the violation in metrics</td></tr>
  <tr><td><code>... ON VIOLATION DROP ROW</code></td><td><code>@dp.expect_or_drop</code></td><td>Drops the row</td></tr>
  <tr><td><code>... ON VIOLATION FAIL UPDATE</code></td><td><code>@dp.expect_or_fail</code></td><td>Fails the update. The transaction rolls back</td></tr>
</table>
<p>Group several rules with <code>@dp.expect_all</code>, <code>expect_all_or_drop</code> and <code>expect_all_or_fail</code> (a dict of name to condition). Pass/fail counts are written to the pipeline event log.</p>

<h3>AUTO CDC (formerly APPLY CHANGES)</h3>
<p>AUTO CDC applies a change feed to a target streaming table. It handles out-of-order events with a sequencing column, and can keep SCD Type 1 or Type 2 history.</p>
<pre><code>CREATE OR REFRESH STREAMING TABLE customers_silver;

CREATE FLOW customers_cdc AS AUTO CDC INTO customers_silver
FROM STREAM(customer_changes)
KEYS (customer_id)
APPLY AS DELETE WHEN op = 'DELETE'
SEQUENCE BY seq
COLUMNS * EXCEPT (op, seq)
STORED AS SCD TYPE 2;</code></pre>
<pre><code>dp.create_streaming_table("customers_silver")
dp.create_auto_cdc_flow(               # older API: dlt.apply_changes(...)
    target="customers_silver",
    source="customer_changes",
    keys=["customer_id"],
    sequence_by=F.col("seq"),
    apply_as_deletes=F.expr("op = 'DELETE'"),
    except_column_list=["op", "seq"],
    stored_as_scd_type=2)</code></pre>
<ul>
  <li><code>SEQUENCE BY</code> decides which change wins. A late-arriving older change won't overwrite a newer one.</li>
  <li>SCD Type 2 adds <code>__START_AT</code> and <code>__END_AT</code> columns. The current version has <code>__END_AT</code> NULL. <code>TRACK HISTORY ON</code> limits which columns create a new version.</li>
  <li>For snapshot sources (full extracts, not a change feed), use <code>create_auto_cdc_from_snapshot_flow</code> (formerly <code>apply_changes_from_snapshot</code>).</li>
</ul>

<h3>Running pipelines</h3>
<ul>
  <li><strong>Triggered</strong> runs process what's available and stop. <strong>Continuous</strong> runs keep going for low latency.</li>
  <li><strong>Development mode</strong> reuses the cluster and doesn't retry. <strong>Production mode</strong> restarts the cluster on recoverable errors and retries.</li>
  <li>A <strong>full refresh</strong> truncates streaming tables and reprocesses all source data. Set the table property <code>pipelines.reset.allowed = false</code> to protect a table whose source data has expired.</li>
  <li>Several flows can write into one streaming table (<code>@dp.append_flow</code> / <code>CREATE FLOW ... INSERT INTO</code>). For example, you can add a new Kafka region without a full refresh.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> Out-of-order CDC events with a sequence number → AUTO CDC with <code>SEQUENCE BY</code>. A gold aggregate that must reflect deletes upstream → materialized view, not a streaming table.</div>
`
  },
  {
    id: "pro-cdf", domain: "pro-perf", title: "Change Data Feed and Incremental MERGE", minutes: 10,
    body: `
<p>Silver and gold tables shouldn't be rebuilt from scratch every run. Delta's <strong>Change Data Feed (CDF)</strong> and <strong>MERGE</strong> let you move only what changed.</p>

<h3>Change Data Feed</h3>
<pre><code>ALTER TABLE silver.orders SET TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- batch: changes since version 12
SELECT * FROM table_changes('silver.orders', 12);</code></pre>
<pre><code>changes = (spark.readStream
    .option("readChangeFeed", "true")
    .table("silver.orders"))       # streaming read of row-level changes</code></pre>
<p>Each change row has three metadata columns:</p>
<table class="ref">
  <tr><th>Column</th><th>Values</th></tr>
  <tr><td><code>_change_type</code></td><td><code>insert</code>, <code>update_preimage</code> (old values), <code>update_postimage</code> (new values), <code>delete</code></td></tr>
  <tr><td><code>_commit_version</code></td><td>The Delta table version of the change</td></tr>
  <tr><td><code>_commit_timestamp</code></td><td>When the commit happened</td></tr>
</table>
<ul>
  <li>CDF records changes only <strong>after</strong> it's enabled. Earlier versions have no change data.</li>
  <li>Change files live in the table's <code>_change_data</code> folder and are removed by <code>VACUUM</code> like other old files.</li>
  <li>To get the current state of each key from a change feed: drop <code>update_preimage</code> rows, keep the latest <code>_commit_version</code> per key, and treat a final <code>delete</code> as "remove".</li>
</ul>

<h3>MERGE details that matter</h3>
<pre><code>MERGE WITH SCHEMA EVOLUTION INTO silver.customers AS t
USING latest_changes AS s
ON t.customer_id = s.customer_id
WHEN MATCHED AND s.op = 'DELETE' THEN DELETE
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED AND s.op != 'DELETE' THEN INSERT *
WHEN NOT MATCHED BY SOURCE AND t.is_active THEN UPDATE SET t.is_active = false;</code></pre>
<ul>
  <li>If two source rows match the same target row, MERGE fails (<code>DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW_IN_MERGE</code>). Deduplicate the source to one row per key first, usually the latest by a sequence column.</li>
  <li>WHEN clauses are evaluated in order, so put conditional clauses first.</li>
  <li><code>WHEN NOT MATCHED BY SOURCE</code> handles target rows missing from the source, for example to soft-delete or delete them in a full-snapshot sync.</li>
  <li><code>WITH SCHEMA EVOLUTION</code> (or <code>spark.databricks.delta.schema.autoMerge.enabled</code>) adds new source columns to the target.</li>
  <li><strong>Insert-only MERGE</strong> (<code>WHEN NOT MATCHED THEN INSERT *</code>) deduplicates across batches: records already in the target are skipped.</li>
  <li>Add a selective predicate on the target, such as a date range or the clustering key, so MERGE scans fewer files. It also reduces conflicts between concurrent writers.</li>
</ul>

<h3>Incremental patterns compared</h3>
<table class="ref">
  <tr><th>Pattern</th><th>When</th></tr>
  <tr><td>Append stream (Auto Loader → bronze)</td><td>Insert-only sources</td></tr>
  <tr><td>Stream + <code>foreachBatch</code> MERGE</td><td>Upserts from a change stream with custom logic</td></tr>
  <tr><td>AUTO CDC in a pipeline</td><td>Change feeds into SCD1/SCD2 tables with ordering handled for you</td></tr>
  <tr><td>Read CDF downstream</td><td>Propagating updates and deletes from silver to gold</td></tr>
  <tr><td>Materialized view</td><td>Aggregates kept up to date automatically (incremental refresh on serverless)</td></tr>
</table>

<div class="callout"><strong>Exam tip:</strong> "Propagate updates and deletes from a silver table to downstream tables without reprocessing it all" → enable Change Data Feed and read it from the last processed version.</div>
`
  },

  // ---------------------------------------------------------------- ingestion & quality
  {
    id: "pro-autoloader", domain: "pro-ingest", title: "Auto Loader at Scale: Schemas, Evolution and Rescue", minutes: 11,
    body: `
<p>Auto Loader (<code>cloudFiles</code>) picks up new files from cloud storage incrementally, exactly once. At Professional level the questions are about schemas and scale.</p>

<pre><code>(spark.readStream.format("cloudFiles")
   .option("cloudFiles.format", "json")
   .option("cloudFiles.schemaLocation", "/Volumes/main/chk/orders_schema")
   .option("cloudFiles.inferColumnTypes", "true")
   .option("cloudFiles.schemaHints", "amount DECIMAL(10,2), order_ts TIMESTAMP")
   .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
   .load("/Volumes/main/raw/orders")
 .writeStream
   .option("checkpointLocation", "/Volumes/main/chk/orders")
   .option("mergeSchema", "true")
   .trigger(availableNow=True)
   .toTable("bronze.orders"))</code></pre>

<h3>Schema inference</h3>
<ul>
  <li><code>cloudFiles.schemaLocation</code> stores the inferred schema and its versions. It's required when you don't pass a schema.</li>
  <li>For JSON and CSV, columns are inferred as <strong>strings</strong> unless <code>cloudFiles.inferColumnTypes</code> is true. Parquet and Avro keep their types.</li>
  <li><code>cloudFiles.schemaHints</code> fixes the types of specific columns while the rest are still inferred.</li>
</ul>

<h3>Schema evolution modes</h3>
<table class="ref">
  <tr><th>Mode</th><th>On a new column</th></tr>
  <tr><td><code>addNewColumns</code> (default without a schema)</td><td>The stream fails with an <code>UnknownFieldException</code> after updating the stored schema. On restart, the column is included. Run it as a job with retries</td></tr>
  <tr><td><code>rescue</code></td><td>Schema never changes. New columns go into <code>_rescued_data</code></td></tr>
  <tr><td><code>failOnNewColumns</code></td><td>The stream fails and stays failed until you update the schema or remove the file</td></tr>
  <tr><td><code>none</code> (default with a schema)</td><td>New columns are ignored and not rescued</td></tr>
</table>
<p>The <strong><code>_rescued_data</code></strong> column holds JSON for data that didn't fit: unknown columns, type mismatches (a string in an int column) and case mismatches. Bad records are kept instead of failing the stream or turning into silent NULLs.</p>

<h3>File discovery at scale</h3>
<ul>
  <li><strong>Directory listing</strong> (default) lists the input path. It's simple and needs no extra permissions, but it gets slower as folders grow.</li>
  <li><strong>File notifications / file events</strong> subscribe to storage events instead of listing. Use them for very large or high-volume directories. On Unity Catalog external locations, enable file events and set <code>cloudFiles.useManagedFileEvents</code>. The older mode, <code>cloudFiles.useNotifications</code>, creates a queue per stream.</li>
  <li><code>cloudFiles.maxFilesPerTrigger</code> and <code>cloudFiles.maxBytesPerTrigger</code> limit batch size. This matters for big initial backfills.</li>
  <li>Discovered files are tracked in the checkpoint (RocksDB), so a file is processed once even if it's listed again. Re-uploaded files with the same name are skipped unless <code>cloudFiles.allowOverwrites</code> is set.</li>
</ul>

<h3>COPY INTO and read_files</h3>
<pre><code>COPY INTO bronze.orders
FROM '/Volumes/main/raw/orders'
FILEFORMAT = JSON
FORMAT_OPTIONS ('inferSchema' = 'true')
COPY_OPTIONS ('mergeSchema' = 'true');</code></pre>
<p><code>COPY INTO</code> is idempotent: files already loaded are skipped on re-runs. It suits SQL users and batch loads of thousands of files. Auto Loader is the choice for millions of files, continuous arrival and schema evolution. <code>read_files()</code> is the SQL table-valued function behind streaming tables in SQL pipelines.</p>

<div class="callout"><strong>Exam tip:</strong> "Source teams add columns without notice; the pipeline must not lose data or stop" → Auto Loader with <code>addNewColumns</code> and job retries, or <code>rescue</code> mode if the schema must stay fixed. "Values that don't match the schema must be kept for review" → <code>_rescued_data</code>.</div>
`
  },
  {
    id: "pro-quality", domain: "pro-manip", title: "Cleansing, Deduplication, Quarantine and Data Quality", minutes: 10,
    body: `
<p>Real feeds deliver duplicates, late records and bad values. A professional pipeline handles each of them on purpose, and the exam tests which tool fits.</p>

<h3>Duplicates at three levels</h3>
<table class="ref">
  <tr><th>Where duplicates are</th><th>Fix</th></tr>
  <tr><td>Within one batch</td><td><code>dropDuplicates(["event_id"])</code>, or <code>row_number()</code> over the key ordered by a timestamp to choose which copy wins</td></tr>
  <tr><td>Across batches (already loaded)</td><td>Insert-only MERGE on the key, or a left anti join against the target</td></tr>
  <tr><td>In a stream</td><td><code>withWatermark</code> + <code>dropDuplicates</code>, or <code>dropDuplicatesWithinWatermark</code>, so state stays bounded</td></tr>
</table>
<pre><code>w = Window.partitionBy("event_id").orderBy(F.col("ingest_ts").desc())
latest = (bronze
    .withColumn("rn", F.row_number().over(w))
    .filter("rn = 1").drop("rn"))</code></pre>
<p><code>dropDuplicates</code> keeps an arbitrary row of each group. When the copies differ, use <code>row_number</code> with an explicit order so the result is deterministic.</p>

<h3>Incremental loads with a high-water mark</h3>
<p>Outside streaming, an incremental batch job remembers the last processed position, such as the maximum <code>ingest_ts</code> or a Delta version, and reads only newer rows. A record that was already loaded in an earlier run can show up again as a late re-delivery, so new rows still need to be checked against the target (anti join or insert-only MERGE).</p>

<h3>Quarantine instead of dropping</h3>
<p>Dropping bad rows hides problems. A quarantine pattern keeps them for review:</p>
<pre><code>rules = {"valid_customer": "customer_id IS NOT NULL",
         "valid_type": "event_type IN ('page_view','add_to_cart','purchase')"}
is_valid = " AND ".join(f"({r})" for r in rules.values())

@dp.table
@dp.expect_all_or_drop(rules)
def events_silver():
    return spark.readStream.table("events_bronze")

@dp.table
def events_quarantine():
    return spark.readStream.table("events_bronze").filter(f"NOT ({is_valid})")</code></pre>
<p>Outside pipelines, the same idea is a flag column (<code>is_valid</code> or a <code>quality_status</code>) and two writes, or one table with the flag and a view of the valid rows.</p>

<h3>Delta constraints</h3>
<pre><code>ALTER TABLE silver.orders ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE silver.orders ADD CONSTRAINT positive_amount CHECK (amount &gt;= 0);</code></pre>
<p><code>NOT NULL</code> and <code>CHECK</code> constraints are <strong>enforced</strong>. A write with any violating row fails as a whole. Adding a CHECK to a table that already has violating rows fails. They are hard guarantees, not filters, so put them on tables after the cleansing step.</p>

<h3>Schema enforcement</h3>
<ul>
  <li>Delta rejects appends whose columns or types don't match the table. That's <strong>schema enforcement</strong>.</li>
  <li><code>mergeSchema</code> adds new columns on write. <code>overwriteSchema</code> replaces the schema, for example to change a type, when overwriting the table.</li>
  <li>Type widening (for example INT to BIGINT) can be enabled as a table feature, so no rewrite is needed.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Bad records must not reach silver, but analysts need to inspect them" → quarantine table or a flag column. "Write must fail if any amount is negative" → a CHECK constraint or <code>expect_or_fail</code>.</div>
`
  },

  // ---------------------------------------------------------------- modeling
  {
    id: "pro-modeling", domain: "pro-model", title: "Modeling the Lakehouse: Layers, Keys and Constraints", minutes: 10,
    body: `
<p>Data modeling on Databricks combines the medallion layers with classic dimensional design. The exam focuses on choosing a model and on the Delta features that support it.</p>

<h3>Which model, where</h3>
<table class="ref">
  <tr><th>Layer</th><th>Typical model</th></tr>
  <tr><td>Bronze</td><td>Source-shaped, append-only, plus ingestion metadata (file name, ingest time)</td></tr>
  <tr><td>Silver</td><td>Cleaned, deduplicated, conformed entities. Often close to 3NF, or a Data Vault (hubs, links, satellites) in large enterprises</td></tr>
  <tr><td>Gold</td><td>Star schemas (facts + dimensions) or wide denormalized tables for BI and ML features</td></tr>
</table>
<ul>
  <li><strong>Fact tables</strong> hold events and measures at a declared grain (one row per order line, for example) with foreign keys to dimensions.</li>
  <li><strong>Dimension tables</strong> hold descriptive attributes and a surrogate key.</li>
  <li>Denormalizing in gold is normal: storage is cheap, and fewer joins make BI faster.</li>
</ul>

<h3>Keys</h3>
<pre><code>CREATE TABLE gold.dim_customer (
  customer_sk BIGINT GENERATED ALWAYS AS IDENTITY,
  customer_id INT NOT NULL,
  country STRING,
  CONSTRAINT dim_customer_pk PRIMARY KEY (customer_sk) RELY
);</code></pre>
<ul>
  <li><strong>Identity columns</strong> generate unique, increasing values, but not necessarily consecutive ones. <code>ALWAYS</code> rejects explicit values. <code>BY DEFAULT</code> allows them. Tables with identity columns don't support concurrent writes.</li>
  <li><strong>Hash keys</strong> (<code>sha2(concat_ws('||', k1, k2), 256)</code> or <code>xxhash64</code>) are deterministic, so they're the same across environments and reloads. That's useful in Data Vault and for idempotent loads.</li>
  <li><strong>PRIMARY KEY and FOREIGN KEY</strong> constraints in Unity Catalog are <em>informational</em>, not enforced. With <code>RELY</code>, the optimizer may use them, for example to remove unnecessary joins or DISTINCTs. Only use RELY when it's actually true.</li>
</ul>

<h3>Laying out large tables</h3>
<ul>
  <li><strong>Map partitioning to the data's grain</strong> only when the table is very large and a coarse column (such as date for a daily-loaded fact) yields partitions of at least about 1 GB. Never partition by a key with many values.</li>
  <li><strong>Align clustering with access patterns</strong>: cluster fact tables on the columns used to filter and join to dimensions, such as <code>customer_id</code> or <code>order_date</code>. Use <code>CLUSTER BY AUTO</code> when patterns change.</li>
  <li><strong>Keep file sizes balanced</strong>: compaction (OPTIMIZE, auto compaction, predictive optimization) avoids small files after many small writes.</li>
  <li>The same principles apply to Iceberg tables managed by Unity Catalog.</li>
</ul>

<h3>Materialized views and metric views for BI</h3>
<pre><code>CREATE MATERIALIZED VIEW gold.daily_sales AS
SELECT order_date, region, sum(net_amount) AS net_revenue, count(*) AS orders
FROM gold.fact_orders JOIN gold.dim_customer USING (customer_sk)
GROUP BY order_date, region;</code></pre>
<pre><code>CREATE VIEW gold.sales_metrics
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
source: gold.fact_orders
dimensions:
  - name: order_month
    expr: date_trunc('MONTH', order_date)
measures:
  - name: net_revenue
    expr: SUM(amount - discount - refund)
$$;

SELECT order_month, MEASURE(net_revenue) FROM gold.sales_metrics GROUP BY ALL;</code></pre>
<ul>
  <li><strong>Materialized views</strong> pre-compute expensive joins and aggregations and refresh incrementally, so dashboards read small results instead of scanning facts.</li>
  <li><strong>Unity Catalog metric views</strong> define measures and dimensions once (for example "net revenue"), governed and reusable. Every dashboard, Genie space and SQL query that uses <code>MEASURE(net_revenue)</code> gets the same number.</li>
  <li>Together they fix two classic problems: inconsistent metric definitions across reports, and slow dashboards that recompute large joins.</li>
</ul>

<h3>Generated columns</h3>
<pre><code>CREATE TABLE silver.events (
  event_ts TIMESTAMP,
  event_date DATE GENERATED ALWAYS AS (CAST(event_ts AS DATE)),
  ...
);</code></pre>
<p>Delta computes the value on write. If the table is partitioned by <code>event_date</code>, a filter on <code>event_ts</code> can still prune partitions, because Delta derives the partition filter.</p>

<h3>Constraint behaviour</h3>
<table class="ref">
  <tr><th>Constraint</th><th>Enforced?</th></tr>
  <tr><td><code>NOT NULL</code>, <code>CHECK</code></td><td>Yes. Violating writes fail</td></tr>
  <tr><td><code>PRIMARY KEY</code>, <code>FOREIGN KEY</code></td><td>No. Informational, optionally <code>RELY</code></td></tr>
</table>
<p>Because primary keys aren't enforced, uniqueness is your pipeline's job: MERGE on the key, deduplicate, and test it.</p>

<div class="callout"><strong>Exam tip:</strong> "Two loads inserted the same customer twice even though customer_id is the primary key" → expected: PK constraints aren't enforced. Use MERGE on the key instead of INSERT.</div>
`
  },
  {
    id: "pro-scd", domain: "pro-model", title: "Slowly Changing Dimensions", minutes: 11,
    body: `
<p>A slowly changing dimension (SCD) decides what to do when a dimension attribute changes, for example when a customer moves country.</p>

<table class="ref">
  <tr><th>Type</th><th>Behaviour</th><th>Trade-off</th></tr>
  <tr><td>Type 0</td><td>Never changes (keeps the original value)</td><td>Simple; loses changes</td></tr>
  <tr><td>Type 1</td><td>Overwrite in place</td><td>Current values only. Old facts now report the new attribute</td></tr>
  <tr><td>Type 2</td><td>New row per version with <code>valid_from</code>, <code>valid_to</code> and <code>is_current</code></td><td>Full history, point-in-time joins. More rows, more complex loads</td></tr>
  <tr><td>Type 3</td><td>Extra column for the previous value</td><td>Only one level of history</td></tr>
</table>

<h3>SCD Type 1 with MERGE</h3>
<pre><code>MERGE INTO dim_customer t
USING latest_changes s ON t.customer_id = s.customer_id
WHEN MATCHED AND s.op = 'DELETE' THEN DELETE
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED AND s.op != 'DELETE' THEN INSERT *;</code></pre>

<h3>SCD Type 2 with MERGE</h3>
<p>One MERGE has to do two things for a changed customer: close the current row and insert a new version. Each source row can only take one action, so stage every change twice. One copy has the real key (it matches and closes the old row) and one has a NULL merge key (it never matches, so it's inserted):</p>
<pre><code>MERGE INTO dim_customer t
USING (
  SELECT customer_id AS merge_key, * FROM updates
  UNION ALL
  SELECT NULL AS merge_key, u.* FROM updates u
  JOIN dim_customer d ON u.customer_id = d.customer_id AND d.is_current
  WHERE u.country &lt;&gt; d.country             -- only real changes get a new version
) s
ON t.customer_id = s.merge_key AND t.is_current
WHEN MATCHED AND t.country &lt;&gt; s.country THEN
  UPDATE SET is_current = false, valid_to = s.change_ts
WHEN NOT MATCHED THEN
  INSERT (customer_id, country, valid_from, valid_to, is_current)
  VALUES (s.customer_id, s.country, s.change_ts, NULL, true);</code></pre>

<h3>Building history from a change log</h3>
<p>When you have the full change history, window functions build SCD2 directly. Each version is valid until the next change for the same key:</p>
<pre><code>SELECT customer_id, country,
       change_ts AS valid_from,
       lead(change_ts) OVER (PARTITION BY customer_id ORDER BY change_ts) AS valid_to
FROM changes;</code></pre>
<p>A delete closes the last version: compute <code>lead</code> over all changes, deletes included, then filter the delete rows out.</p>

<h3>Let the pipeline do it</h3>
<p>In Lakeflow Declarative Pipelines, <code>AUTO CDC ... STORED AS SCD TYPE 2</code> does all this, including out-of-order events (<code>SEQUENCE BY</code>) and deletes. It maintains <code>__START_AT</code>/<code>__END_AT</code>.</p>

<h3>Using SCD2 in queries</h3>
<pre><code>-- attribute as it was when the order happened
SELECT o.order_id, d.country
FROM fact_orders o
JOIN dim_customer d
  ON o.customer_id = d.customer_id
 AND o.order_ts &gt;= d.valid_from
 AND (o.order_ts &lt; d.valid_to OR d.valid_to IS NULL);</code></pre>
<p>Alternatively, store the dimension's surrogate key on the fact row at load time, so a simple equi-join returns the historical version.</p>

<div class="callout"><strong>Exam tip:</strong> "Reports must show the region a customer belonged to at the time of each sale" → SCD Type 2. "Only the current address matters" → Type 1.</div>
`
  },

  // ---------------------------------------------------------------- performance & cost
  {
    id: "pro-layout", domain: "pro-perf", title: "Data Layout: Liquid Clustering, Skipping and File Maintenance", minutes: 12,
    body: `
<p>Most query speed on Delta comes from reading fewer files. That depends on statistics, file sizes and how rows are clustered.</p>

<h3>Data skipping</h3>
<ul>
  <li>Delta stores min/max/null-count statistics per file for the <strong>first 32 columns</strong> by default (<code>delta.dataSkippingNumIndexedCols</code>), or for the columns you list in <code>delta.dataSkippingStatsColumns</code>.</li>
  <li>A filter like <code>WHERE customer_id = 42</code> skips files whose min/max range can't contain 42. It only works well when similar values are stored together.</li>
  <li>Put commonly filtered columns among the indexed columns, and leave long free-text columns out (their stats are expensive and useless).</li>
</ul>

<h3>Liquid clustering</h3>
<pre><code>CREATE TABLE silver.events (...) CLUSTER BY (customer_id, event_date);
ALTER TABLE silver.events CLUSTER BY (event_type, event_date);  -- change keys, no rewrite
ALTER TABLE silver.events CLUSTER BY AUTO;                      -- let Databricks choose
OPTIMIZE silver.events;                                          -- incremental clustering</code></pre>
<ul>
  <li>Replaces both partitioning and Z-ordering for new tables. You can't combine it with either.</li>
  <li>Up to 4 clustering keys. Pick the columns most used in filters and joins. High cardinality is fine.</li>
  <li><code>OPTIMIZE</code> clusters incrementally: only new, unclustered data is rewritten. Z-order rewrites everything.</li>
  <li>Keys can change at any time, and new data follows the new keys.</li>
  <li><code>CLUSTER BY AUTO</code> (with predictive optimization) picks keys from the query history.</li>
  <li>With deletion vectors, it supports <strong>row-level concurrency</strong>: concurrent MERGE/UPDATE/DELETE on different rows don't conflict.</li>
</ul>

<h3>Partitioning and Z-order (older layouts)</h3>
<ul>
  <li>Partition only very large tables (around 1 TB or more), on a low-cardinality column, so each partition holds at least about 1 GB. Over-partitioning creates many small files and slows every query.</li>
  <li><code>OPTIMIZE t ZORDER BY (col)</code> co-locates values for skipping. It isn't incremental, and its effect weakens with each extra column.</li>
</ul>

<h3>File maintenance</h3>
<table class="ref">
  <tr><th>Command / feature</th><th>What it does</th></tr>
  <tr><td><code>OPTIMIZE</code></td><td>Compacts small files toward about 1 GB (and clusters, if configured)</td></tr>
  <tr><td>Optimized writes / auto compaction</td><td>Fewer, larger files at write time, and small-file compaction after writes (<code>delta.autoOptimize.optimizeWrite</code>, <code>delta.autoOptimize.autoCompact</code>)</td></tr>
  <tr><td><code>VACUUM</code></td><td>Deletes data files no longer referenced and older than the retention period (default 7 days, <code>delta.deletedFileRetentionDuration</code>)</td></tr>
  <tr><td>Deletion vectors</td><td>DELETE/UPDATE/MERGE mark rows as deleted instead of rewriting whole files. Much faster writes. Files are rewritten later by OPTIMIZE or <code>REORG TABLE ... APPLY (PURGE)</code></td></tr>
  <tr><td>Predictive optimization</td><td>Runs OPTIMIZE, VACUUM and ANALYZE automatically on Unity Catalog managed tables</td></tr>
  <tr><td><code>ANALYZE TABLE ... COMPUTE STATISTICS</code></td><td>Collects table and column statistics for the cost-based optimizer (join ordering, broadcast choices)</td></tr>
</table>
<ul>
  <li>Time travel needs both the log entries (<code>delta.logRetentionDuration</code>, default 30 days) and the data files (kept until VACUUM removes them after 7 days). After VACUUM you can't time travel further back than the retention period.</li>
  <li><code>VACUUM ... RETAIN 0 HOURS</code> is blocked by a safety check. Running it could break readers and streams still using old files.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Filters on a high-cardinality column, query patterns change over time" → liquid clustering. "Thousands of tiny files from a streaming write" → auto compaction / OPTIMIZE. "UPDATEs rewrite huge files" → deletion vectors.</div>
`
  },
  {
    id: "pro-spark-perf", domain: "pro-perf", title: "Diagnosing Performance: Query Profile, Skew, Spill and Caching", minutes: 12,
    body: `
<p>Slow Spark jobs usually come down to a few causes: too much data read, too much data shuffled, uneven partitions, or not enough memory. The Spark UI tells you which one.</p>

<h3>Reading the Spark UI</h3>
<table class="ref">
  <tr><th>Symptom in the UI</th><th>Likely cause</th><th>Fix</th></tr>
  <tr><td>One or a few tasks take much longer than the median (max ≫ 75th percentile) in a stage</td><td><strong>Data skew</strong> on a join or groupBy key</td><td>AQE skew join, salting, broadcasting the small side, handling NULL / hot keys separately</td></tr>
  <tr><td>"Spill (memory)" and "Spill (disk)" in task metrics</td><td>Partitions too big for executor memory</td><td>More shuffle partitions, memory-optimized workers, less data per partition</td></tr>
  <tr><td>Huge shuffle read/write</td><td>Wide transformations on lots of data</td><td>Filter and project earlier, broadcast join, pre-aggregate</td></tr>
  <tr><td>Scan reads all files ("files pruned: 0")</td><td>Filters don't match the layout</td><td>Clustering on filter columns, avoid functions on the filter column</td></tr>
  <tr><td>Many tiny tasks with high scheduler delay</td><td>Too many small partitions / files</td><td>OPTIMIZE, AQE coalescing, fewer shuffle partitions</td></tr>
  <tr><td>Long GC time</td><td>Memory pressure, often from large cached objects or Python UDFs</td><td>Avoid unnecessary caching, use built-in functions</td></tr>
</table>
<p>The <strong>SQL / DataFrame</strong> tab shows the physical plan with runtime metrics: rows per operator, join strategy (BroadcastHashJoin vs SortMergeJoin), files read and pruned. <code>df.explain("formatted")</code> shows the same plan before running.</p>

<h3>Adaptive Query Execution (AQE)</h3>
<p>AQE is on by default and re-plans queries at shuffle boundaries using real sizes. It does three things:</p>
<ul>
  <li><strong>Coalesces</strong> small shuffle partitions into fewer, larger ones.</li>
  <li><strong>Switches</strong> a sort-merge join to a broadcast join when one side turns out small.</li>
  <li><strong>Splits skewed partitions</strong> in sort-merge joins.</li>
</ul>

<h3>Settings to know</h3>
<table class="ref">
  <tr><th>Setting</th><th>Default</th><th>Notes</th></tr>
  <tr><td><code>spark.sql.shuffle.partitions</code></td><td>200</td><td>Partitions after a shuffle. Aim for roughly 100–200 MB each. Databricks also accepts <code>auto</code></td></tr>
  <tr><td><code>spark.sql.autoBroadcastJoinThreshold</code></td><td>10 MB</td><td>Tables smaller than this are broadcast. <code>F.broadcast(df)</code> forces it</td></tr>
  <tr><td><code>spark.sql.files.maxPartitionBytes</code></td><td>128 MB</td><td>Size of input splits when scanning files</td></tr>
</table>

<h3>The query profile</h3>
<p>For SQL warehouses and serverless compute, the <strong>query profile</strong> is the main diagnostic tool. It shows the operator tree with time, rows and memory per operator, and highlights the most expensive steps. Look for:</p>
<ul>
  <li><strong>Data-skipping inefficiency</strong>: the scan reads most files (files or bytes pruned near zero). Fix the layout (liquid clustering on the filter columns) or the predicate.</li>
  <li><strong>Join strategy</strong>: a shuffle hash or sort-merge join where one side is small enough to broadcast, or a join that explodes row counts (a missing join key).</li>
  <li><strong>Shuffle</strong>: large bytes written and read between stages, often from wide aggregations or joins on unfiltered data.</li>
  <li><strong>Spill</strong> and very uneven task times, as in the Spark UI.</li>
</ul>

<h3>Caching</h3>
<table class="ref">
  <tr><th>Cache</th><th>What it does</th></tr>
  <tr><td><strong>Disk cache</strong> (formerly Delta cache)</td><td>Automatically keeps copies of remote Parquet/Delta files on the workers' local SSDs. Repeated reads of the same data skip cloud storage. It's consistent: changed files are detected. On by default on suitable instance types and on SQL warehouses</td></tr>
  <tr><td>Spark cache (<code>df.cache()</code>)</td><td>Keeps a computed DataFrame in executor memory (and disk) for reuse inside one application. Manual; must be invalidated and unpersisted by you</td></tr>
  <tr><td>Query result cache</td><td>SQL warehouses return identical query results without re-running them, as long as the underlying tables haven't changed</td></tr>
</table>
<p>The disk cache helps dashboards and iterative analysis that read the same tables again and again. It doesn't help one-pass ETL that reads each file once.</p>

<h3>Common anti-patterns</h3>
<ul>
  <li><strong>Python UDFs</strong>: each row is serialized to a Python worker, and Photon can't run them. Use built-in functions, or vectorized pandas UDFs when you must.</li>
  <li><strong><code>collect()</code> / <code>toPandas()</code> on large data</strong>: pulls everything to the driver and causes driver OOM.</li>
  <li><strong>Caching everything</strong>: <code>cache()</code> only helps when a DataFrame is reused several times. Otherwise it wastes memory. Unpersist when done.</li>
  <li><strong><code>repartition()</code> without a reason</strong>: a full shuffle. <code>coalesce(n)</code> reduces partitions without shuffling.</li>
  <li><strong>Functions on filter columns</strong>, such as <code>WHERE year(order_ts) = 2024</code>, can defeat data skipping. Prefer a range on the raw column, or a generated column.</li>
  <li><strong>Calling <code>count()</code> or <code>display()</code> for debugging</strong> in production code triggers extra jobs.</li>
</ul>

<h3>Salting a skewed key</h3>
<pre><code>N = 8
big = big.withColumn("salt", (F.rand() * N).cast("int"))
small = small.crossJoin(spark.range(N).withColumnRenamed("id", "salt"))
joined = big.join(small, ["key", "salt"])</code></pre>
<p>Use salting only when AQE's skew handling and broadcasting aren't enough. It multiplies the small side by N.</p>

<div class="callout"><strong>Exam tip:</strong> One task out of 200 runs for 40 minutes while the rest finish in seconds → skew. Tasks spill to disk across the board → partitions too large or not enough memory. A join with a 5 MB lookup table uses SortMergeJoin → broadcast it.</div>
`
  },
  {
    id: "pro-cost", domain: "pro-perf", title: "Optimizing Compute Cost", minutes: 9,
    body: `
<p>Cost questions ask you to pick the cheapest compute that still meets the requirement, and to attribute and control spend.</p>

<h3>Choosing compute</h3>
<table class="ref">
  <tr><th>Workload</th><th>Cost-efficient choice</th></tr>
  <tr><td>Scheduled batch job</td><td>Serverless jobs, or a classic job cluster. Never an all-purpose cluster (higher DBU rate, idle time)</td></tr>
  <tr><td>Hourly incremental stream</td><td><code>availableNow</code> trigger on job compute, instead of a 24/7 cluster</td></tr>
  <tr><td>Declarative pipelines</td><td>Serverless pipelines, or triggered mode with autoscaling</td></tr>
  <tr><td>BI and SQL</td><td>Serverless SQL warehouse with a short auto-stop. Size up for slow queries, add clusters for concurrency</td></tr>
  <tr><td>Interactive development</td><td>Serverless notebooks, or all-purpose clusters with auto-termination and policies</td></tr>
</table>
<ul>
  <li>Serverless jobs and pipelines have a <strong>performance-optimized</strong> mode (fast start) and a <strong>standard</strong> mode (cheaper, slower start) for jobs that aren't time-critical.</li>
  <li>Classic clusters: autoscaling, spot instances for workers (keep the driver on-demand), and pools for faster starts.</li>
  <li>Photon costs more DBUs per hour but usually finishes SQL/DataFrame work much faster, so it often lowers total cost. It doesn't help Python UDFs or RDD code.</li>
</ul>

<h3>Controlling spend</h3>
<ul>
  <li><strong>Compute policies</strong> limit node types, max workers and DBU/hour, and enforce auto-termination and tags.</li>
  <li><strong>Serverless budget policies</strong> attach tags to serverless usage so it can be attributed to teams.</li>
  <li><strong>Custom tags</strong> flow to cloud bills and to <code>system.billing.usage</code>.</li>
  <li><strong>Budgets</strong> send alerts when spend for a scope passes a threshold.</li>
</ul>

<h3>Finding where money goes</h3>
<pre><code>SELECT u.usage_metadata.job_id,
       sum(u.usage_quantity * p.pricing.default) AS est_cost
FROM system.billing.usage u
JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
 AND u.usage_start_time &gt;= p.price_start_time
 AND (p.price_end_time IS NULL OR u.usage_start_time &lt; p.price_end_time)
WHERE u.usage_date &gt;= current_date() - INTERVAL 30 DAYS
GROUP BY ALL
ORDER BY est_cost DESC;</code></pre>
<ul>
  <li><code>system.billing.usage</code>: DBUs by SKU, workspace, date, with <code>usage_metadata</code> (job_id, cluster_id, warehouse_id, ...) and <code>custom_tags</code>.</li>
  <li><code>system.billing.list_prices</code>: list prices per SKU over time.</li>
  <li><code>system.lakeflow.job_run_timeline</code> and <code>system.compute.node_timeline</code> help explain why a job used what it used (long runs, idle nodes, low CPU).</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Reduce the cost of a streaming job that only needs hourly freshness" → switch from a continuous stream on an always-on cluster to <code>availableNow</code> on a schedule. "Which team spent the most on serverless?" → budget policies with tags + <code>system.billing.usage</code>.</div>
`
  },

  // ---------------------------------------------------------------- governance
  {
    id: "pro-uc-security", domain: "pro-security", title: "Fine-Grained Access: Privileges, Row Filters and Column Masks", minutes: 11,
    body: `
<h3>Privilege model recap</h3>
<ul>
  <li>To read a table you need <code>USE CATALOG</code> on the catalog, <code>USE SCHEMA</code> on the schema and <code>SELECT</code> on the table (or the schema/catalog, which inherits down).</li>
  <li>Writes need <code>MODIFY</code>. Creating objects needs <code>CREATE TABLE</code> / <code>CREATE SCHEMA</code> etc. on the parent.</li>
  <li>The <strong>owner</strong> of an object (and anyone with <code>MANAGE</code> on it) can grant privileges on it. Make groups or service principals owners of production objects, not individual people.</li>
  <li><code>BROWSE</code> lets people see metadata and request access without reading data.</li>
  <li>Grant to <strong>account-level groups</strong>, never to individual users.</li>
</ul>

<h3>Row filters</h3>
<pre><code>CREATE FUNCTION gov.region_filter(region STRING)
RETURN is_account_group_member('global_sales') OR region = 'EU';

ALTER TABLE sales.orders SET ROW FILTER gov.region_filter ON (region);</code></pre>
<p>The function returns a boolean per row. Rows where it's false are invisible to that user in every query, notebook and dashboard.</p>

<h3>Column masks</h3>
<pre><code>CREATE FUNCTION gov.mask_email(email STRING)
RETURN CASE WHEN is_account_group_member('pii_readers') THEN email
            ELSE regexp_replace(email, '^[^@]+', '***') END;

ALTER TABLE sales.customers ALTER COLUMN email SET MASK gov.mask_email;</code></pre>
<ul>
  <li>The mask function receives the column value (plus optional other columns via <code>USING COLUMNS</code>) and returns what the user sees.</li>
  <li>Use <code>is_account_group_member()</code> (account groups). <code>is_member()</code> checks legacy workspace-local groups.</li>
  <li>Filters and masks apply to the table itself, so every access path is covered.</li>
</ul>

<h3>Dynamic views (the older approach)</h3>
<pre><code>CREATE VIEW sales.orders_secure AS
SELECT order_id,
       CASE WHEN is_account_group_member('finance') THEN amount END AS amount
FROM sales.orders
WHERE is_account_group_member('global_sales') OR region = 'EU';</code></pre>
<p>Views still work, but users must be denied the base table and given the view instead. Row filters and masks protect the table directly. Views remain useful for sharing a curated subset, for example through Delta Sharing.</p>

<h3>Tag-based (ABAC) policies</h3>
<p>With <strong>attribute-based access control (ABAC)</strong>, you write a policy once at the catalog or schema level instead of attaching filters and masks to each table. A policy names:</p>
<ul>
  <li>the <strong>UDF</strong> to apply: a column mask function or a row filter function, as above;</li>
  <li>the <strong>principals</strong> it applies to, and those it exempts (for example everyone except <code>pii_readers</code>);</li>
  <li>a <strong>governed-tag condition</strong> that selects the columns or tables, for example columns tagged <code>pii = email</code>.</li>
</ul>
<p>Any column carrying the tag is masked automatically, in current <em>and future</em> tables, as soon as the tag is set. That's how you enforce masking across hundreds of tables. Governed tags are controlled at the account level, so only authorized people can add or remove them.</p>
<h3>Least privilege beyond tables</h3>
<ul>
  <li>Workspace objects have their own ACLs: jobs (CAN VIEW, CAN MANAGE RUN, IS OWNER), pipelines, notebooks and folders, SQL warehouses (CAN USE), clusters and compute policies.</li>
  <li>Give engineers CAN MANAGE RUN on production jobs rather than ownership. Production jobs should run as a service principal.</li>
  <li>Storage access goes through Unity Catalog <strong>storage credentials</strong> and <strong>external locations</strong> (READ FILES, WRITE FILES, CREATE EXTERNAL TABLE), not keys in code.</li>
</ul>

<h3>Secrets</h3>
<ul>
  <li><code>dbutils.secrets.get(scope, key)</code> in code, <code>secret(scope, key)</code> in SQL. Printed values are shown as <code>[REDACTED]</code>.</li>
  <li>Secret scope ACLs (READ, WRITE, MANAGE) control who can use them. Prefer UC connections and storage credentials, which need no secrets in code at all.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Analysts in each country must see only their country's rows in the same table" → row filter using group membership or a mapping table. "Mask SSNs for everyone except HR, across all access paths" → column mask (or an ABAC policy on a tag).</div>
`
  },
  {
    id: "pro-compliance", domain: "pro-security", title: "Compliance: PII, Deletes, Audit and Lineage", minutes: 10,
    body: `
<h3>Right to be forgotten</h3>
<p>Under GDPR/CCPA, deleting a person means removing their data from every layer and from history.</p>
<ol>
  <li><code>DELETE</code> the person's rows from bronze, silver and gold. Propagate deletes downstream with Change Data Feed or AUTO CDC, not one-off scripts per table.</li>
  <li>The deleted rows still exist in older files, reachable through time travel. Run <code>VACUUM</code> after the retention period to remove them physically.</li>
  <li>With <strong>deletion vectors</strong>, a DELETE only marks rows. Run <code>REORG TABLE t APPLY (PURGE)</code> to rewrite the affected files, then <code>VACUUM</code>.</li>
  <li>Check the <code>_change_data</code> files (CDF) and any copies, such as exports and ML feature tables.</li>
  <li>Streams that read a table with deletes need <code>skipChangeCommits</code>, or must read the CDF, so they don't fail.</li>
</ol>
<p>Keep the retention short enough to meet the legal deadline (often 30 days), but long enough for your time-travel and streaming needs.</p>
<p>A <strong>retention policy</strong> ("keep raw events for 13 months") is the same mechanism on a schedule: a job deletes rows older than the limit, for example by date or clustering key so it touches few files, then purge and VACUUM run. Predictive optimization runs VACUUM for managed tables automatically.</p>

<h3>Anonymization and pseudonymization techniques</h3>
<table class="ref">
  <tr><th>Technique</th><th>Example</th><th>Reversible?</th></tr>
  <tr><td><strong>Hashing</strong> (salted, or keyed with a secret)</td><td><code>sha2(concat(email, secret('kv','salt')), 256)</code></td><td>No, but the same input gives the same output, so joins still work. Unsalted hashes of guessable values can be matched</td></tr>
  <tr><td><strong>Tokenization</strong></td><td>Replace the SSN with a random token; the mapping lives in a restricted vault table</td><td>Only for those allowed to read the mapping</td></tr>
  <tr><td><strong>Suppression</strong></td><td>Drop or NULL out a column, or mask it entirely (<code>'***'</code>)</td><td>No</td></tr>
  <tr><td><strong>Generalization</strong></td><td>Birth date → birth year, exact age → age band, postcode → region</td><td>No. Keeps analytical value with less identifiability</td></tr>
  <tr><td><strong>Partial masking</strong></td><td>Show the last 4 digits of a card number</td><td>No</td></tr>
</table>
<p>Pseudonymized data (hashing, tokenization) is still personal data under GDPR, because it can be re-linked with extra information. Anonymized data (suppression, generalization done properly) is not.</p>
<h3>PII detection and masking in pipelines</h3>
<ul>
  <li><strong>Data classification</strong> in Unity Catalog scans tables and flags or tags columns that look like PII (emails, phone numbers, ...). With ABAC policies matching those tags, new PII is masked as it's detected.</li>
  <li>For free text, <code>ai_mask(text, ARRAY('person', 'email', 'phone'))</code> redacts entities inside a pipeline, batch or streaming, before data reaches silver.</li>
  <li>Apply the same controls to streaming and batch: masks and filters live on the table, so every reader is covered whatever wrote the data.</li>
</ul>
<h3>Pseudonymization in practice</h3>
<ul>
  <li>Replace direct identifiers with a key, such as a salted hash or a random token. Keep the key-to-person mapping in a separate, tightly restricted table.</li>
  <li>To forget a person, delete their row in the mapping table. The remaining data can no longer be linked to them.</li>
  <li>A plain unsalted hash of an email is <em>not</em> anonymous. It can be reversed by hashing known emails.</li>
</ul>

<h3>Audit and lineage</h3>
<table class="ref">
  <tr><th>System table</th><th>Answers</th></tr>
  <tr><td><code>system.access.audit</code></td><td>Who did what: logins, grants, table reads/writes, secret access, job changes (<code>service_name</code>, <code>action_name</code>, <code>user_identity</code>, <code>request_params</code>)</td></tr>
  <tr><td><code>system.access.table_lineage</code> / <code>column_lineage</code></td><td>Which tables and columns feed which, captured automatically for UC queries</td></tr>
  <tr><td><code>DESCRIBE HISTORY t</code></td><td>Every write to a Delta table: operation, user, job, parameters, metrics</td></tr>
</table>
<pre><code>-- who changed grants on the finance catalog in the last week?
SELECT event_time, user_identity.email, action_name, request_params
FROM system.access.audit
WHERE service_name = 'unityCatalog'
  AND action_name IN ('updatePermissions')
  AND event_time &gt;= now() - INTERVAL 7 DAYS;</code></pre>
<p>Lineage is useful for impact analysis (what breaks if I change this column?) and for compliance (where does this PII column flow?).</p>

<h3>Other controls</h3>
<ul>
  <li><strong>Tags and comments</strong> on catalogs, tables and columns document sensitivity and drive ABAC policies.</li>
  <li><strong>Data classification</strong> can scan tables and suggest tags for sensitive columns.</li>
  <li><strong>Encryption</strong>: storage encryption at rest, customer-managed keys for stricter requirements, TLS in transit.</li>
  <li><strong>Managed vs external tables</strong>: dropping a managed table deletes its data. For an external table, only metadata is removed. Managed tables also get predictive optimization.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Deleted a customer, but they're still visible with VERSION AS OF" → the old files still exist until VACUUM runs after the retention period. With deletion vectors enabled, purge first.</div>
`
  },

  // ---------------------------------------------------------------- sharing
  {
    id: "pro-delta-sharing", domain: "pro-ingest", title: "Delta Sharing and Clean Rooms", minutes: 10,
    body: `
<p>Delta Sharing is an open protocol for sharing live data without copying it. The provider keeps the data. The recipient reads it directly from the provider's storage, with access controlled by the provider.</p>

<h3>Two kinds of recipient</h3>
<table class="ref">
  <tr><th></th><th>Databricks-to-Databricks</th><th>Open sharing</th></tr>
  <tr><td>Recipient</td><td>Another Unity Catalog metastore (any cloud or region), identified by its <strong>sharing identifier</strong></td><td>Any client: pandas, Spark, Power BI, Tableau, ...</td></tr>
  <tr><td>Auth</td><td>Handled by Databricks, no tokens</td><td>Activation link → credential file with a bearer token, or OIDC federation</td></tr>
  <tr><td>Shareable</td><td>Tables (with history), views, materialized views, streaming tables, volumes, notebooks, models</td><td>Mainly tables and views</td></tr>
  <tr><td>On the recipient side</td><td>A catalog created from the share, governed with UC grants</td><td>Read through the connector</td></tr>
</table>

<h3>Provider steps</h3>
<pre><code>CREATE SHARE retail_share COMMENT 'Orders for partner X';

ALTER SHARE retail_share ADD TABLE main.sales.orders
  PARTITION (region = 'EU')      -- only share EU data
  WITH HISTORY;                  -- allow time travel, CDF and streaming reads

CREATE RECIPIENT partner_x USING ID 'azure:westeurope:1234-abcd...';
GRANT SELECT ON SHARE retail_share TO RECIPIENT partner_x;</code></pre>
<pre><code>-- recipient (Databricks-to-Databricks)
CREATE CATALOG partner_data USING SHARE provider_name.retail_share;</code></pre>
<ul>
  <li>Shares are <strong>read-only</strong> for the recipient.</li>
  <li><code>WITH HISTORY</code> lets recipients stream from the shared table and read its Change Data Feed.</li>
  <li>Share a <strong>view</strong> to expose a subset of columns or computed values. Recipient properties with <code>CURRENT_RECIPIENT('country')</code> in a view filter rows per recipient.</li>
  <li>Revoke or drop the recipient to cut off access immediately.</li>
</ul>

<h3>Costs and performance</h3>
<ul>
  <li>The provider pays for storage, and pays <strong>egress</strong> when recipients read across regions or clouds. For heavy cross-region use, consider replicating the data to the recipient's region, or storage without egress fees.</li>
  <li>Data isn't copied, so recipients always see the latest version (or a chosen version if history is shared).</li>
</ul>

<h3>Clean rooms and Marketplace</h3>
<ul>
  <li><strong>Clean rooms</strong> let several parties combine data without seeing each other's raw rows. Only approved notebooks run, and only their outputs are shared. Use them for joint analysis on sensitive data, such as advertiser and publisher audience overlap.</li>
  <li><strong>Databricks Marketplace</strong> publishes datasets, models and notebooks to many consumers, using Delta Sharing underneath.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "A partner on another cloud uses Databricks and needs live access to a table, without copies" → Databricks-to-Databricks Delta Sharing. "A partner without Databricks wants to read it into pandas" → open sharing. "Two companies need to compute an overlap without exposing customers" → clean room.</div>
`
  },
  {
    id: "pro-federation", domain: "pro-ingest", title: "Lakehouse Federation and Lakeflow Connect", minutes: 8,
    body: `
<p>Not all data needs to be copied into Delta. <strong>Lakehouse Federation</strong> lets Unity Catalog query external databases in place, with UC permissions and lineage.</p>

<h3>Query federation</h3>
<pre><code>CREATE CONNECTION pg_sales TYPE postgresql
OPTIONS (host 'pg.example.com', port '5432',
         user secret('fed', 'pg_user'), password secret('fed', 'pg_password'));

CREATE FOREIGN CATALOG sales_pg USING CONNECTION pg_sales
OPTIONS (database 'sales');

SELECT * FROM sales_pg.public.customers WHERE country = 'DE';</code></pre>
<ul>
  <li>Sources include PostgreSQL, MySQL, SQL Server, Oracle, Snowflake, BigQuery, Redshift, Teradata and other Databricks workspaces.</li>
  <li>Foreign catalogs are <strong>read-only</strong>. Grants, tags and lineage apply as for any UC catalog.</li>
  <li>Filters, projections, limits and some aggregates and joins are <strong>pushed down</strong> to the source. The rest runs in Databricks.</li>
  <li>Every query hits the source system, so performance depends on it, and heavy queries load the operational database.</li>
</ul>

<h3>Catalog federation</h3>
<p>For a Hive metastore or AWS Glue, <strong>catalog federation</strong> reads table data directly from object storage instead of going through a database engine. It's a common step in migrating to Unity Catalog.</p>

<h3>Federate or ingest?</h3>
<table class="ref">
  <tr><th>Federate when</th><th>Ingest (copy to Delta) when</th></tr>
  <tr><td>Ad-hoc exploration, proofs of concept</td><td>Queries run often or scan a lot of data</td></tr>
  <tr><td>Small reference data that must be live</td><td>You need history, time travel or joins with large lake tables</td></tr>
  <tr><td>Data can't be copied (policy) or the migration is still in progress</td><td>The source can't take the analytical load</td></tr>
</table>
<p>To materialize federated data, use <code>CREATE TABLE ... AS SELECT</code> from the foreign catalog, or a materialized view. For ongoing replication from databases and SaaS apps (SQL Server, Salesforce, Workday, ...), use <strong>Lakeflow Connect</strong> managed connectors. They load incrementally, often using the source's change tracking, into streaming tables.</p>

<div class="callout"><strong>Exam tip:</strong> "Analysts need to join a small, frequently changing PostgreSQL table with lake data, without building a pipeline" → Lakehouse Federation. "A dashboard runs heavy queries against the operational database every minute and slows it down" → ingest instead.</div>
`
  },

  // ---------------------------------------------------------------- monitoring & debugging
  {
    id: "pro-observability", domain: "pro-monitor", title: "System Tables, Alerts and Pipeline Monitoring", minutes: 11,
    body: `
<h3>System tables</h3>
<p>System tables are Databricks-managed Delta tables in the <code>system</code> catalog. An account admin enables schemas, and access is granted like any UC object.</p>
<table class="ref">
  <tr><th>Table</th><th>Use it to</th></tr>
  <tr><td><code>system.billing.usage</code></td><td>Track DBU consumption by job, warehouse, tag, SKU</td></tr>
  <tr><td><code>system.access.audit</code></td><td>Audit user and service actions</td></tr>
  <tr><td><code>system.lakeflow.jobs</code>, <code>job_run_timeline</code>, <code>job_task_run_timeline</code></td><td>Find failing, slow or flaky jobs and tasks</td></tr>
  <tr><td><code>system.compute.clusters</code>, <code>node_timeline</code></td><td>Cluster configs over time, node CPU/memory utilization</td></tr>
  <tr><td><code>system.query.history</code></td><td>SQL warehouse and serverless query durations, users, statements</td></tr>
  <tr><td><code>system.storage.predictive_optimization_operations_history</code></td><td>What predictive optimization ran and what it cost</td></tr>
</table>
<pre><code>-- jobs whose runs failed in the last day
SELECT job_id, run_id, result_state, period_start_time
FROM system.lakeflow.job_run_timeline
WHERE result_state IN ('FAILED', 'TIMED_OUT')
  AND period_start_time &gt;= now() - INTERVAL 1 DAY;</code></pre>

<h3>Alerting</h3>
<ul>
  <li><strong>Alerts</strong> (Databricks SQL / Lakehouse alerts) run a query on a schedule and notify when a condition is met. Anything you can query can be alerted on: governed business metrics, data quality and anomaly signals, usage and cost from system tables, SQL warehouse and query health, audit and security events. Alerts can also be added as tasks in Lakeflow Jobs, so a job can branch on the result (for example, a quarantine row count &gt; 0, or freshness older than 2 hours). Destinations include email, Slack, Teams, PagerDuty and webhooks.</li>
  <li><strong>Job notifications</strong> on start, success, failure, and duration warnings. Health rules such as <code>RUN_DURATION_SECONDS</code> warn when a run takes longer than expected, and streaming backlog rules warn when consumers fall behind.</li>
  <li><strong>Job settings</strong>: retries per task, timeouts, and max concurrent runs, so a slow run doesn't overlap the next one.</li>
</ul>

<h3>Pipeline event log</h3>
<pre><code>SELECT timestamp, details:flow_progress.data_quality.expectations
FROM event_log(TABLE(main.sales.orders_silver))
WHERE event_type = 'flow_progress';</code></pre>
<p>Every Lakeflow Declarative Pipeline writes an event log with run progress, lineage, cluster events and <strong>expectation metrics</strong> (passed/failed records per rule). Query it with <code>event_log()</code>, or publish it to a table, to build data-quality dashboards and alerts.</p>

<h3>REST API, CLI and SDK</h3>
<pre><code>databricks jobs list-runs --job-id 123456 --active-only
databricks jobs get-run 987654          # state, tasks, start/end times, cluster
databricks pipelines list-updates &lt;pipeline-id&gt;</code></pre>
<pre><code>from databricks.sdk import WorkspaceClient
w = WorkspaceClient()
for run in w.jobs.list_runs(job_id=123456, limit=20):
    print(run.run_id, run.state.result_state, run.execution_duration)</code></pre>
<p>Use these from external schedulers, CI pipelines or on-call tooling to check run state, fetch task output and errors, and trigger repairs. For history across all jobs, query the system tables instead of looping over the API.</p>

<h3>Jobs UI</h3>
<p>The job's <strong>Runs</strong> tab shows a matrix of recent runs per task (status, duration), so you can spot a task that is getting slower or failing intermittently. A run's page shows the task graph, the timeline, the parameters, and each task's output and logs. The job-level <strong>Monitoring</strong> views and <code>system.lakeflow</code> tables cover trends across many runs.</p>

<h3>Streaming query metrics</h3>
<ul>
  <li><code>query.lastProgress</code> / <code>recentProgress</code> show per-batch metrics: <code>numInputRows</code>, <code>inputRowsPerSecond</code>, <code>processedRowsPerSecond</code>, batch duration, state size.</li>
  <li>If <strong>input rate &gt; processing rate</strong> over time, the stream is falling behind. Batch durations grow and the source backlog increases.</li>
  <li>A <code>StreamingQueryListener</code> (Python <code>onQueryProgress</code>) pushes these metrics to your own monitoring system.</li>
</ul>

<h3>Data quality monitoring</h3>
<p>Lakehouse Monitoring (data profiling) attaches to a table and computes profile metrics and drift over time. It writes them to a <strong>profile metrics table</strong> and a <strong>drift metrics table</strong>, with a generated dashboard. Profiles can be <em>snapshot</em>, <em>time series</em> or <em>inference</em> (for ML model tables), and you can add custom metrics. Alerts on these tables catch problems like a sudden rise in nulls or a shift in distributions.</p>

<div class="callout"><strong>Exam tip:</strong> "Notify the team when more than 1% of rows fail expectations" → query the event log (or the quarantine table) in a SQL alert. "Find which jobs cost the most last month" → <code>system.billing.usage</code> grouped by <code>usage_metadata.job_id</code>.</div>
`
  },
  {
    id: "pro-debugging", domain: "pro-deploy", title: "Debugging Failed and Slow Jobs", minutes: 10,
    body: `
<h3>Where to look</h3>
<table class="ref">
  <tr><th>Source</th><th>Shows</th></tr>
  <tr><td>Job run page</td><td>Task graph, which task failed, the error and the notebook output at the point of failure, parameters used</td></tr>
  <tr><td>Driver logs (stdout, stderr, log4j)</td><td>Full stack traces, print/log output, Python errors</td></tr>
  <tr><td>Cluster event log</td><td>Starts, resizes, spot instance losses, termination reasons, init script failures</td></tr>
  <tr><td>Spark UI</td><td>Jobs, stages, tasks, skew, spill, the SQL plan with metrics, executor memory/GC</td></tr>
  <tr><td>Query profile (SQL warehouses and serverless)</td><td>Operator-level time and rows for a SQL query</td></tr>
  <tr><td>System tables</td><td>Patterns across runs: <code>system.lakeflow.job_task_run_timeline</code> (which task fails or slows down, since when), <code>system.compute.node_timeline</code> (CPU and memory per node), <code>system.query.history</code> (slow or failed SQL)</td></tr>
</table>

<h3>Repair and re-run</h3>
<ul>
  <li><strong>Repair run</strong> re-runs only the failed tasks and the tasks that depend on them in a multi-task job. Successful tasks aren't repeated, so you save time and cost.</li>
  <li><strong>Parameter overrides</strong>: a repair (or a manual run) can override job parameters, for example to re-run with the correct <code>run_date</code> after a bad parameter caused the failure.</li>
  <li>Task-level <strong>retries</strong> handle transient failures (spot loss, throttling). Code bugs need a fix, not retries.</li>
</ul>

<h3>Common failures</h3>
<table class="ref">
  <tr><th>Error</th><th>Cause and fix</th></tr>
  <tr><td>Driver OOM / "driver is temporarily unavailable"</td><td><code>collect()</code>/<code>toPandas()</code> of large data, huge broadcast, too many small files in the listing. Keep work distributed, or use a bigger driver</td></tr>
  <tr><td>Executor OOM, lost executors</td><td>Skewed or oversized partitions. More partitions, fix skew, memory-optimized nodes</td></tr>
  <tr><td><code>ConcurrentAppendException</code> / <code>ConcurrentDeleteReadException</code></td><td>Two writers touched the same files. Separate their data with explicit predicates (e.g. on partition or clustering columns), use row-level concurrency (liquid clustering + deletion vectors), or serialize the jobs</td></tr>
  <tr><td><code>DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW_IN_MERGE</code></td><td>Duplicate keys in the MERGE source. Deduplicate first</td></tr>
  <tr><td>Schema mismatch on write</td><td>New or changed columns. <code>mergeSchema</code> for additions, explicit casts for types</td></tr>
  <tr><td>Stream fails after the source table had an UPDATE/DELETE</td><td>Delta streaming sources expect append-only. <code>skipChangeCommits</code>, or read the CDF</td></tr>
  <tr><td>Stream fails on restart after a code change</td><td>An incompatible change to stateful logic. Needs a new checkpoint</td></tr>
  <tr><td><code>FileNotFoundException</code> on a Delta table</td><td>Files removed by VACUUM while a long query or stream still needed them, or by manual deletion. Never delete Delta files by hand</td></tr>
</table>

<h3>Debugging code</h3>
<ul>
  <li>Notebooks have an interactive <strong>Python debugger</strong> (breakpoints, variable inspection) on supported compute.</li>
  <li>Reproduce with a small sample. <code>df.explain()</code> shows the plan without running it.</li>
  <li>Use logging (<code>logging</code> module) instead of print in production code. It goes to the driver logs.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Task 4 of 6 failed after tasks 1–3 took 2 hours" → fix the issue, then <strong>repair the run</strong> so only task 4 and its downstream tasks run.</div>
`
  },

  // ---------------------------------------------------------------- deployment
  {
    id: "pro-bundles", domain: "pro-deploy", title: "Declarative Automation Bundles and Git-Based CI/CD", minutes: 12,
    body: `
<p><strong>Declarative Automation Bundles</strong> (formerly Databricks Asset Bundles, or DABs) describe a project as code: jobs, pipelines and other resources, plus your source files, in YAML. You validate and deploy them to each environment with the Databricks CLI.</p>

<h3>A bundle</h3>
<pre><code># databricks.yml
bundle:
  name: orders_pipeline

include:
  - resources/*.yml

variables:
  catalog:
    default: dev

targets:
  dev:
    mode: development          # prefixes names with [dev user], pauses schedules
    default: true
    workspace:
      host: https://adb-111.azuredatabricks.net
  prod:
    mode: production           # extra checks
    workspace:
      host: https://adb-222.azuredatabricks.net
      root_path: /Workspace/Shared/.bundle/orders_pipeline
    variables:
      catalog: prod
    run_as:
      service_principal_name: 6f2c...-sp</code></pre>
<pre><code># resources/orders_job.yml
resources:
  jobs:
    orders_job:
      name: orders_job
      tasks:
        - task_key: ingest
          notebook_task:
            notebook_path: ../src/ingest.ipynb
            base_parameters:
              catalog: \${var.catalog}
        - task_key: transform
          depends_on: [{ task_key: ingest }]
          pipeline_task:
            pipeline_id: \${resources.pipelines.orders_pipeline.id}</code></pre>

<h3>CLI workflow</h3>
<pre><code>databricks bundle init              # start from a template
databricks bundle validate -t dev   # check YAML and references
databricks bundle deploy -t dev     # upload files, create/update resources
databricks bundle run -t dev orders_job
databricks bundle deploy -t prod    # usually from CI, as a service principal
databricks bundle destroy -t dev    # remove what the bundle deployed</code></pre>
<ul>
  <li><strong>Development mode</strong> gives every developer an isolated copy: names are prefixed, schedules and triggers are paused, and concurrent runs are allowed.</li>
  <li><strong>Production mode</strong> checks that the deployment is safe, for example by refusing to override <code>run_as</code> and pausing in some situations, and usually runs as a <strong>service principal</strong>.</li>
  <li>Variables and per-target overrides keep one definition for all environments: catalog names, cluster sizes, schedules.</li>
  <li>Bundles can build artifacts such as Python wheels and deploy them with the job.</li>
</ul>

<h3>Git folders</h3>
<ul>
  <li><strong>Git folders</strong> (formerly Repos) clone a remote repository into the workspace. Developers branch, commit, pull and push from the UI, and notebooks are stored as source files.</li>
  <li>For production, either deploy with a bundle from CI, or have a job use a <strong>Git source</strong> (a repository URL and branch or tag) so each run checks out exactly that version.</li>
  <li>An automation-owned Git folder in a shared location can be updated by CI through the Repos API (<code>PATCH /api/2.0/repos/{id}</code> to a branch or tag) after tests pass.</li>
</ul>

<h3>A typical CI/CD flow</h3>
<ol>
  <li>Developers work in a <strong>Git folder</strong> (formerly Repos) on a feature branch and deploy to dev with <code>-t dev</code>.</li>
  <li>A pull request triggers CI: lint, unit tests, <code>bundle validate</code>, and optionally deploy to a staging workspace and run integration tests.</li>
  <li>Merging to main deploys to prod with <code>bundle deploy -t prod</code>, authenticated as a service principal. Use OAuth, ideally workload identity federation, rather than personal access tokens.</li>
  <li>Production jobs run as service principals and reference deployed code, never a user's personal folder.</li>
</ol>

<h3>Jobs features that show up on the exam</h3>
<ul>
  <li><strong>Task values</strong>: <code>dbutils.jobs.taskValues.set(key, value)</code> in one task, and <code>{{tasks.ingest.values.row_count}}</code> or <code>taskValues.get</code> in later tasks.</li>
  <li><strong>If/else condition</strong> tasks branch on a value. <strong>For each</strong> tasks run a nested task for each item in a list.</li>
  <li><strong>Job parameters</strong> are passed to all tasks (<code>{{job.parameters.run_date}}</code>), along with dynamic values like <code>{{job.start_time.iso_date}}</code>.</li>
  <li><strong>Triggers</strong>: schedule (cron), file arrival, table update, continuous.</li>
  <li><strong>Run if</strong> conditions (all succeeded, at least one failed, all done) for cleanup or notification tasks.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Deploy the same jobs and pipelines to dev, test and prod with different catalogs, from version control" → Declarative Automation Bundles with targets and variables, deployed by CI as a service principal.</div>
`
  },
  {
    id: "pro-testing", domain: "pro-code", title: "Testing PySpark and SQL Pipelines", minutes: 10,
    body: `
<p>Code that can't be tested can't be deployed safely. The key is to separate transformation logic from I/O.</p>

<h3>Make logic testable</h3>
<pre><code># src/orders/transforms.py
from pyspark.sql import DataFrame, Window, functions as F

def latest_per_key(df: DataFrame, key: str, order_col: str) -&gt; DataFrame:
    w = Window.partitionBy(key).orderBy(F.col(order_col).desc())
    return df.withColumn("_rn", F.row_number().over(w)).filter("_rn = 1").drop("_rn")</code></pre>
<ul>
  <li>Put functions that take and return DataFrames in Python modules (workspace files or a wheel), not inside notebooks.</li>
  <li>Notebooks, or the job's entry point, only read inputs, call the functions and write outputs.</li>
  <li>Import modules with normal <code>import</code> statements. <code>%run</code> pulls another notebook's code into the current one, which is harder to test and version.</li>
</ul>

<h3>Unit tests</h3>
<pre><code># tests/test_transforms.py
from pyspark.testing import assertDataFrameEqual
from orders.transforms import latest_per_key

def test_latest_per_key(spark):
    df = spark.createDataFrame([(1, 1, "a"), (1, 2, "b"), (2, 1, "c")], "id int, seq int, v string")
    expected = spark.createDataFrame([(1, 2, "b"), (2, 1, "c")], "id int, seq int, v string")
    assertDataFrameEqual(latest_per_key(df, "id", "seq"), expected)</code></pre>
<ul>
  <li>Run with <code>pytest</code>, using a local SparkSession or <strong>Databricks Connect</strong> (runs your local code against remote Databricks compute).</li>
  <li><code>assertDataFrameEqual</code> and <code>assertSchemaEqual</code> (from <code>pyspark.testing</code>) compare DataFrames and ignore row order by default.</li>
  <li>Test the edge cases: duplicates, NULLs, late data, empty input, schema changes.</li>
</ul>

<h3>Test levels</h3>
<table class="ref">
  <tr><th>Level</th><th>What</th><th>Where</th></tr>
  <tr><td>Unit</td><td>Single functions on small in-memory DataFrames</td><td>Every commit, in CI</td></tr>
  <tr><td>Integration</td><td>The whole job or pipeline on test data, with real tables</td><td>Staging workspace, deployed by the bundle</td></tr>
  <tr><td>Data quality</td><td>Expectations, constraints, row-count and freshness checks</td><td>Every production run</td></tr>
</table>

<h3>SQL code</h3>
<ul>
  <li>Keep SQL in files and parameterize the catalog and schema (bundle variables, job parameters, or <code>IDENTIFIER(:catalog || '.sales.orders')</code>).</li>
  <li>Test SQL transformations by running them on a small fixture schema in a test catalog, and comparing with expected results.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Make transformation logic in notebooks unit-testable" → move it into functions in Python modules, test with pytest and <code>assertDataFrameEqual</code>, and keep notebooks as thin entry points.</div>
`
  }
);

// ---------------------------------------------------------------- lessons for the Oct 2026 objectives
TRAINER.lessons.push(
  {
    id: "pro-jobs-dev", domain: "pro-code", title: "Projects, Dependencies, UDFs and Lakeflow Jobs", minutes: 14,
    body: `
<p>Section 1 of the exam starts before any data moves: how the code is organized, how its libraries get installed, which compute runs it, and how jobs chain the steps together.</p>

<h3>A Python project in a bundle</h3>
<pre><code>orders_project/
  databricks.yml            # bundle: targets, variables, includes
  resources/
    orders_job.yml          # jobs and pipelines as YAML
    orders_pipeline.yml
  src/orders/               # importable package: transformations, utils
    __init__.py
    transforms.py
  notebooks/ingest.ipynb    # thin entry points that call the package
  tests/test_transforms.py  # pytest
  pyproject.toml            # package metadata and dependencies (builds a wheel)</code></pre>
<ul>
  <li>Logic lives in a package under <code>src/</code>, so it can be imported by jobs, pipelines and tests. Notebooks stay thin.</li>
  <li>The bundle can build the package into a wheel (an <code>artifacts</code> entry) and attach it to tasks, or tasks can run a <code>python_wheel_task</code>.</li>
  <li>One repository and one bundle per deployable unit keeps CI/CD simple: validate, test, deploy per target.</li>
</ul>

<h3>Dependencies and how they fail</h3>
<table class="ref">
  <tr><th>Where</th><th>How dependencies are declared</th></tr>
  <tr><td>Serverless notebooks and jobs</td><td>An <strong>environment</strong>: an environment version (the base image) plus a dependency list of PyPI packages, wheel files in volumes or workspace files, or a <code>requirements.txt</code></td></tr>
  <tr><td>Lakeflow Pipelines</td><td>The pipeline's environment settings (dependencies installed for the whole pipeline), not <code>%pip</code> in each source file</td></tr>
  <tr><td>Classic clusters</td><td>Cluster libraries, notebook-scoped <code>%pip install</code>, or init scripts</td></tr>
  <tr><td>Bundles</td><td><code>environments</code> or <code>libraries</code> on tasks, pointing to PyPI packages or wheels the bundle builds</td></tr>
</table>
<p>Typical problems and fixes:</p>
<ul>
  <li><strong>Version conflict</strong> with a library already in the runtime or environment: pin compatible versions, or move to an environment version that ships what you need. Don't silently upgrade core packages like <code>pyspark</code> or <code>numpy</code>.</li>
  <li><strong>Installation fails on serverless</strong> because the package needs a private index or isn't on PyPI: point to a private index or upload the wheel to a Unity Catalog volume and reference it. Init scripts aren't available on serverless.</li>
  <li><strong>Wheel not found or permission denied</strong>: the run identity needs READ VOLUME on the volume holding the wheel.</li>
  <li><strong>Notebook keeps the old version</strong> after <code>%pip install</code>: restart Python with <code>dbutils.library.restartPython()</code>.</li>
  <li><strong>Source archives</strong> (sdist, <code>.tar.gz</code>) that need compilers may fail where wheels install fine: build a wheel in CI and deploy that.</li>
</ul>

<h3>Choosing compute</h3>
<ul>
  <li><strong>Serverless</strong> (jobs, pipelines, notebooks): starts in seconds and needs no cluster tuning. Jobs and pipelines can run in <em>performance-optimized</em> mode (fast start, higher cost) or <em>standard</em> mode (cheaper, slower start). Serverless notebooks offer a <strong>high-memory</strong> option for tasks that run out of memory.</li>
  <li>Serverless jobs apply automatic optimization, which includes <strong>automatic retries</strong> of failed tasks. Turn retries off for a task whose side effects aren't idempotent, for example one that calls an external API or sends emails.</li>
  <li><strong>Classic job clusters</strong> are still the choice when you need specific instance types (GPUs, very large memory), init scripts, or custom Spark settings.</li>
</ul>

<h3>User-defined functions</h3>
<table class="ref">
  <tr><th>Kind</th><th>Example</th><th>Use when</th></tr>
  <tr><td>SQL UDF</td><td><code>CREATE FUNCTION main.util.net(a DOUBLE, d DOUBLE) RETURN a - d</code></td><td>Logic expressible in SQL. Inlined by the optimizer, so it's fast and Photon can run it</td></tr>
  <tr><td>Unity Catalog Python UDF</td><td><code>CREATE FUNCTION main.util.slug(s STRING) RETURNS STRING LANGUAGE PYTHON AS $$ ... $$</code></td><td>Python logic that should be governed (grants, lineage) and reusable from SQL and Python</td></tr>
  <tr><td>Pandas UDF</td><td><code>@F.pandas_udf("double")</code> over a <code>pd.Series</code></td><td>Python logic on large data: vectorized with Arrow, much faster than row-at-a-time</td></tr>
  <tr><td>Python UDF</td><td><code>@F.udf("string")</code></td><td>Small data, or logic no other option can express. Slowest</td></tr>
</table>
<p>Always check first whether a built-in function does the job. UDFs are opaque to the optimizer and can't push filters down.</p>

<h3>Lakeflow Jobs: UI, API and CLI</h3>
<pre><code>databricks jobs create --json @orders_job.json
databricks jobs run-now 123456 --json '{"job_parameters": {"run_date": "2026-10-01"}}'
databricks jobs list-runs --job-id 123456</code></pre>
<p>The same operations are available in the REST API (<code>/api/2.2/jobs/create</code>, <code>/jobs/run-now</code>, <code>/jobs/runs/get</code>), the Python SDK (<code>WorkspaceClient().jobs</code>) and bundles. Use bundles for anything that should be versioned. Use the API or CLI for automation around runs, such as triggering a job from another system.</p>

<h3>Control flow</h3>
<ul>
  <li><strong>If/else condition</strong> task: compares a job parameter or task value, such as <code>{{tasks.check.values.new_rows}} &gt; 0</code>, and runs the true or false branch.</li>
  <li><strong>For each</strong> task: runs a nested task once per item of a list (a JSON array, often a task value), with a concurrency limit.</li>
  <li><strong>Run if</strong> on dependencies: <em>All succeeded</em> (default), <em>At least one failed</em> (alerting or cleanup), <em>All done</em>.</li>
  <li><strong>Task values</strong> pass small results between tasks: <code>dbutils.jobs.taskValues.set("new_rows", n)</code>.</li>
</ul>

<h3>Structured Streaming or Lakeflow Pipelines?</h3>
<table class="ref">
  <tr><th>Choose Spark Declarative / Lakeflow Pipelines when</th><th>Choose Structured Streaming code when</th></tr>
  <tr><td>You want dependencies, checkpoints, retries, autoscaling and data-quality metrics managed for you</td><td>You need full control: custom <code>foreachBatch</code> logic, arbitrary stateful processing, unusual sinks</td></tr>
  <tr><td>CDC into SCD1/SCD2 tables (AUTO CDC)</td><td>You already run and monitor streaming apps and want to manage checkpoints yourself</td></tr>
  <tr><td>Many tables with simple, declarative logic</td><td>One complex stream with custom state or side effects</td></tr>
</table>

<div class="callout"><strong>Exam tip:</strong> "A serverless job fails to install an internal library" → upload the wheel to a volume and add it to the job's environment, or configure a private index. "Process each of 40 regions with the same notebook" → a For each task.</div>
`
  },
  {
    id: "pro-connect", domain: "pro-ingest", title: "Message Buses, Lakeflow Connect and Table Formats", minutes: 11,
    body: `
<h3>Message buses</h3>
<pre><code>raw = (spark.readStream.format("kafka")
    .option("kafka.bootstrap.servers", "broker1:9092")
    .option("subscribe", "orders")
    .option("startingOffsets", "earliest")
    .option("maxOffsetsPerTrigger", 500000)
    .load())

orders = raw.select(F.col("key").cast("string"),
                    F.parse_json(F.col("value").cast("string")).alias("payload"),
                    "topic", "partition", "offset", "timestamp")</code></pre>
<ul>
  <li>Kafka delivers <code>key</code> and <code>value</code> as <strong>binary</strong>. Cast them, then parse the payload with <code>from_json</code> (fixed schema) or <code>parse_json</code> (VARIANT).</li>
  <li>Offsets are stored in the checkpoint, so the stream resumes exactly where it stopped. <code>startingOffsets</code> only applies to the first run.</li>
  <li><code>maxOffsetsPerTrigger</code> limits each micro-batch.</li>
  <li><strong>Amazon Kinesis</strong> uses <code>format("kinesis")</code> with <code>streamName</code> and <code>initialPosition</code>. <strong>Google Pub/Sub</strong> uses <code>format("pubsub")</code> with a subscription. <strong>Azure Event Hubs</strong> is read through its Kafka-compatible endpoint.</li>
  <li>In SQL pipelines, <code>read_kafka()</code> does the same as a table-valued function: <code>CREATE STREAMING TABLE ... AS SELECT * FROM STREAM read_kafka(...)</code>.</li>
  <li>Store credentials in secrets or UC service credentials, never in code.</li>
</ul>

<h3>File formats</h3>
<table class="ref">
  <tr><th>Format</th><th>Notes</th></tr>
  <tr><td>JSON, CSV, XML</td><td>Schema inference (strings by default in Auto Loader), <code>_rescued_data</code>, options such as <code>header</code>, <code>multiLine</code></td></tr>
  <tr><td>Parquet, Avro, ORC</td><td>Typed, schema stored in the files</td></tr>
  <tr><td><code>binaryFile</code></td><td>Images, PDFs and other documents: one row per file with <code>path</code>, <code>modificationTime</code>, <code>length</code>, <code>content</code>. Use <code>pathGlobFilter</code> to pick extensions</td></tr>
  <tr><td>Delta</td><td>Read as a stream with <code>spark.readStream.table()</code>, or read its Change Data Feed</td></tr>
  <tr><td>Iceberg</td><td>Unity Catalog supports managed Iceberg tables, and Delta tables can expose Iceberg metadata (UniForm), so Iceberg engines can read and write the same governed data</td></tr>
</table>
<p>Lakeflow Pipelines can write incremental CDC results into Delta tables, or into Iceberg when other engines need to read the output natively.</p>

<h3>Lakeflow Connect: managed CDC from databases</h3>
<p>For operational databases such as <strong>SQL Server, MySQL and PostgreSQL</strong>, Lakeflow Connect replaces hand-written JDBC jobs:</p>
<ul>
  <li>An <strong>ingestion gateway</strong> runs close to the database and reads its change log: SQL Server change tracking or CDC, the MySQL binlog, PostgreSQL logical replication. It stages the changes.</li>
  <li>A serverless <strong>ingestion pipeline</strong> applies those changes (inserts, updates <em>and deletes</em>) to streaming tables in Unity Catalog, as SCD Type 1 or Type 2.</li>
  <li>Setup needs a Unity Catalog <strong>connection</strong> with credentials, plus change capture enabled on the source and a user with replication permissions.</li>
  <li>SaaS connectors (Salesforce, Workday, ServiceNow, ...) work the same way without a gateway.</li>
  <li>Configure in the UI, with bundles or with the API.</li>
</ul>
<table class="ref">
  <tr><th>Approach</th><th>Verdict for continuous DB replication</th></tr>
  <tr><td>Lakeflow Connect database connector</td><td>Best: captures deletes, incremental, minimal code</td></tr>
  <tr><td>Nightly JDBC full read and overwrite</td><td>Expensive, stale, loads the source</td></tr>
  <tr><td>Export to CSV, then Auto Loader</td><td>Loses deletes unless you build CDC yourself</td></tr>
  <tr><td>Lakehouse Federation</td><td>Live queries, but not replication: no history and every query hits the source</td></tr>
</table>

<div class="callout"><strong>Exam tip:</strong> "Continuously replicate inserts, updates and deletes from PostgreSQL with minimal code" → a Lakeflow Connect managed connector. "Ingest 10,000 scanned PDFs for AI processing" → Auto Loader with <code>binaryFile</code>.</div>
`
  },
  {
    id: "pro-transform", domain: "pro-manip", title: "Advanced Transformations, VARIANT and AI Functions", minutes: 13,
    body: `
<h3>Window functions beyond row_number</h3>
<pre><code>SELECT customer_id, order_date, amount,
       sum(amount) OVER (PARTITION BY customer_id ORDER BY order_date
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
       avg(amount) OVER (PARTITION BY customer_id ORDER BY order_date
                         ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)         AS moving_avg_3,
       amount - lag(amount) OVER (PARTITION BY customer_id ORDER BY order_date) AS change,
       dense_rank() OVER (PARTITION BY customer_id ORDER BY amount DESC)  AS amount_rank
FROM orders;</code></pre>
<ul>
  <li><code>ROWS</code> frames count rows. <code>RANGE</code> frames use values, so ties are included together.</li>
  <li><code>rank</code> leaves gaps after ties, <code>dense_rank</code> doesn't, and <code>row_number</code> is always unique.</li>
  <li>Filter on a window result with <code>QUALIFY</code> (SQL) or a follow-up <code>filter</code> (PySpark).</li>
</ul>

<h3>Joins and aggregations at scale</h3>
<ul>
  <li><strong>Semi and anti joins</strong> (<code>LEFT SEMI</code>, <code>LEFT ANTI</code>) answer "has a match" or "has no match" without duplicating rows.</li>
  <li><strong>Range joins</strong> (point-in-interval, for example events within an SCD2 validity window) can be slow. A range join hint (<code>/*+ RANGE_JOIN(d, 3600) */</code>) bins them.</li>
  <li><code>GROUPING SETS</code>, <code>ROLLUP</code> and <code>CUBE</code> compute several aggregation levels in one pass. <code>max_by(col, ordering)</code> returns the value at the max, and <code>count_if(cond)</code> counts matches.</li>
  <li>Higher-order functions work on arrays without exploding them: <code>transform</code>, <code>filter</code>, <code>exists</code>, <code>aggregate</code>. When you do need rows, <code>explode_outer</code> keeps rows with empty or NULL arrays.</li>
</ul>

<h3>VARIANT for semi-structured data</h3>
<pre><code>CREATE TABLE bronze.events_v AS
SELECT parse_json(raw) AS payload, ingest_ts FROM bronze.events_raw;

SELECT payload:customer.id::INT                      AS customer_id,
       variant_get(payload, '$.device.os', 'STRING') AS os,
       payload:items[0].sku::STRING                  AS first_sku
FROM bronze.events_v
WHERE payload:type::STRING = 'purchase';</code></pre>
<ul>
  <li><code>VARIANT</code> stores JSON-like data in an efficient binary encoding. It needs no fixed schema, and it reads fields much faster than parsing JSON strings again in every query.</li>
  <li><code>parse_json</code> fails on invalid JSON. <code>try_parse_json</code> returns NULL instead.</li>
  <li>Path access: <code>col:field.sub</code> or <code>col:items[0]</code>, cast with <code>::TYPE</code>. <code>variant_get(col, path, type)</code> does the same as a function, and <code>try_variant_get</code> returns NULL on a failed cast.</li>
  <li><code>schema_of_variant</code> describes the structure, and <code>variant_explode</code> turns objects or arrays into rows.</li>
  <li>Auto Loader and <code>read_files</code> can load JSON straight into a single VARIANT column (<code>singleVariantColumn</code>), which suits payloads whose shape keeps changing.</li>
</ul>
<table class="ref">
  <tr><th>Store as</th><th>When</th></tr>
  <tr><td>STRUCT with a fixed schema</td><td>Shape is stable and known; best for typed silver tables</td></tr>
  <tr><td>VARIANT</td><td>Shape varies or evolves often; bronze and flexible payloads</td></tr>
  <tr><td>STRING</td><td>Only for raw archiving. Querying needs parsing every time</td></tr>
</table>

<h3>AI functions in pipelines</h3>
<pre><code>SELECT ticket_id,
       ai_classify(body, ARRAY('billing', 'bug', 'feature request')) AS category,
       ai_query('databricks-meta-llama-3-3-70b-instruct',
                CONCAT('Summarize in one sentence: ', body),
                failOnError =&gt; false)                     AS summary
FROM silver.support_tickets;</code></pre>
<ul>
  <li><code>ai_query(endpoint, request)</code> calls a Model Serving endpoint (a foundation model or your own model) for each row. Use it for enrichment, extraction and classification inside SQL or pipelines.</li>
  <li>Use <code>responseFormat</code> (a JSON schema) for structured output, and <code>modelParameters</code> for settings such as temperature.</li>
  <li>With <code>failOnError =&gt; false</code>, a failing row returns an error message instead of failing the whole query.</li>
  <li>Task-specific functions need no prompt engineering: <code>ai_classify</code>, <code>ai_extract</code>, <code>ai_analyze_sentiment</code>, <code>ai_summarize</code>, <code>ai_translate</code>, <code>ai_mask</code>.</li>
  <li>Inference costs money and time per row. Run it incrementally, for example in a streaming table or on new rows only, rather than re-scoring the whole table every run.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "Raw JSON of varying shape, efficient storage and fast field extraction without a fixed schema" → <code>parse_json</code> into VARIANT, then <code>variant_get</code> or colon paths. "Classify support tickets inside the pipeline" → <code>ai_classify</code> or <code>ai_query</code>.</div>
`
  },
  {
    id: "pro-governance", domain: "pro-gov", title: "Tags, Comments and Permission Inheritance", minutes: 8,
    body: `
<h3>Permission inheritance</h3>
<p>Unity Catalog securables form a hierarchy: <strong>metastore → catalog → schema → table / view / volume / function / model</strong>. A privilege granted on a container applies to everything inside it, <em>including objects created later</em>.</p>
<pre><code>GRANT USE CATALOG, USE SCHEMA, SELECT ON CATALOG sales TO analysts;
-- analysts can now read every current and future table in every schema of 'sales'</code></pre>
<ul>
  <li>Privileges only add up. There is no DENY, so you can't grant on a catalog and then block one table inside it. To exclude something, grant at a lower level (specific schemas) or move the object.</li>
  <li><code>USE CATALOG</code> and <code>USE SCHEMA</code> are needed to reach objects. Without them, a table grant alone doesn't work.</li>
  <li>Ownership isn't inherited. Each object has one owner. Owners of the containing catalog or schema, and principals with <code>MANAGE</code>, can also manage grants on the objects inside.</li>
  <li>Grant to groups at the highest level that's still correct, for example SELECT on a schema of curated gold tables. That keeps the number of grants small and auditable.</li>
  <li><code>SHOW GRANTS ON SCHEMA sales.gold</code> and the <code>information_schema</code> privilege views show who has what.</li>
</ul>

<h3>Tags</h3>
<pre><code>ALTER TABLE sales.gold.orders SET TAGS ('domain' = 'sales', 'tier' = 'gold');
ALTER TABLE sales.silver.customers ALTER COLUMN email SET TAGS ('pii' = 'email');

SELECT * FROM system.information_schema.column_tags WHERE tag_name = 'pii';</code></pre>
<ul>
  <li>Tags are key/value metadata on catalogs, schemas, tables, columns, volumes and other securables.</li>
  <li><strong>Governed tags</strong> are defined at the account level with allowed values and control over who may assign them. They're what ABAC policies match on, so a correct tag automatically applies the right mask or filter.</li>
  <li>Tags make data searchable in Catalog Explorer (for example by owner team or sensitivity) and can be queried in <code>information_schema</code>.</li>
</ul>

<h3>Comments</h3>
<pre><code>COMMENT ON TABLE sales.gold.orders IS 'One row per order line. Refreshed hourly from silver.orders.';
ALTER TABLE sales.gold.orders ALTER COLUMN net_amount COMMENT 'Amount after discounts and refunds, in EUR';</code></pre>
<ul>
  <li>Comments describe purpose, grain, units and freshness. They appear in Catalog Explorer, search and lineage views, and help AI assistants and Genie answer questions correctly.</li>
  <li>Unity Catalog can suggest AI-generated comments for review.</li>
  <li>Keep tags and comments in code (for example in the pipeline or bundle), so they're versioned and don't drift.</li>
</ul>

<div class="callout"><strong>Exam tip:</strong> "SELECT was granted on the catalog; later a new schema and tables are created. Can analysts read them?" → Yes, privileges are inherited by current and future objects. "Make tables easier to find and understand" → tags and comments.</div>
`
  }
);

// Keep each module's lessons together and in teaching order (the lesson pager moves within a module).
(function () {
  const order = ["pro-jobs-dev", "pro-streaming", "pro-lakeflow", "pro-testing",
    "pro-autoloader", "pro-connect", "pro-delta-sharing", "pro-federation",
    "pro-transform", "pro-quality", "pro-observability",
    "pro-layout", "pro-cdf", "pro-spark-perf", "pro-cost",
    "pro-uc-security", "pro-compliance", "pro-governance",
    "pro-debugging", "pro-bundles", "pro-modeling", "pro-scd"];
  const pro = order.map((id) => TRAINER.lessons.find((l) => l.id === id));
  const rest = TRAINER.lessons.filter((l) => !order.includes(l.id));
  TRAINER.lessons.splice(0, TRAINER.lessons.length, ...rest, ...pro);
})();
