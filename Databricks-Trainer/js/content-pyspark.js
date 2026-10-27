// PySpark track: modules, lessons, quiz questions and exercises.
// Code blocks marked <pre data-try> get a "Try it" button that opens them in the PySpark sandbox.

window.TRAINER = window.TRAINER || {};

TRAINER.domains.push(
  { id: "py-basics", track: "pyspark", title: "DataFrame Fundamentals", short: "Fundamentals",
    summary: "SparkSession, lazy evaluation, columns and conditions, null handling, aggregations and joins." },
  { id: "py-advanced", track: "pyspark", title: "Window & Advanced Functions", short: "Advanced",
    summary: "Ranking, running totals and lag/lead, arrays and explode, structs, higher-order functions, dates." },
  { id: "py-io", track: "pyspark", title: "Reading, Writing & Delta", short: "I/O & Delta",
    summary: "DataFrameReader and schemas, save modes and partitioning, the DeltaTable API and time travel." },
  { id: "py-perf", track: "pyspark", title: "Performance & Internals", short: "Performance",
    summary: "How Spark plans and runs a query: shuffles, partitions, AQE, broadcast joins, caching and UDF cost." }
);

TRAINER.lessons.push(
  // ---------------------------------------------------------------- fundamentals
  {
    id: "pyspark-intro", domain: "py-basics", title: "SparkSession, DataFrames and Lazy Evaluation", minutes: 9,
    body: `
<p>In a Databricks notebook a <code>SparkSession</code> called <code>spark</code> already exists. It's your entry point for creating DataFrames.</p>
<pre data-try><code>orders = spark.table("orders")       # a table in the catalog (main.sales.orders on Databricks)
orders.printSchema()
orders.show(5)
print(orders.columns, orders.count())</code></pre>

<h3>Creating DataFrames</h3>
<pre data-try><code>from pyspark.sql import Row

df1 = spark.createDataFrame([(1, "a"), (2, "b")], ["id", "letter"])      # column names
df2 = spark.createDataFrame([(1, "a")], "id INT, letter STRING")          # DDL schema
df3 = spark.createDataFrame([Row(id=1, letter="a"), Row(id=2, letter="b")])
df4 = spark.sql("SELECT status, count(*) AS n FROM orders GROUP BY status")
df4.show()</code></pre>

<h3>Transformations are lazy, actions run</h3>
<p>A DataFrame is a <em>plan</em>, not data. <strong>Transformations</strong> (<code>select</code>, <code>filter</code>, <code>withColumn</code>, <code>join</code>, <code>groupBy</code>, <code>orderBy</code>) return a new DataFrame immediately without reading anything. <strong>Actions</strong> (<code>show</code>, <code>collect</code>, <code>count</code>, <code>take</code>, <code>first</code>, <code>write</code>, <code>display</code>) run the plan.</p>
<pre data-try><code>from pyspark.sql import functions as F

completed = orders.filter(F.col("status") == "COMPLETED")   # nothing runs yet
march = completed.filter(F.month("order_date") == 3)          # still nothing
print(march.count())                                          # now Spark runs the whole plan</code></pre>
<p>Being lazy lets Spark's <strong>Catalyst optimizer</strong> see the whole plan before it runs. It can then push filters down to the data source, drop unused columns and reorder joins.</p>

<h3>DataFrames are immutable</h3>
<p>Every transformation returns a <em>new</em> DataFrame. <code>orders.filter(...)</code> on its own line does nothing useful; assign the result.</p>

<h3>Referring to columns</h3>
<table class="ref">
  <tr><th>Style</th><th>Example</th><th>Notes</th></tr>
  <tr><td>String</td><td><code>df.select("status")</code></td><td>Simplest. Accepted by most functions.</td></tr>
  <tr><td><code>F.col</code></td><td><code>F.col("status") == "PENDING"</code></td><td>Doesn't need a DataFrame variable. The usual choice.</td></tr>
  <tr><td>Attribute / key</td><td><code>df.status</code>, <code>df["status"]</code></td><td>Tied to that DataFrame. Useful to disambiguate after a join.</td></tr>
</table>

<h3>show() vs display() vs collect()</h3>
<ul>
  <li><code>df.show(n=20, truncate=True)</code> prints a text table. Strings longer than 20 characters are cut unless <code>truncate=False</code>.</li>
  <li><code>display(df)</code> is Databricks' rich table (with charts and download) in notebooks.</li>
  <li><code>df.collect()</code> returns <em>every</em> row to the driver as a list of <code>Row</code> objects. On big data this can crash the driver, so prefer <code>take(n)</code> or <code>limit(n)</code>.</li>
</ul>
`
  },
  {
    id: "pyspark-columns", domain: "py-basics", title: "Columns, Filters and Conditional Logic", minutes: 10,
    body: `
<h3>select, withColumn, drop, rename</h3>
<pre data-try><code>from pyspark.sql import functions as F

products = spark.table("products")
(products
  .withColumn("price_eur", F.round(F.col("price") * 0.92, 2))   # add a column (or replace one with the same name)
  .withColumnRenamed("product_name", "name")
  .drop("product_id")
  .select("name", "category", "price_eur")
  .show())</code></pre>

<h3>Filtering and boolean logic</h3>
<p>Combine conditions with <code>&amp;</code> (and), <code>|</code> (or) and <code>~</code> (not), and <strong>wrap each condition in parentheses</strong>. Python's <code>and</code>/<code>or</code> keywords don't work on Columns, and <code>&amp;</code> binds more tightly than <code>==</code>.</p>
<pre data-try><code>orders = spark.table("orders")
orders.filter((F.col("status") == "COMPLETED") &amp; (F.col("order_date") >= "2024-04-01")).show()
orders.where(F.col("status").isin("PENDING", "CANCELLED")).show()
orders.filter("status = 'PENDING'").show()          # a SQL string works too</code></pre>
<p>Useful predicates include <code>isin</code>, <code>between</code>, <code>like</code>, <code>rlike</code> (regex), <code>startswith</code>, <code>contains</code>, <code>isNull</code> and <code>isNotNull</code>.</p>

<h3>when / otherwise</h3>
<pre data-try><code>products.withColumn("band",
    F.when(F.col("price") >= 100, "premium")
     .when(F.col("price") >= 40, "standard")
     .otherwise("budget")
).select("product_name", "price", "band").show()</code></pre>
<p>Conditions are checked in order and the first match wins. Without <code>otherwise</code>, rows that match nothing get NULL.</p>

<h3>NULLs</h3>
<ul>
  <li><code>F.col("x") == None</code> never matches anything. Use <code>isNull()</code> or <code>isNotNull()</code>.</li>
  <li><code>df.fillna("UNKNOWN", subset=["country"])</code> or <code>df.fillna({"country": "UNKNOWN", "qty": 0})</code>. A scalar only fills columns of a matching type, so <code>fillna(0)</code> leaves string columns alone.</li>
  <li><code>df.dropna(subset=["email"])</code> drops rows with NULL in those columns. <code>how="all"</code> only drops rows where all of them are NULL.</li>
  <li><code>F.coalesce(a, b, ...)</code> returns the first value that isn't NULL.</li>
  <li><code>eqNullSafe</code> (SQL <code>&lt;=&gt;</code>) treats NULL = NULL as true.</li>
</ul>
<pre data-try><code>customers = spark.table("customers")
customers.select("name",
    F.coalesce("email", F.lit("no email")).alias("contact"),
    F.col("country").isNull().alias("missing_country")).show()</code></pre>

<h3>Strings and casting</h3>
<pre data-try><code>customers.select(
    F.upper("name").alias("upper"),
    F.split("name", " ").getItem(0).alias("first"),
    F.regexp_extract("email", r"@(.*)$", 1).alias("domain"),
    F.concat_ws(" / ", "name", "country").alias("label"),
    F.col("customer_id").cast("string").alias("id_str")
).show(truncate=False)</code></pre>
<div class="callout"><strong>Tip:</strong> <code>F.lit(value)</code> turns a Python value into a Column. Most functions accept column names as strings, so in <code>F.concat("a", "b")</code> both arguments are columns, not text. Use <code>F.lit("b")</code> for literal text.</div>
`
  },
  {
    id: "pyspark-aggregations", domain: "py-basics", title: "Aggregations and Pivots", minutes: 8,
    body: `
<pre data-try><code>from pyspark.sql import functions as F

orders = spark.table("orders")
(orders.groupBy("status")
   .agg(F.count("*").alias("orders"),
        F.countDistinct("customer_id").alias("customers"),
        F.min("order_date").alias("first_order"))
   .orderBy(F.col("orders").desc())
   .show())</code></pre>
<ul>
  <li><code>groupBy(...)</code> returns <code>GroupedData</code>, which isn't a DataFrame until you call <code>agg</code>, <code>count</code>, <code>sum</code>, ...</li>
  <li>Unaliased aggregates get names like <code>sum(price)</code>. Use <code>.alias()</code> so later code can reference them.</li>
  <li><code>groupBy("x").count()</code> creates a column called <code>count</code>.</li>
  <li><code>df.agg(F.max("price"))</code> aggregates the whole DataFrame without grouping.</li>
  <li><code>F.count("col")</code> skips NULLs. <code>F.count("*")</code> doesn't.</li>
</ul>

<h3>Collecting values</h3>
<pre data-try><code>orders.groupBy("customer_id").agg(
    F.collect_list("order_id").alias("all_orders"),     # keeps duplicates
    F.collect_set("status").alias("statuses")           # distinct values, no guaranteed order
).show(truncate=False)</code></pre>

<h3>Pivot</h3>
<pre data-try><code>items, products = spark.table("order_items"), spark.table("products")
(items.join(orders, "order_id").join(products, "product_id")
   .withColumn("month", F.date_format("order_date", "yyyy-MM"))
   .groupBy("month")
   .pivot("category", ["Books", "Courses", "Merch"])     # listing values avoids an extra pass to find them
   .agg(F.sum(F.col("quantity") * F.col("price")))
   .orderBy("month")
   .show())</code></pre>
<p>Cells with no matching rows are NULL. Follow with <code>.fillna(0)</code> if you need zeros.</p>
`
  },
  {
    id: "pyspark-joins", domain: "py-basics", title: "Joins", minutes: 9,
    body: `
<pre data-try><code>from pyspark.sql import functions as F

orders, customers = spark.table("orders"), spark.table("customers")
orders.join(customers, "customer_id").select("order_id", "name").show(3)                 # inner by default
customers.join(orders, "customer_id", "left").select("name", "order_id").show(3)
customers.join(orders, "customer_id", "left_anti").select("customer_id", "name").show()  # never ordered</code></pre>

<h3>Join types</h3>
<table class="ref">
  <tr><th><code>how=</code></th><th>Returns</th></tr>
  <tr><td><code>inner</code> (default)</td><td>Rows with a match on both sides</td></tr>
  <tr><td><code>left</code> / <code>left_outer</code></td><td>All left rows. Right columns are NULL where nothing matched.</td></tr>
  <tr><td><code>right</code>, <code>full</code> / <code>outer</code></td><td>All right rows, or all rows from both sides</td></tr>
  <tr><td><code>left_semi</code></td><td>Left rows that <em>have</em> a match. Only left columns, no duplication.</td></tr>
  <tr><td><code>left_anti</code></td><td>Left rows with <em>no</em> match. Only left columns.</td></tr>
  <tr><td><code>cross</code></td><td>Every combination (<code>crossJoin</code>)</td></tr>
</table>

<h3>Join keys and duplicate columns</h3>
<ul>
  <li><code>on="customer_id"</code> or <code>on=["a", "b"]</code>: the key appears <strong>once</strong> in the result.</li>
  <li><code>on=orders.customer_id == customers.customer_id</code>: <strong>both</strong> key columns are kept. A later <code>select("customer_id")</code> is ambiguous, so reference <code>orders.customer_id</code>, or drop one side.</li>
  <li>Several conditions: <code>on=[a.x == b.x, a.y == b.y]</code> or <code>(a.x == b.x) &amp; (a.y &gt; b.y)</code>.</li>
</ul>
<pre data-try><code>o, c = orders.alias("o"), customers.alias("c")
(o.join(c, F.col("o.customer_id") == F.col("c.customer_id"))
   .select("o.order_id", "c.name", "c.country")
   .show(3))</code></pre>

<div class="callout"><strong>Watch for duplicates:</strong> if the right side has several rows per key, every left row is repeated once per match. Joining orders to order_items repeats each order once per line item, so count orders with <code>countDistinct("order_id")</code>, not <code>count("*")</code>.</div>

<h3>Unions</h3>
<p><code>union</code> matches columns by <em>position</em>. <code>unionByName</code> matches them by <em>name</em> (add <code>allowMissingColumns=True</code> to fill gaps with NULL). Both keep duplicates. Follow with <code>.distinct()</code> for SQL <code>UNION</code> behaviour.</p>
`
  },

  // ---------------------------------------------------------------- advanced
  {
    id: "pyspark-windows", domain: "py-advanced", title: "Window Functions", minutes: 11,
    body: `
<p>Window functions compute a value for each row from a group of related rows (its <em>window</em>), without collapsing rows the way <code>groupBy</code> does.</p>
<pre data-try><code>from pyspark.sql import functions as F
from pyspark.sql.window import Window

products = spark.table("products")
w = Window.partitionBy("category").orderBy(F.col("price").desc())
products.select("category", "product_name", "price",
    F.row_number().over(w).alias("row_number"),
    F.rank().over(w).alias("rank"),
    F.dense_rank().over(w).alias("dense_rank"),
    F.sum("price").over(Window.partitionBy("category")).alias("category_total")
).show()</code></pre>

<h3>Ranking with ties</h3>
<table class="ref">
  <tr><th>Values</th><th>row_number</th><th>rank</th><th>dense_rank</th></tr>
  <tr><td>100, 100, 90</td><td>1, 2, 3</td><td>1, 1, 3</td><td>1, 1, 2</td></tr>
</table>
<p>Use <code>row_number</code> to keep exactly one row per key (dedup). Use <code>rank</code> or <code>dense_rank</code> for top-N lists where ties should all be kept.</p>

<h3>Dedup: keep the latest record per key</h3>
<pre data-try><code>events = spark.table("bronze_events")
latest = Window.partitionBy("event_id").orderBy(F.col("ingest_ts").desc())
(events.withColumn("rn", F.row_number().over(latest))
       .filter("rn = 1").drop("rn")
       .show())</code></pre>

<h3>lag and lead</h3>
<pre data-try><code>orders = spark.table("orders")
by_customer = Window.partitionBy("customer_id").orderBy("order_date")
(orders.withColumn("prev_order", F.lag("order_date", 1).over(by_customer))
       .withColumn("days_between", F.datediff("order_date", "prev_order"))
       .orderBy("customer_id", "order_date")
       .show())</code></pre>
<p>The first row in each partition has no previous row, so <code>lag</code> returns NULL there. Pass a default, as in <code>F.lag("x", 1, 0)</code>, to change that.</p>

<h3>Frames: running totals and moving averages</h3>
<pre data-try><code>running = (Window.partitionBy("customer_id").orderBy("order_date")
           .rowsBetween(Window.unboundedPreceding, Window.currentRow))
last3 = Window.partitionBy("customer_id").orderBy("order_date").rowsBetween(-2, 0)
orders.select("customer_id", "order_date",
    F.count("*").over(running).alias("orders_so_far"),
    F.count("*").over(last3).alias("in_last_3")).show()</code></pre>
<ul>
  <li>With <code>orderBy</code> and no explicit frame, the frame is <em>everything up to the current row</em> (a running total). Rows with the same order value count as peers and are included together.</li>
  <li>With no <code>orderBy</code>, the frame is the whole partition.</li>
  <li><code>rowsBetween</code> counts physical rows. <code>rangeBetween</code> works on the order value (for example, "the last 7 days").</li>
</ul>
`
  },
  {
    id: "pyspark-nested", domain: "py-advanced", title: "Arrays, Structs, Higher-Order Functions and Dates", minutes: 11,
    body: `
<h3>Arrays and explode</h3>
<pre data-try><code>from pyspark.sql import functions as F

carts = spark.table("carts")          # items is an array of product ids
carts.show()
carts.select("cart_id", F.explode("items").alias("product_id")).show()
carts.select("cart_id", F.explode_outer("items").alias("product_id")).show()</code></pre>
<ul>
  <li><code>explode</code> makes one row per element. Rows whose array is NULL or empty <strong>disappear</strong>.</li>
  <li><code>explode_outer</code> keeps those rows, with a NULL element.</li>
  <li>Building arrays: <code>F.array(...)</code>, <code>F.split(str, regex)</code>, <code>F.collect_list</code> and <code>F.collect_set</code>.</li>
  <li>Inspecting arrays: <code>F.size</code>, <code>F.array_contains</code>, <code>F.element_at(arr, 1)</code> (1-based), <code>col.getItem(0)</code> (0-based), <code>F.array_distinct</code>, <code>F.array_sort</code>, <code>F.array_join</code>.</li>
</ul>

<h3>Higher-order functions</h3>
<p>These work on each array element without exploding. Pass a Python lambda that builds a Column expression:</p>
<pre data-try><code>carts.select("cart_id",
    F.transform("items", lambda x: x * 10).alias("times_ten"),
    F.filter("items", lambda x: x > 103).alias("over_103"),
    F.exists("items", lambda x: x == 107).alias("has_stickers"),
    F.aggregate("items", F.lit(0), lambda acc, x: acc + 1).alias("n_items")
).show(truncate=False)</code></pre>

<h3>Structs</h3>
<pre data-try><code>from pyspark.sql import Row
people = spark.createDataFrame([
    Row(id=1, address=Row(city="Oslo", zip="0150")),
    Row(id=2, address=Row(city="Rome", zip="00184"))])
people.printSchema()
people.select("id", "address.city", F.col("address").getField("zip").alias("zip")).show()
people.select(F.struct("id", "address.city").alias("packed")).show()</code></pre>

<h3>JSON strings (on Databricks)</h3>
<p>To parse a JSON string column, use <code>F.from_json(col, schema)</code> with a DDL string or <code>StructType</code>. Then select fields with dot syntax. <code>F.to_json</code> goes the other way, and <code>F.get_json_object(col, "$.a.b")</code> extracts a single path. (These aren't available in this browser trainer.)</p>

<h3>Dates and timestamps</h3>
<pre data-try><code>orders = spark.table("orders")
orders.select("order_date",
    F.year("order_date").alias("y"), F.month("order_date").alias("m"),
    F.dayofweek("order_date").alias("dow"),               # 1 = Sunday ... 7 = Saturday
    F.date_format("order_date", "yyyy-MM").alias("ym"),
    F.date_add("order_date", 30).alias("due"),
    F.datediff(F.lit("2024-12-31"), "order_date").alias("days_left"),
    F.trunc("order_date", "month").alias("month_start"),
    F.to_date(F.lit("15/03/2024"), "dd/MM/yyyy").alias("parsed")
).show(3)</code></pre>
<p>Spark uses Java datetime patterns: <code>yyyy</code> is the year, <code>MM</code> the month, <code>dd</code> the day, <code>HH</code> the hour (24-hour), <code>mm</code> minutes and <code>ss</code> seconds. Writing <code>mm</code> when you mean the month is a classic bug.</p>
`
  },

  // ---------------------------------------------------------------- io
  {
    id: "pyspark-io", domain: "py-io", title: "Readers, Schemas and Writers", minutes: 10,
    body: `
<h3>Reading files</h3>
<pre><code>df = (spark.read
        .format("csv")                      # csv, json, parquet, delta, text, binaryFile, ...
        .option("header", "true")
        .option("delimiter", ";")
        .schema("customer_id INT, name STRING, country STRING")
        .load("/Volumes/main/raw/landing/customers/"))

orders = spark.read.json("/Volumes/main/raw/landing/orders/")      # shortcut methods
tbl = spark.read.table("main.sales.orders")                         # same as spark.table(...)</code></pre>
<ul>
  <li>Without <code>.schema(...)</code>, CSV and JSON readers <strong>infer</strong> the schema. That needs an extra pass over the data and can guess wrong types (IDs read as strings, zip codes losing leading zeros).</li>
  <li>For CSV, <code>inferSchema</code> is off by default, so every column becomes a string unless you set <code>.option("inferSchema", "true")</code> or give a schema.</li>
  <li>Parquet and Delta store their schema, so nothing is inferred.</li>
  <li>Malformed records: the <code>mode</code> option is <code>PERMISSIVE</code> (the default, which sets bad fields to NULL), <code>DROPMALFORMED</code> or <code>FAILFAST</code>.</li>
</ul>

<h3>Schemas in code</h3>
<pre data-try><code>from pyspark.sql.types import StructType, StructField, IntegerType, StringType, ArrayType

schema = StructType([
    StructField("id", IntegerType(), nullable=False),
    StructField("name", StringType()),
    StructField("tags", ArrayType(StringType())),
])
df = spark.createDataFrame([(1, "a", ["x"])], schema)
df.printSchema()
print(df.schema.simpleString(), df.dtypes)</code></pre>
<p>A DDL string such as <code>"id INT, name STRING, tags ARRAY&lt;STRING&gt;"</code> is equivalent and shorter.</p>

<h3>Writing</h3>
<pre><code>(df.write
   .format("delta")                 # the default on Databricks
   .mode("overwrite")               # append | overwrite | errorifexists (default) | ignore
   .partitionBy("country")
   .saveAsTable("main.bronze.customers"))

df.write.mode("append").saveAsTable("main.bronze.customers")
df.write.format("parquet").save("/Volumes/main/exports/customers/")   # path-based, not in the catalog</code></pre>
<table class="ref">
  <tr><th>Mode</th><th>If the table exists</th></tr>
  <tr><td><code>errorifexists</code> / <code>error</code> (default)</td><td>Fails</td></tr>
  <tr><td><code>append</code></td><td>Adds rows</td></tr>
  <tr><td><code>overwrite</code></td><td>Replaces the data. On Delta this is a new version, so time travel still works.</td></tr>
  <tr><td><code>ignore</code></td><td>Does nothing</td></tr>
</table>
<ul>
  <li><code>partitionBy</code> writes a folder per value. Only use it on <strong>low-cardinality</strong> columns that queries filter on, and for large tables. For new Delta tables, liquid clustering (<code>clusterBy</code>) is usually the better choice.</li>
  <li><code>.option("mergeSchema", "true")</code> lets an append add new columns. <code>.option("overwriteSchema", "true")</code> lets an overwrite change the schema.</li>
</ul>
`
  },
  {
    id: "pyspark-delta", domain: "py-io", title: "The Delta Lake Python API", minutes: 9,
    body: `
<p><code>DeltaTable</code> exposes Delta operations from Python. Everything here also has a SQL equivalent (<code>MERGE</code>, <code>DESCRIBE HISTORY</code>, <code>RESTORE</code>, ...).</p>
<pre><code>from delta.tables import DeltaTable

target = DeltaTable.forName(spark, "main.silver.customers")   # or DeltaTable.forPath(spark, path)
updates = spark.table("main.bronze.customer_updates")

(target.alias("t")
   .merge(updates.alias("s"), "t.customer_id = s.customer_id")
   .whenMatchedDelete(condition="s.is_deleted = true")
   .whenMatchedUpdateAll()
   .whenNotMatchedInsertAll()
   .execute())                       # nothing happens until execute()</code></pre>
<ul>
  <li><code>whenMatchedUpdate(set={"email": "s.email"})</code> and <code>whenNotMatchedInsert(values={...})</code> update or insert selected columns only.</li>
  <li><code>whenNotMatchedBySourceDelete()</code> deletes target rows that are missing from the source (a full sync).</li>
  <li>The source must have at most one row per key. Dedupe it first (with a window function), or the merge fails.</li>
</ul>

<h3>Other operations</h3>
<pre><code>target.update(condition="country = 'UK'", set={"country": "'GB'"})
target.delete("signup_date &lt; '2020-01-01'")
target.history().select("version", "timestamp", "operation").show()
target.optimize().executeZOrderBy("customer_id")
target.vacuum(168)                   # hours; the default retention is 7 days
target.toDF()                        # read as a DataFrame</code></pre>

<h3>Time travel</h3>
<pre><code>v3   = spark.read.option("versionAsOf", 3).table("main.silver.customers")
jun1 = spark.read.option("timestampAsOf", "2024-06-01").table("main.silver.customers")
target.restoreToVersion(3)           # or restoreToTimestamp("2024-06-01")</code></pre>

<h3>Change data feed</h3>
<pre><code>spark.sql("ALTER TABLE main.silver.customers SET TBLPROPERTIES (delta.enableChangeDataFeed = true)")
changes = (spark.read.option("readChangeFeed", "true")
             .option("startingVersion", 5)
             .table("main.silver.customers"))   # adds _change_type, _commit_version, _commit_timestamp</code></pre>
<div class="callout"><strong>In this trainer:</strong> DeltaTable needs a real cluster, so these snippets don't run in the sandbox. The Delta exercises check your syntax instead.</div>
`
  },

  // ---------------------------------------------------------------- performance
  {
    id: "pyspark-execution", domain: "py-perf", title: "How Spark Runs Your Code", minutes: 10,
    body: `
<h3>From DataFrame to tasks</h3>
<ol>
  <li>Your transformations build a <strong>logical plan</strong>.</li>
  <li><strong>Catalyst</strong> optimizes it: predicate pushdown, column pruning, constant folding and join reordering.</li>
  <li>The planner picks a <strong>physical plan</strong>: join strategies, aggregation methods, and Photon operators where available.</li>
  <li>An action submits a <strong>job</strong>. The job is split into <strong>stages</strong> at shuffle boundaries, and each stage runs one <strong>task per partition</strong> on the executors.</li>
</ol>
<pre data-try><code>from pyspark.sql import functions as F
q = (spark.table("orders").filter(F.col("status") == "COMPLETED")
       .groupBy("customer_id").count())
q.explain()     # on Databricks: q.explain("formatted") shows the Spark physical plan</code></pre>

<h3>Narrow vs. wide transformations</h3>
<table class="ref">
  <tr><th>Narrow (no shuffle)</th><th>Wide (shuffle)</th></tr>
  <tr><td><code>select</code>, <code>filter</code>, <code>withColumn</code>, <code>union</code>, <code>coalesce</code></td><td><code>groupBy</code>, <code>join</code> (unless broadcast), <code>distinct</code>, <code>orderBy</code>, <code>repartition</code>, window functions with <code>partitionBy</code></td></tr>
</table>
<p>A <strong>shuffle</strong> redistributes rows across the cluster by key: data is written to disk, sent over the network, then read back. It's usually the most expensive part of a job.</p>

<h3>Partitions</h3>
<ul>
  <li>Each partition is processed by one task. Too few partitions leave cores idle. Too many add scheduling overhead.</li>
  <li><code>spark.sql.shuffle.partitions</code> (default <strong>200</strong>) sets how many partitions a shuffle produces.</li>
  <li><code>repartition(n)</code> or <code>repartition("col")</code> does a full shuffle and can increase partitions. <code>coalesce(n)</code> only merges partitions, with no shuffle, so it's cheaper but can only reduce the count.</li>
</ul>

<h3>Adaptive Query Execution (AQE)</h3>
<p>AQE is on by default. It re-plans at runtime using real statistics from completed stages:</p>
<ul>
  <li><strong>Coalesces</strong> small shuffle partitions, so 200 tiny partitions become a few right-sized ones.</li>
  <li><strong>Switches join strategy</strong>, for example to a broadcast join when one side turns out to be small.</li>
  <li><strong>Handles skew</strong> by splitting oversized partitions in sort-merge joins.</li>
</ul>

<h3>Reading the Spark UI</h3>
<ul>
  <li><strong>Skew</strong>: a handful of tasks in a stage take much longer than the median.</li>
  <li><strong>Spill</strong>: memory spilled to disk during shuffles or sorts. Use more or larger partitions, or bigger executors.</li>
  <li>Check how much each stage reads: a full scan where you expected a filter means pushdown or data skipping didn't apply.</li>
</ul>
`
  },
  {
    id: "pyspark-tuning", domain: "py-perf", title: "Joins, Caching and UDF Performance", minutes: 10,
    body: `
<h3>Join strategies</h3>
<table class="ref">
  <tr><th>Strategy</th><th>When</th><th>Cost</th></tr>
  <tr><td><strong>Broadcast hash join</strong></td><td>One side is small (under <code>spark.sql.autoBroadcastJoinThreshold</code>, 10 MB by default; Databricks can raise it adaptively)</td><td>No shuffle of the big side. The small side is copied to every executor.</td></tr>
  <tr><td><strong>Sort-merge join</strong></td><td>Both sides are large</td><td>Both sides are shuffled and sorted by key</td></tr>
  <tr><td>Shuffle hash join</td><td>One side is medium-sized</td><td>Shuffle without the sort</td></tr>
</table>
<pre data-try><code>from pyspark.sql import functions as F
orders, customers = spark.table("orders"), spark.table("customers")
orders.join(F.broadcast(customers), "customer_id").groupBy("country").count().show()</code></pre>
<p><code>F.broadcast(df)</code> is a <em>hint</em> that the DataFrame is small enough to copy to every node. Use it for dimension tables. Broadcasting something big can run executors out of memory.</p>

<h3>Caching</h3>
<ul>
  <li><code>df.cache()</code> (the same as <code>persist(StorageLevel.MEMORY_AND_DISK)</code> for DataFrames) is <strong>lazy</strong>: the data is stored the first time an action computes it.</li>
  <li>Cache only when a DataFrame is reused several times and is expensive to recompute. Call <code>unpersist()</code> when you're done.</li>
  <li>On Databricks, the <strong>disk cache</strong> already speeds up repeated reads of Parquet/Delta files automatically, and serverless compute doesn't support <code>cache()</code> on DataFrames. Explicit caching is needed far less often than people think.</li>
</ul>

<h3>Python UDFs and the alternatives</h3>
<table class="ref">
  <tr><th>Approach</th><th>Speed</th><th>Why</th></tr>
  <tr><td>Built-in functions (<code>F.*</code>, SQL)</td><td>Fastest</td><td>Run in the JVM or Photon, and Catalyst can optimize them</td></tr>
  <tr><td><code>pandas_udf</code></td><td>Good</td><td>Vectorized: data moves in Arrow batches, processed with pandas</td></tr>
  <tr><td>Row-at-a-time <code>udf</code></td><td>Slowest</td><td>Every row is serialized to a Python worker and back. Opaque to the optimizer.</td></tr>
</table>
<pre><code>from pyspark.sql.functions import pandas_udf
import pandas as pd

@pandas_udf("double")
def to_eur(usd: pd.Series) -> pd.Series:
    return usd * 0.92

df.withColumn("eur", to_eur("price"))
# ...but here F.col("price") * 0.92 does the same job with no UDF at all.</code></pre>

<h3>Other common wins</h3>
<ul>
  <li><strong>Filter early, select only the columns you need.</strong> Catalyst pushes most of this down, but not through UDFs.</li>
  <li><strong>Avoid <code>collect()</code></strong> on large data. Write results to a table instead.</li>
  <li><strong>Small files</strong>: run <code>OPTIMIZE</code>, or let predictive optimization / auto compaction do it.</li>
  <li><strong>Skew</strong>: AQE skew handling, salting hot keys, or broadcasting the small side.</li>
  <li><strong>Data layout</strong>: liquid clustering or Z-order on common filter columns lets Delta skip files.</li>
</ul>
`
  }
);

TRAINER.questions.push(
  // ---------------------------------------------------------------- fundamentals
  { id: "pb1", domain: "py-basics",
    q: "Which of these PySpark calls is an action that triggers execution?",
    options: ["df.withColumn('x', F.lit(1))", "df.filter(F.col('a') > 1)", "df.count()", "df.select('a')"],
    answer: 2,
    explain: "count() returns a number to the driver, so Spark has to run the plan. The others are lazy transformations that return a new DataFrame." },
  { id: "pb2", domain: "py-basics",
    q: "`df.filter(F.col('a') > 1 and F.col('b') < 5)` raises an error. What's the fix?",
    options: ["Use `df.where` instead of `df.filter`", "Use `(F.col('a') > 1) & (F.col('b') < 5)`", "Use `F.col('a') > 1 & F.col('b') < 5` without parentheses", "Cast both columns to boolean"],
    answer: 1,
    explain: "Python's `and` tries to turn a Column into a bool. Use `&`, `|` and `~`, with each condition in parentheses because `&` binds more tightly than comparison operators." },
  { id: "pb3", domain: "py-basics",
    q: "What does `F.when(F.col('price') > 100, 'high')` return for rows where price is 50, if there's no `.otherwise()`?",
    options: ["'low'", "An error", "NULL", "The original price"],
    answer: 2,
    explain: "Without otherwise(), rows that match no condition get NULL." },
  { id: "pb4", domain: "py-basics",
    q: "How do `a.join(b, 'id')` and `a.join(b, a.id == b.id)` differ?",
    options: ["They are identical", "The string form keeps a single `id` column. The expression form keeps both, so a bare `id` becomes ambiguous.", "The string form does a left join", "The expression form only works with broadcast joins"],
    answer: 1,
    explain: "Joining on column names (USING semantics) merges the key into one column. Joining on an expression keeps a.id and b.id." },
  { id: "pb5", domain: "py-basics",
    q: "Which join returns customers who have never placed an order, with only the customers' columns?",
    options: ["customers.join(orders, 'customer_id', 'left')", "customers.join(orders, 'customer_id', 'left_semi')", "customers.join(orders, 'customer_id', 'left_anti')", "customers.join(orders, 'customer_id', 'outer')"],
    answer: 2,
    explain: "left_anti keeps left rows without a match. left_semi keeps left rows that do have a match." },
  { id: "pb6", domain: "py-basics",
    q: "`df.fillna(0)` is run on a DataFrame with an integer column `qty` and a string column `country`, both with NULLs. What happens?",
    options: ["Both columns get 0", "Only `qty` NULLs become 0. `country` is unchanged.", "It fails because of the string column", "`country` NULLs become '0'"],
    answer: 1,
    explain: "A scalar fill value only applies to columns of a compatible type. Use a dict, as in fillna({'country': 'UNKNOWN'}), for per-column values." },
  { id: "pb7", domain: "py-basics",
    q: "What is the name of the column created by `df.groupBy('status').count()`?",
    options: ["count(1)", "n", "count", "status_count"],
    answer: 2,
    explain: "GroupedData.count() produces a column named `count`. F.count('*') inside agg() would be named `count(1)` unless you alias it." },

  // ---------------------------------------------------------------- advanced
  { id: "pa1", domain: "py-advanced",
    q: "Three products in one category cost 100, 100 and 90. What does `F.dense_rank()` ordered by price descending return?",
    options: ["1, 2, 3", "1, 1, 3", "1, 1, 2", "2, 2, 1"],
    answer: 2,
    explain: "dense_rank gives ties the same rank with no gaps. rank would give 1, 1, 3 and row_number 1, 2, 3." },
  { id: "pa2", domain: "py-advanced",
    q: "What does `F.sum('amount').over(Window.partitionBy('customer_id').orderBy('order_date'))` compute?",
    options: ["The customer's total over all orders, on every row", "A running total up to and including the current order date", "The amount of the previous order", "An error, because a frame is required"],
    answer: 1,
    explain: "With an orderBy and no explicit frame, the frame runs from the start of the partition to the current row (including peers with the same date). Without orderBy it would be the whole partition." },
  { id: "pa3", domain: "py-advanced",
    q: "A row's `items` array is empty. What happens to that row with `F.explode('items')`?",
    options: ["It stays, with a NULL item", "It's removed from the result", "It raises an error", "It becomes one row with an empty string"],
    answer: 1,
    explain: "explode drops rows whose array is empty or NULL. explode_outer keeps them with a NULL element." },
  { id: "pa4", domain: "py-advanced",
    q: "What does `F.lag('order_date', 1)` return for the first row in each window partition?",
    options: ["The same order_date", "NULL (unless a default is given)", "The last row of the previous partition", "0"],
    answer: 1,
    explain: "There's no previous row, so lag returns NULL, or the third argument if you pass a default." },
  { id: "pa5", domain: "py-advanced",
    q: "How do `collect_list` and `collect_set` differ?",
    options: ["collect_set keeps duplicates", "collect_list removes duplicates", "collect_set removes duplicates and doesn't guarantee order", "There's no difference"],
    answer: 2,
    explain: "collect_set returns distinct values with no guaranteed order. Wrap it in array_sort for a stable result. collect_list keeps every value." },
  { id: "pa6", domain: "py-advanced",
    q: "Which date pattern formats 2024-03-07 as `2024-03`?",
    options: ["'yyyy-mm'", "'YYYY-MM'", "'yyyy-MM'", "'%Y-%m'"],
    answer: 2,
    explain: "Spark uses Java patterns: MM is the month and mm is minutes. 'YYYY' is the week-based year, and '%Y' is Python/C strftime syntax." },

  // ---------------------------------------------------------------- io
  { id: "pi1", domain: "py-io",
    q: "What is the default save mode of `df.write.saveAsTable('t')` when table t already exists?",
    options: ["append", "overwrite", "errorifexists (the write fails)", "ignore"],
    answer: 2,
    explain: "The default mode is errorifexists. Set mode('append') or mode('overwrite') explicitly." },
  { id: "pi2", domain: "py-io",
    q: "Why provide an explicit schema when reading large CSV or JSON files?",
    options: ["It's required for CSV", "It avoids an extra inference pass over the data and prevents wrongly inferred types", "It enables time travel", "It compresses the data"],
    answer: 1,
    explain: "Schema inference reads data just to guess types, and it can guess wrong (for example, dropping leading zeros from IDs). An explicit schema is faster and predictable." },
  { id: "pi3", domain: "py-io",
    q: "You build a DeltaTable merge with `.merge(...).whenMatchedUpdateAll().whenNotMatchedInsertAll()` but the table doesn't change. What's missing?",
    options: [".commit()", ".execute()", ".save()", "spark.sql('COMMIT')"],
    answer: 1,
    explain: "The merge builder does nothing until you call .execute()." },
  { id: "pi4", domain: "py-io",
    q: "Which is a good use of `.partitionBy(...)` when writing a large Delta table?",
    options: ["customer_id, with millions of values", "A low-cardinality column that most queries filter on, such as country or event_date", "Every column, for maximum speed", "The primary key, to make updates faster"],
    answer: 1,
    explain: "Partitioning creates a directory per value, so high cardinality creates huge numbers of small files. For new tables, liquid clustering is often the better choice." },
  { id: "pi5", domain: "py-io",
    q: "How do you read version 3 of a Delta table from Python?",
    options: ["spark.table('t', version=3)", "spark.read.option('versionAsOf', 3).table('t')", "spark.read.version(3).table('t')", "DeltaTable.forName(spark, 't').version(3)"],
    answer: 1,
    explain: "Use the versionAsOf (or timestampAsOf) reader option. In SQL: SELECT * FROM t VERSION AS OF 3." },
  { id: "pi6", domain: "py-io",
    q: "An append adds a new column that the target Delta table doesn't have. What lets the write succeed?",
    options: [".option('mergeSchema', 'true')", ".mode('ignore')", ".option('inferSchema', 'true')", "Nothing: Delta always accepts new columns"],
    answer: 0,
    explain: "Delta enforces the schema by default. mergeSchema allows schema evolution (adding columns) on write." },

  // ---------------------------------------------------------------- performance
  { id: "pp1", domain: "py-perf",
    q: "Which transformation causes a shuffle?",
    options: ["filter", "withColumn", "groupBy(...).agg(...)", "select"],
    answer: 2,
    explain: "Aggregating by key needs all rows with the same key in the same partition, which means a wide transformation and a shuffle. filter, withColumn and select are narrow." },
  { id: "pp2", domain: "py-perf",
    q: "When is a broadcast join a good choice?",
    options: ["When both tables are huge", "When one side is small enough to copy to every executor", "Only for full outer joins", "When the join key has many NULLs"],
    answer: 1,
    explain: "Broadcasting the small side avoids shuffling the large side. Broadcasting a large table can cause out-of-memory errors." },
  { id: "pp3", domain: "py-perf",
    q: "You call `df.cache()`. When is the data actually cached?",
    options: ["Immediately", "When the first action computes df", "When you call df.persist()", "At the end of the notebook"],
    answer: 1,
    explain: "cache() is lazy. The data is materialized the first time an action computes it." },
  { id: "pp4", domain: "py-perf",
    q: "Why is a row-at-a-time Python UDF usually slower than built-in functions?",
    options: ["Python is always single-threaded on Spark", "Each row is serialized between the JVM and a Python worker, and the UDF is opaque to the optimizer", "UDFs disable Photon for the whole cluster", "UDFs can't run in parallel"],
    answer: 1,
    explain: "Row-by-row serialization is expensive, and Catalyst can't optimize inside a UDF. Built-ins are best. pandas_udf (Arrow batches) is the faster option when you need custom Python." },
  { id: "pp5", domain: "py-perf",
    q: "Which of these does Adaptive Query Execution (AQE) do at runtime?",
    options: ["Rewrites Python code into SQL", "Coalesces small shuffle partitions, switches join strategies and splits skewed partitions", "Caches every DataFrame", "Automatically adds indexes"],
    answer: 1,
    explain: "AQE re-optimizes using statistics from completed stages: partition coalescing, dynamic join strategy changes and skew-join handling." },
  { id: "pp6", domain: "py-perf",
    q: "What is the default value of `spark.sql.shuffle.partitions`?",
    options: ["8", "64", "200", "The number of cores"],
    answer: 2,
    explain: "It's 200. AQE usually coalesces the resulting partitions to a sensible number." },
  { id: "pp7", domain: "py-perf",
    q: "In the Spark UI, most tasks in a join stage finish in 10 seconds, but three take 15 minutes. What is the likely cause?",
    options: ["Too many executors", "Data skew: a few keys have far more rows than others", "The broadcast threshold is too low", "The driver is out of memory"],
    answer: 1,
    explain: "A few very slow tasks in an otherwise fast stage is the classic sign of skew. AQE skew handling, salting or broadcasting the small side help." }
);

TRAINER.datasetSql.push(
  `CREATE OR REPLACE TABLE carts (cart_id INTEGER, customer_id INTEGER, items INTEGER[], created_at TIMESTAMP)`,
  `INSERT INTO carts VALUES
    (501, 1, [101, 103, 107], '2024-04-01 10:00:00'),
    (502, 2, [105], '2024-04-01 12:30:00'),
    (503, 3, [], '2024-04-02 09:15:00'),
    (504, 4, [103, 104, 107, 107], '2024-04-02 18:45:00'),
    (505, 8, NULL, '2024-04-03 08:00:00'),
    (506, 9, [101, 102], '2024-04-03 21:10:00')`
);
TRAINER.datasetDocs.push(
  { table: "carts", cols: "cart_id, customer_id, items, created_at", note: "items is an array of product ids. One cart is empty and one has NULL items." }
);

const PY_TABLES = 'orders = spark.table("orders")\norder_items = spark.table("order_items")\nproducts = spark.table("products")\n';

TRAINER.exercises.push(
  // ---------------------------------------------------------------- fundamentals
  {
    id: "py-filter", kind: "python", domain: "py-basics", level: "Easy",
    title: "Filter and select",
    prompt: "Return <code>order_id</code> and <code>order_date</code> for <strong>completed</strong> orders placed in <strong>March 2024</strong>, sorted by <code>order_date</code>. Assign the DataFrame to <code>result</code>.",
    starter: "from pyspark.sql import functions as F\n\norders = spark.table(\"orders\")\n\nresult = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")   # add the March 2024 date range\n    .select(\"order_id\", \"order_date\"))\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\norders = spark.table(\"orders\")\n\nresult = (orders\n    .filter((F.col(\"status\") == \"COMPLETED\") &\n            (F.col(\"order_date\") >= \"2024-03-01\") &\n            (F.col(\"order_date\") < \"2024-04-01\"))\n    .select(\"order_id\", \"order_date\")\n    .orderBy(\"order_date\"))\n\nresult.show()",
    ordered: true,
    hints: ["Combine conditions with &, and wrap each one in parentheses.", "Compare a date column with a string like \"2024-03-01\", or use F.month() and F.year().", "Finish with .orderBy(\"order_date\")."]
  },
  {
    id: "py-when", kind: "python", domain: "py-basics", level: "Easy",
    title: "Price bands with when/otherwise",
    prompt: "Return <code>product_name</code>, <code>price</code> and a new column <code>price_band</code>: <code>'premium'</code> if price ≥ 100, <code>'standard'</code> if price ≥ 40, otherwise <code>'budget'</code>.",
    starter: "from pyspark.sql import functions as F\n\nproducts = spark.table(\"products\")\n\nresult = (products\n    .withColumn(\"price_band\", F.lit(\"?\"))   # replace with F.when(...)\n    .select(\"product_name\", \"price\", \"price_band\"))\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\nproducts = spark.table(\"products\")\n\nresult = (products\n    .withColumn(\"price_band\",\n        F.when(F.col(\"price\") >= 100, \"premium\")\n         .when(F.col(\"price\") >= 40, \"standard\")\n         .otherwise(\"budget\"))\n    .select(\"product_name\", \"price\", \"price_band\"))\n\nresult.show()",
    hints: ["Chain .when() calls: the first matching condition wins, so test the highest threshold first.", "End with .otherwise(\"budget\")."]
  },
  {
    id: "py-nulls", kind: "python", domain: "py-basics", level: "Easy",
    title: "Handle missing values",
    prompt: "Return <code>customer_id</code>, <code>name</code> and <code>country</code> for customers who <strong>have an email</strong>. Replace a missing <code>country</code> with <code>'UNKNOWN'</code>.",
    starter: "from pyspark.sql import functions as F\n\ncustomers = spark.table(\"customers\")\n\nresult = customers.select(\"customer_id\", \"name\", \"country\")\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\ncustomers = spark.table(\"customers\")\n\nresult = (customers\n    .filter(F.col(\"email\").isNotNull())\n    .fillna({\"country\": \"UNKNOWN\"})\n    .select(\"customer_id\", \"name\", \"country\"))\n\nresult.show()",
    hints: ["Keep rows with .filter(F.col(\"email\").isNotNull()), or use .dropna(subset=[\"email\"]).", "Fill one column with .fillna({\"country\": \"UNKNOWN\"}) or F.coalesce(\"country\", F.lit(\"UNKNOWN\"))."]
  },
  {
    id: "py-groupby", kind: "python", domain: "py-basics", level: "Easy",
    title: "Count orders by status",
    prompt: "Return <code>status</code> and <code>num_orders</code> (the number of orders with that status), sorted by <code>num_orders</code> descending, then <code>status</code> ascending.",
    starter: "from pyspark.sql import functions as F\n\norders = spark.table(\"orders\")\n\nresult = orders.groupBy(\"status\").count()\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\norders = spark.table(\"orders\")\n\nresult = (orders\n    .groupBy(\"status\")\n    .agg(F.count(\"*\").alias(\"num_orders\"))\n    .orderBy(F.col(\"num_orders\").desc(), \"status\"))\n\nresult.show()",
    ordered: true,
    hints: ["groupBy(...).count() names the column `count`. Use .agg(F.count(\"*\").alias(\"num_orders\")) instead, or rename it.", "Sort with .orderBy(F.col(\"num_orders\").desc(), \"status\")."]
  },
  {
    id: "py-join-revenue", kind: "python", domain: "py-basics", level: "Medium",
    title: "Join three tables: revenue by category",
    prompt: "Calculate revenue (<code>quantity * price</code>) per product <code>category</code> for <strong>completed</strong> orders only. Return <code>category</code> and <code>revenue</code>, highest first.",
    starter: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nresult = (order_items\n    .join(products, \"product_id\")\n    # join orders, filter, aggregate ...\n)\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nresult = (order_items\n    .join(orders, \"order_id\")\n    .join(products, \"product_id\")\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .groupBy(\"category\")\n    .agg(F.sum(F.col(\"quantity\") * F.col(\"price\")).alias(\"revenue\"))\n    .orderBy(F.col(\"revenue\").desc()))\n\nresult.show()",
    ordered: true,
    hints: ["order_items has quantity, products has price and category, and orders has status.", "Joining on a column name (\"order_id\") keeps a single key column, so later references aren't ambiguous.", "F.sum(F.col(\"quantity\") * F.col(\"price\")) sums an expression directly."]
  },
  {
    id: "py-anti", kind: "python", domain: "py-basics", level: "Medium",
    title: "Customers who never ordered",
    prompt: "Return <code>customer_id</code> and <code>name</code> for customers with <strong>no orders at all</strong>. Use the join type made for this.",
    starter: "customers = spark.table(\"customers\")\norders = spark.table(\"orders\")\n\nresult = customers.join(orders, \"customer_id\", \"inner\").select(\"customer_id\", \"name\")\n\nresult.show()",
    solution: "customers = spark.table(\"customers\")\norders = spark.table(\"orders\")\n\nresult = (customers\n    .join(orders, on=\"customer_id\", how=\"left_anti\")\n    .select(\"customer_id\", \"name\"))\n\nresult.show()",
    requires: [{ re: "anti", msg: "Use a left_anti join. It returns left rows that have no match and is cheaper than a left join plus an IS NULL filter." }],
    hints: ["Which join keeps only the left rows that have no match on the right?", "how=\"left_anti\" returns only the left DataFrame's columns."]
  },
  {
    id: "py-strings", kind: "python", domain: "py-basics", level: "Medium",
    title: "Split and clean strings",
    prompt: "Return <code>customer_id</code>, <code>first_name</code> (the first word of <code>name</code>), <code>last_name</code> (the second word, in <strong>upper case</strong>) and <code>email_user</code> (the part of <code>email</code> before the <code>@</code>, NULL when there's no email).",
    starter: "from pyspark.sql import functions as F\n\ncustomers = spark.table(\"customers\")\n\nresult = customers.select(\n    \"customer_id\",\n    # first_name, last_name, email_user\n)\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\ncustomers = spark.table(\"customers\")\n\nresult = customers.select(\n    \"customer_id\",\n    F.split(\"name\", \" \").getItem(0).alias(\"first_name\"),\n    F.upper(F.split(\"name\", \" \").getItem(1)).alias(\"last_name\"),\n    F.split(\"email\", \"@\").getItem(0).alias(\"email_user\"))\n\nresult.show()",
    hints: ["F.split(col, pattern) returns an array, and .getItem(0) takes its first element.", "Functions return NULL for NULL input, so customers without an email get NULL automatically."]
  },

  // ---------------------------------------------------------------- advanced
  {
    id: "py-dedup", kind: "python", domain: "py-advanced", level: "Medium",
    title: "Deduplicate with a window",
    prompt: "<code>bronze_events</code> contains the same <code>event_id</code> ingested several times. Return one row per <code>event_id</code> with all the original columns, keeping the row with the <strong>latest</strong> <code>ingest_ts</code>.",
    starter: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\nevents = spark.table(\"bronze_events\")\n\nresult = events.dropDuplicates()   # why doesn't this work?\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\nevents = spark.table(\"bronze_events\")\n\nw = Window.partitionBy(\"event_id\").orderBy(F.col(\"ingest_ts\").desc())\nresult = (events\n    .withColumn(\"rn\", F.row_number().over(w))\n    .filter(F.col(\"rn\") == 1)\n    .drop(\"rn\"))\n\nresult.show()",
    requires: [{ re: "row_number|rank", msg: "Use a window function (row_number) so you control which duplicate is kept." }],
    hints: ["dropDuplicates() only removes rows identical in every column, and the copies have different ingest_ts.", "Number the rows within each event_id, newest first, then keep row 1 and drop the helper column."]
  },
  {
    id: "py-lag", kind: "python", domain: "py-advanced", level: "Medium",
    title: "Days since the previous order",
    prompt: "For <strong>every</strong> order, return <code>customer_id</code>, <code>order_id</code>, <code>order_date</code> and <code>days_since_prev</code>: the number of days since the same customer's previous order (NULL for their first order). Sort by <code>customer_id</code>, then <code>order_date</code>.",
    starter: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\norders = spark.table(\"orders\")\n\nw = Window.partitionBy(\"customer_id\").orderBy(\"order_date\")\nresult = orders.select(\"customer_id\", \"order_id\", \"order_date\")\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\norders = spark.table(\"orders\")\n\nw = Window.partitionBy(\"customer_id\").orderBy(\"order_date\")\nresult = (orders\n    .withColumn(\"prev_date\", F.lag(\"order_date\").over(w))\n    .select(\"customer_id\", \"order_id\", \"order_date\",\n            F.datediff(\"order_date\", \"prev_date\").alias(\"days_since_prev\"))\n    .orderBy(\"customer_id\", \"order_date\"))\n\nresult.show()",
    ordered: true,
    hints: ["F.lag(\"order_date\").over(w) gives the previous order's date within the customer.", "F.datediff(end, start) returns whole days. The end date comes first."]
  },
  {
    id: "py-running", kind: "python", domain: "py-advanced", level: "Hard",
    title: "Running total per customer",
    prompt: "For <strong>completed</strong> orders, compute each order's total (<code>order_total</code> = sum of quantity × price) and a <code>running_total</code> per customer in date order. Return <code>customer_id</code>, <code>order_id</code>, <code>order_date</code>, <code>order_total</code> and <code>running_total</code>, sorted by <code>customer_id</code> then <code>order_date</code>.",
    starter: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\n" + PY_TABLES + "\norder_totals = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    # join items and products, then aggregate per order\n)\n\nresult = order_totals\nresult.show()",
    solution: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\n" + PY_TABLES + "\norder_totals = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .join(order_items, \"order_id\")\n    .join(products, \"product_id\")\n    .groupBy(\"customer_id\", \"order_id\", \"order_date\")\n    .agg(F.sum(F.col(\"quantity\") * F.col(\"price\")).alias(\"order_total\")))\n\nw = (Window.partitionBy(\"customer_id\").orderBy(\"order_date\")\n     .rowsBetween(Window.unboundedPreceding, Window.currentRow))\n\nresult = (order_totals\n    .withColumn(\"running_total\", F.sum(\"order_total\").over(w))\n    .orderBy(\"customer_id\", \"order_date\"))\n\nresult.show()",
    ordered: true,
    hints: ["First aggregate to one row per order: groupBy customer_id, order_id and order_date.", "Then sum order_total over a window partitioned by customer_id and ordered by order_date.", "rowsBetween(Window.unboundedPreceding, Window.currentRow) makes the frame explicit."]
  },
  {
    id: "py-top-product", kind: "python", domain: "py-advanced", level: "Hard",
    title: "Top product per category",
    prompt: "Using <strong>completed</strong> orders, find the product(s) with the highest total quantity sold in each category. Keep ties. Return <code>category</code>, <code>product_name</code> and <code>total_qty</code>.",
    starter: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\n" + PY_TABLES + "\nqty = (order_items\n    .join(orders, \"order_id\")\n    .join(products, \"product_id\")\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .groupBy(\"category\", \"product_name\")\n    .agg(F.sum(\"quantity\").alias(\"total_qty\")))\n\nresult = qty   # keep only the top product(s) in each category\nresult.show()",
    solution: "from pyspark.sql import functions as F\nfrom pyspark.sql.window import Window\n\n" + PY_TABLES + "\nqty = (order_items\n    .join(orders, \"order_id\")\n    .join(products, \"product_id\")\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .groupBy(\"category\", \"product_name\")\n    .agg(F.sum(\"quantity\").alias(\"total_qty\")))\n\nw = Window.partitionBy(\"category\").orderBy(F.col(\"total_qty\").desc())\nresult = (qty\n    .withColumn(\"rnk\", F.dense_rank().over(w))\n    .filter(F.col(\"rnk\") == 1)\n    .select(\"category\", \"product_name\", \"total_qty\"))\n\nresult.show()",
    hints: ["Rank within each category by total_qty, descending.", "row_number would keep only one of two tied products. rank or dense_rank keeps both."]
  },
  {
    id: "py-explode", kind: "python", domain: "py-advanced", level: "Medium",
    title: "Explode arrays",
    prompt: "The <code>carts</code> table has an <code>items</code> array of product ids. For each product, count <strong>how many different carts</strong> contain it. Return <code>product_name</code> and <code>carts</code>, sorted by <code>carts</code> descending, then <code>product_name</code>.",
    starter: "from pyspark.sql import functions as F\n\ncarts = spark.table(\"carts\")\nproducts = spark.table(\"products\")\n\ncarts.show()\nresult = carts\n",
    solution: "from pyspark.sql import functions as F\n\ncarts = spark.table(\"carts\")\nproducts = spark.table(\"products\")\n\nresult = (carts\n    .select(\"cart_id\", F.explode(\"items\").alias(\"product_id\"))\n    .join(products, \"product_id\")\n    .groupBy(\"product_name\")\n    .agg(F.countDistinct(\"cart_id\").alias(\"carts\"))\n    .orderBy(F.col(\"carts\").desc(), \"product_name\"))\n\nresult.show()",
    ordered: true,
    hints: ["F.explode(\"items\") gives one row per array element.", "Cart 504 contains product 107 twice, so count distinct cart_ids, not rows."]
  },
  {
    id: "py-collect", kind: "python", domain: "py-advanced", level: "Medium",
    title: "Collect values into arrays",
    prompt: "For each customer with <strong>completed</strong> orders, return <code>customer_id</code> and <code>categories</code>: the <strong>sorted, distinct</strong> list of product categories they bought.",
    starter: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nresult = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .join(order_items, \"order_id\")\n    .join(products, \"product_id\")\n    # group and collect ...\n)\n\nresult.show(truncate=False)",
    solution: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nresult = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .join(order_items, \"order_id\")\n    .join(products, \"product_id\")\n    .groupBy(\"customer_id\")\n    .agg(F.array_sort(F.collect_set(\"category\")).alias(\"categories\")))\n\nresult.show(truncate=False)",
    hints: ["collect_set removes duplicates. collect_list keeps them.", "collect_set doesn't guarantee order, so wrap it in F.array_sort(...)."]
  },
  {
    id: "py-pivot", kind: "python", domain: "py-advanced", level: "Hard",
    title: "Pivot monthly revenue",
    prompt: "For <strong>completed</strong> orders, build a table with one row per <code>month</code> (formatted <code>yyyy-MM</code>) and one revenue column per category: <code>Books</code>, <code>Courses</code>, <code>Merch</code>. Sort by month.",
    starter: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nlines = (order_items\n    .join(orders, \"order_id\")\n    .join(products, \"product_id\")\n    .filter(F.col(\"status\") == \"COMPLETED\"))\n\nresult = lines\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "\nlines = (order_items\n    .join(orders, \"order_id\")\n    .join(products, \"product_id\")\n    .filter(F.col(\"status\") == \"COMPLETED\"))\n\nresult = (lines\n    .withColumn(\"month\", F.date_format(\"order_date\", \"yyyy-MM\"))\n    .withColumn(\"revenue\", F.col(\"quantity\") * F.col(\"price\"))\n    .groupBy(\"month\")\n    .pivot(\"category\", [\"Books\", \"Courses\", \"Merch\"])\n    .agg(F.sum(\"revenue\"))\n    .orderBy(\"month\"))\n\nresult.show()",
    ordered: true,
    hints: ["F.date_format(\"order_date\", \"yyyy-MM\"): MM is the month, mm would be minutes.", "groupBy(\"month\").pivot(\"category\", [...]).agg(F.sum(\"revenue\"))."]
  },

  // ---------------------------------------------------------------- io (pattern-checked)
  {
    id: "pat-py-readwrite", kind: "pattern", domain: "py-io", level: "Medium", lang: "python",
    title: "Read CSV with a schema, write a Delta table",
    prompt: "Read the CSV files in <code>/Volumes/main/raw/landing/customers/</code>, which have a <strong>header row</strong>, using an explicit schema <code>customer_id INT, name STRING, country STRING</code>. Then write them as a <strong>Delta</strong> table <code>main.bronze.customers</code>, <strong>replacing</strong> existing data and <strong>partitioned by</strong> <code>country</code>.",
    starter: "schema = \"customer_id INT, name STRING, country STRING\"\n\ndf = (spark.read\n    .format(\"____\")\n    .option(\"____\", \"true\")\n    .____(schema)\n    .load(\"/Volumes/main/raw/landing/customers/\"))\n\n(df.write\n    .format(\"delta\")\n    .mode(\"____\")\n    .____(\"country\")\n    .saveAsTable(\"____\"))",
    solution: "schema = \"customer_id INT, name STRING, country STRING\"\n\ndf = (spark.read\n    .format(\"csv\")\n    .option(\"header\", \"true\")\n    .schema(schema)\n    .load(\"/Volumes/main/raw/landing/customers/\"))\n\n(df.write\n    .format(\"delta\")\n    .mode(\"overwrite\")\n    .partitionBy(\"country\")\n    .saveAsTable(\"main.bronze.customers\"))",
    checks: [
      { re: "spark\\.read", msg: "Start from spark.read." },
      { re: "\\.format\\(\\s*['\"]csv['\"]\\s*\\)|\\.csv\\(", msg: "Read with .format(\"csv\") (or the .csv(path) shortcut)." },
      { re: "\\.option\\(\\s*['\"]header['\"]\\s*,\\s*(['\"]true['\"]|True)\\s*\\)", msg: "Set .option(\"header\", \"true\") so the first line becomes column names." },
      { re: "\\.schema\\(", msg: "Pass the schema with .schema(schema) to skip inference." },
      { re: "\\.mode\\(\\s*['\"]overwrite['\"]\\s*\\)", msg: "Replace existing data with .mode(\"overwrite\")." },
      { re: "\\.partitionBy\\(\\s*['\"]country['\"]\\s*\\)", msg: "Partition the output with .partitionBy(\"country\")." },
      { re: "\\.saveAsTable\\(\\s*['\"]main\\.bronze\\.customers['\"]\\s*\\)", msg: "Save to the catalog table with .saveAsTable(\"main.bronze.customers\")." }
    ],
    hints: ["Reader options are key/value strings: .option(\"header\", \"true\").", "Writer order doesn't matter, but every setting goes before .saveAsTable()."]
  },
  {
    id: "pat-py-merge", kind: "pattern", domain: "py-io", level: "Medium", lang: "python",
    title: "Upsert with DeltaTable.merge",
    prompt: "Using the Delta Python API, upsert the DataFrame <code>updates</code> into <code>main.silver.customers</code> on <code>customer_id</code>: update all columns of matching rows and insert new ones. Alias the target <code>t</code> and the source <code>s</code>.",
    starter: "from delta.tables import DeltaTable\n\ntarget = DeltaTable.____(spark, \"main.silver.customers\")\n\n(target.alias(\"t\")\n    .merge(updates.alias(\"s\"), \"____\")\n    .____()\n    .____()\n    .____())",
    solution: "from delta.tables import DeltaTable\n\ntarget = DeltaTable.forName(spark, \"main.silver.customers\")\n\n(target.alias(\"t\")\n    .merge(updates.alias(\"s\"), \"t.customer_id = s.customer_id\")\n    .whenMatchedUpdateAll()\n    .whenNotMatchedInsertAll()\n    .execute())",
    checks: [
      { re: "from\\s+delta\\.tables\\s+import\\s+DeltaTable", msg: "Import it with: from delta.tables import DeltaTable" },
      { re: "DeltaTable\\.forName\\(\\s*spark\\s*,\\s*['\"]main\\.silver\\.customers['\"]\\s*\\)", msg: "Get the table with DeltaTable.forName(spark, \"main.silver.customers\")." },
      { re: "\\.alias\\(\\s*['\"]t['\"]\\s*\\)", msg: "Alias the target: target.alias(\"t\")." },
      { re: "\\.merge\\(\\s*updates\\.alias\\(\\s*['\"]s['\"]\\s*\\)\\s*,\\s*['\"]\\s*(t\\.customer_id\\s*=\\s*s\\.customer_id|s\\.customer_id\\s*=\\s*t\\.customer_id)\\s*['\"]\\s*\\)", msg: "Merge with .merge(updates.alias(\"s\"), \"t.customer_id = s.customer_id\")." },
      { re: "\\.whenMatchedUpdateAll\\(\\s*\\)", msg: "Update matching rows with .whenMatchedUpdateAll()." },
      { re: "\\.whenNotMatchedInsertAll\\(\\s*\\)", msg: "Insert new rows with .whenNotMatchedInsertAll()." },
      { re: "\\.execute\\(\\s*\\)", msg: "Finish with .execute(). Without it the merge never runs." }
    ],
    hints: ["The merge condition is a SQL string that uses the aliases.", "The builder is lazy until .execute()."]
  },
  {
    id: "pat-py-timetravel", kind: "pattern", domain: "py-io", level: "Easy", lang: "python",
    title: "History, time travel and restore in Python",
    prompt: "For <code>main.silver.orders</code>: (1) get a <code>DeltaTable</code> and show its history, (2) read <strong>version 8</strong> into a DataFrame <code>v8</code> with the reader option, (3) restore the table to version 8.",
    starter: "from delta.tables import DeltaTable\n\ndt = DeltaTable.forName(spark, \"main.silver.orders\")\n# 1. history\n\n# 2. read version 8\nv8 = ____\n\n# 3. restore\n",
    solution: "from delta.tables import DeltaTable\n\ndt = DeltaTable.forName(spark, \"main.silver.orders\")\ndt.history().select(\"version\", \"timestamp\", \"operation\").show()\n\nv8 = spark.read.option(\"versionAsOf\", 8).table(\"main.silver.orders\")\n\ndt.restoreToVersion(8)",
    checks: [
      { re: "dt\\.history\\(", msg: "Show the version history with dt.history()." },
      { re: "spark\\.read\\.option\\(\\s*['\"]versionAsOf['\"]\\s*,\\s*['\"]?8['\"]?\\s*\\)\\.table\\(\\s*['\"]main\\.silver\\.orders['\"]\\s*\\)", msg: "Read an old version with spark.read.option(\"versionAsOf\", 8).table(\"main.silver.orders\")." },
      { re: "dt\\.restoreToVersion\\(\\s*8\\s*\\)", msg: "Restore with dt.restoreToVersion(8)." }
    ],
    hints: ["History is a DataFrame, so you can select and show it.", "Time travel is a reader option: versionAsOf or timestampAsOf."]
  },

  // ---------------------------------------------------------------- performance
  {
    id: "py-broadcast", kind: "python", domain: "py-perf", level: "Easy",
    title: "Broadcast the small table",
    prompt: "Compute revenue (<code>quantity * price</code>) per customer <code>country</code> for <strong>completed</strong> orders, rounded to 2 decimals and sorted highest first. Return <code>country</code> and <code>revenue</code>. <code>customers</code> and <code>products</code> are small dimension tables: give Spark a <strong>broadcast hint</strong> for them.",
    starter: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "customers = spark.table(\"customers\")\n\nresult = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .join(order_items, \"order_id\")\n    .join(products, \"product_id\")\n    .join(customers, \"customer_id\")\n    # aggregate per country ...\n)\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\n" + PY_TABLES + "customers = spark.table(\"customers\")\n\nresult = (orders\n    .filter(F.col(\"status\") == \"COMPLETED\")\n    .join(order_items, \"order_id\")\n    .join(F.broadcast(products), \"product_id\")\n    .join(F.broadcast(customers), \"customer_id\")\n    .groupBy(\"country\")\n    .agg(F.round(F.sum(F.col(\"quantity\") * F.col(\"price\")), 2).alias(\"revenue\"))\n    .orderBy(F.col(\"revenue\").desc()))\n\nresult.show()",
    ordered: true,
    requires: [{ re: "broadcast\\(", msg: "Wrap the small tables in F.broadcast(...) when joining them." }],
    hints: ["F.broadcast(df) marks a DataFrame as small enough to send to every executor, so the big side isn't shuffled.", "In this trainer the hint has no effect on speed, but on Databricks you'd see a BroadcastHashJoin in explain()."]
  }
);
