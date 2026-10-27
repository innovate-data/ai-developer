// Data Engineer Professional track: extra sample tables, exercises and case studies.

window.TRAINER = window.TRAINER || {};

TRAINER.datasetSql.push(
  `CREATE OR REPLACE TABLE customer_updates (customer_id INTEGER, name VARCHAR, email VARCHAR, country VARCHAR, op VARCHAR, seq INTEGER, change_ts TIMESTAMP)`,
  `INSERT INTO customer_updates VALUES
    (2,'Ben Okafor','ben@example.com','IE','UPDATE',3,'2024-05-02 10:00:00'),
    (11,'Kai Berg','kai@example.com','SE','INSERT',1,'2024-05-01 09:00:00'),
    (3,'Chen Li','chen@example.com','US','UPDATE',2,'2024-05-01 12:00:00'),
    (12,'Lena Weiss','lena@example.com','DE','INSERT',4,'2024-05-03 11:00:00'),
    (5,'Eli Moreau','eli@example.com','FR','DELETE',5,'2024-05-04 08:00:00'),
    (2,'Ben Okafor','ben.o@example.com','IE','UPDATE',7,'2024-05-06 09:00:00'),
    (11,'Kai Berg','kai@example.com','NO','UPDATE',6,'2024-05-05 15:00:00'),
    (7,'Gus Romero','gus@example.com','MX','UPDATE',8,'2024-05-07 16:00:00'),
    (3,'Chen Li','chen@example.com','US','UPDATE',2,'2024-05-01 12:00:00'),
    (12,'Lena Weiss','lena@example.com','DE','DELETE',9,'2024-05-08 10:00:00')`,
  `CREATE OR REPLACE TABLE orders_cdf (order_id INTEGER, status VARCHAR, _change_type VARCHAR, _commit_version INTEGER)`,
  `INSERT INTO orders_cdf VALUES
    (1006,'PENDING','insert',1),
    (1013,'PENDING','insert',2),
    (1006,'PENDING','update_preimage',3),
    (1006,'COMPLETED','update_postimage',3),
    (1013,'PENDING','delete',4),
    (1014,'PENDING','insert',4),
    (1014,'PENDING','update_preimage',5),
    (1014,'SHIPPED','update_postimage',5),
    (1004,'CANCELLED','delete',5),
    (1015,'PENDING','insert',5)`
);

TRAINER.datasetDocs.push(
  { table: "customer_updates", cols: "customer_id, name, email, country, op, seq, change_ts", note: "A CDC feed for customers: op is INSERT, UPDATE or DELETE, seq orders the changes. Rows arrive out of order and one change was delivered twice." },
  { table: "orders_cdf", cols: "order_id, status, _change_type, _commit_version", note: "Rows as read from a Delta Change Data Feed: insert, update_preimage, update_postimage and delete." }
);

const PRO_CUST = 'customers = spark.table("customers")\nupdates = spark.table("customer_updates")\n';

TRAINER.exercises.push(
  // ---------------------------------------------------------------- SQL
  {
    id: "pro-sql-latest", kind: "sql", domain: "pro-code", level: "Medium",
    title: "Latest change per key from a CDC feed",
    prompt: "<code>customer_updates</code> is a change feed that arrives out of order. Return <code>customer_id</code>, <code>op</code>, <code>country</code> and <code>seq</code> for the <strong>latest change</strong> (highest <code>seq</code>) of each customer, sorted by <code>customer_id</code>. This is the deduplicated source a MERGE needs.",
    starter: "SELECT customer_id, op, country, seq\nFROM customer_updates\n-- keep only the latest change per customer\nORDER BY customer_id;",
    solution: "SELECT customer_id, op, country, seq\nFROM customer_updates\nQUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY seq DESC) = 1\nORDER BY customer_id;",
    ordered: true,
    hints: ["Number the rows of each customer with row_number() OVER (PARTITION BY customer_id ORDER BY seq DESC).", "QUALIFY filters on a window function without a subquery: QUALIFY row_number() OVER (...) = 1."]
  },
  {
    id: "pro-sql-merge-preview", kind: "sql", domain: "pro-code", level: "Hard",
    title: "Preview what a MERGE will do",
    prompt: "Before running <code>MERGE INTO customers USING (latest change per key) ...</code>, report the action for each key in <code>customer_updates</code>. Use the latest change per <code>customer_id</code> (highest <code>seq</code>), then return <code>customer_id</code> and <code>action</code>:<ul><li><code>'delete'</code>: the customer exists in <code>customers</code> and the change is a DELETE</li><li><code>'update'</code>: the customer exists and the change isn't a DELETE</li><li><code>'insert'</code>: the customer doesn't exist and the change isn't a DELETE</li><li><code>'ignore'</code>: the customer doesn't exist and the change is a DELETE</li></ul>Sort by <code>customer_id</code>.",
    starter: "WITH latest AS (\n  SELECT * FROM customer_updates\n  -- one row per customer_id: the highest seq\n)\nSELECT l.customer_id, 'update' AS action\nFROM latest l\nORDER BY l.customer_id;",
    solution: "WITH latest AS (\n  SELECT * FROM customer_updates\n  QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY seq DESC) = 1\n)\nSELECT l.customer_id,\n       CASE WHEN c.customer_id IS NOT NULL AND l.op = 'DELETE' THEN 'delete'\n            WHEN c.customer_id IS NOT NULL THEN 'update'\n            WHEN l.op = 'DELETE' THEN 'ignore'\n            ELSE 'insert' END AS action\nFROM latest l\nLEFT JOIN customers c ON l.customer_id = c.customer_id\nORDER BY l.customer_id;",
    ordered: true,
    hints: ["Deduplicate first with QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY seq DESC) = 1.", "LEFT JOIN customers: c.customer_id IS NULL means the key isn't in the target (WHEN NOT MATCHED).", "A CASE expression maps (matched?, op) to the action. Customer 12 was inserted and deleted in the same feed, so its MERGE does nothing."]
  },
  {
    id: "pro-sql-scd2", kind: "sql", domain: "pro-model", level: "Hard",
    title: "Build SCD Type 2 history from a change log",
    prompt: "Build a Type 2 history of <code>country</code> from <code>customer_updates</code>. First remove exact duplicate deliveries. Each non-delete change starts a version that is valid until the customer's <strong>next change of any kind</strong>, so a DELETE closes the last version. Return <code>customer_id</code>, <code>country</code>, <code>valid_from</code> (the change's <code>change_ts</code>), <code>valid_to</code> (NULL if still open) and <code>is_current</code> (true when <code>valid_to</code> is NULL). Leave out the DELETE rows themselves, and sort by <code>customer_id</code>, <code>valid_from</code>.",
    starter: "WITH changes AS (\n  SELECT DISTINCT customer_id, country, op, change_ts FROM customer_updates\n)\nSELECT customer_id, country,\n       change_ts AS valid_from\n       -- valid_to, is_current\nFROM changes\nWHERE op <> 'DELETE'\nORDER BY customer_id, valid_from;",
    solution: "WITH changes AS (\n  SELECT DISTINCT customer_id, country, op, change_ts FROM customer_updates\n),\nversions AS (\n  SELECT customer_id, country, op,\n         change_ts AS valid_from,\n         lead(change_ts) OVER (PARTITION BY customer_id ORDER BY change_ts) AS valid_to\n  FROM changes\n)\nSELECT customer_id, country, valid_from, valid_to,\n       valid_to IS NULL AS is_current\nFROM versions\nWHERE op <> 'DELETE'\nORDER BY customer_id, valid_from;",
    ordered: true,
    hints: ["lead(change_ts) OVER (PARTITION BY customer_id ORDER BY change_ts) gives the start of the next version.", "WHERE runs before window functions. Compute lead() over all changes in a CTE, then filter out the DELETE rows in the outer query, so a delete still closes the version before it.", "is_current is simply valid_to IS NULL."]
  },
  {
    id: "pro-sql-dq", kind: "sql", domain: "pro-manip", level: "Medium",
    title: "Data quality report for a bronze table",
    prompt: "Profile <code>bronze_events</code> per <code>event_type</code>. Return <code>event_type</code>, <code>total_rows</code>, <code>duplicate_rows</code> (rows beyond the first for each <code>event_id</code>) and <code>late_rows</code> (rows ingested more than <strong>30 minutes</strong> after <code>event_ts</code>), sorted by <code>event_type</code>.",
    starter: "SELECT event_type,\n       count(*) AS total_rows\nFROM bronze_events\nGROUP BY event_type\nORDER BY event_type;",
    solution: "SELECT event_type,\n       count(*) AS total_rows,\n       count(*) - count(DISTINCT event_id) AS duplicate_rows,\n       count_if(ingest_ts > event_ts + INTERVAL 30 MINUTES) AS late_rows\nFROM bronze_events\nGROUP BY event_type\nORDER BY event_type;",
    ordered: true,
    hints: ["Duplicates beyond the first = count(*) - count(DISTINCT event_id).", "count_if(condition) counts the rows where the condition is true.", "Compare ingest_ts with event_ts + INTERVAL 30 MINUTES."]
  },

  // ---------------------------------------------------------------- PySpark
  {
    id: "pro-py-scd1", kind: "python", domain: "pro-model", level: "Hard",
    title: "Apply a CDC feed as SCD Type 1",
    prompt: "Compute what <code>customers</code> looks like after applying <code>customer_updates</code> as SCD Type 1, which is what a MERGE with update, delete and insert clauses produces. Take the <strong>latest change per <code>customer_id</code></strong> (highest <code>seq</code>). Customers with no change stay as they are. Changed customers get the new values, or are removed if the latest change is a DELETE. New customers are added unless their latest change is a DELETE. Return <code>customer_id</code>, <code>name</code>, <code>email</code>, <code>country</code>.",
    starter: "from pyspark.sql import functions as F, Window\n\n" + PRO_CUST + "\nresult = customers.select(\"customer_id\", \"name\", \"email\", \"country\")\n\nresult.orderBy(\"customer_id\").show()",
    solution: "from pyspark.sql import functions as F, Window\n\n" + PRO_CUST + "\nw = Window.partitionBy(\"customer_id\").orderBy(F.col(\"seq\").desc())\nlatest = (updates\n    .withColumn(\"rn\", F.row_number().over(w))\n    .filter(\"rn = 1\").drop(\"rn\"))\n\ncols = [\"customer_id\", \"name\", \"email\", \"country\"]\nunchanged = customers.join(latest, \"customer_id\", \"left_anti\").select(*cols)\nupserts = latest.filter(F.col(\"op\") != \"DELETE\").select(*cols)\nresult = unchanged.unionByName(upserts)\n\nresult.orderBy(\"customer_id\").show()",
    requires: [{ re: "row_number|max_by|max\\(", msg: "Pick the latest change per key explicitly (row_number over a window, or max_by), since the feed is out of order." }],
    hints: ["Latest change per key: F.row_number().over(Window.partitionBy(\"customer_id\").orderBy(F.col(\"seq\").desc())) and keep rn = 1.", "Customers without a change: customers.join(latest, \"customer_id\", \"left_anti\").", "Changed or new customers whose latest op isn't DELETE come from latest. Combine both with unionByName."]
  },
  {
    id: "pro-py-incremental", kind: "python", domain: "pro-ingest", level: "Medium",
    title: "Incremental load with a high-water mark",
    prompt: "The last run processed <code>bronze_events</code> up to <code>ingest_ts = '2024-04-01 10:00:00'</code>. Return the events this run should add to silver: rows ingested <strong>after</strong> the mark, one row per <code>event_id</code>, and <strong>no event that an earlier run already loaded</strong> (a late re-delivery of an old event must be skipped). Return <code>event_id</code>, <code>event_type</code>, <code>event_ts</code>.",
    starter: "from pyspark.sql import functions as F\n\nevents = spark.table(\"bronze_events\")\nhwm = \"2024-04-01 10:00:00\"\n\nresult = (events\n    .filter(F.col(\"ingest_ts\") > hwm)\n    .select(\"event_id\", \"event_type\", \"event_ts\"))\n\nresult.show()",
    solution: "from pyspark.sql import functions as F\n\nevents = spark.table(\"bronze_events\")\nhwm = \"2024-04-01 10:00:00\"\n\nalready_loaded = events.filter(F.col(\"ingest_ts\") <= hwm).select(\"event_id\")\nresult = (events\n    .filter(F.col(\"ingest_ts\") > hwm)\n    .join(already_loaded, \"event_id\", \"left_anti\")\n    .dropDuplicates([\"event_id\"])\n    .select(\"event_id\", \"event_type\", \"event_ts\"))\n\nresult.show()",
    hints: ["New rows: ingest_ts > hwm. They can still contain the same event_id more than once.", "Events loaded by earlier runs are the ones with ingest_ts <= hwm. Remove them with a left_anti join on event_id, which works like an insert-only MERGE.", "Finish with dropDuplicates([\"event_id\"])."]
  },
  {
    id: "pro-py-cdf", kind: "python", domain: "pro-perf", level: "Medium",
    title: "Net changes from a Change Data Feed",
    prompt: "<code>orders_cdf</code> holds rows read with <code>readChangeFeed</code>. Return the <strong>current state</strong> of each order that appears in the feed: ignore <code>update_preimage</code> rows, keep the row with the highest <code>_commit_version</code> per <code>order_id</code>, and leave out orders whose latest change is a <code>delete</code>. Return <code>order_id</code>, <code>status</code>, <code>_commit_version</code>.",
    starter: "from pyspark.sql import functions as F, Window\n\ncdf = spark.table(\"orders_cdf\")\n\nresult = cdf.filter(F.col(\"_change_type\") != \"update_preimage\").select(\"order_id\", \"status\", \"_commit_version\")\n\nresult.show()",
    solution: "from pyspark.sql import functions as F, Window\n\ncdf = spark.table(\"orders_cdf\")\n\nw = Window.partitionBy(\"order_id\").orderBy(F.col(\"_commit_version\").desc())\nresult = (cdf\n    .filter(F.col(\"_change_type\") != \"update_preimage\")\n    .withColumn(\"rn\", F.row_number().over(w))\n    .filter((F.col(\"rn\") == 1) & (F.col(\"_change_type\") != \"delete\"))\n    .select(\"order_id\", \"status\", \"_commit_version\"))\n\nresult.show()",
    hints: ["Remove update_preimage rows first: they hold the old values, and they share a commit version with the postimage.", "row_number() over Window.partitionBy(\"order_id\").orderBy(F.col(\"_commit_version\").desc()), then keep rn == 1.", "Filter out deletes after picking the latest row, not before. Otherwise a deleted order would show its earlier insert."]
  },
  {
    id: "pro-py-quarantine", kind: "python", domain: "pro-manip", level: "Medium",
    title: "Deduplicate and flag records for quarantine",
    prompt: "Clean <code>bronze_events</code> for silver: keep one row per <code>event_id</code>, the <strong>first one ingested</strong> (earliest <code>ingest_ts</code>). Add a column <code>quality</code> that is <code>'quarantine'</code> when <code>customer_id</code> is NULL and <code>'valid'</code> otherwise. Return <code>event_id</code>, <code>customer_id</code>, <code>event_type</code>, <code>ingest_ts</code>, <code>quality</code>.",
    starter: "from pyspark.sql import functions as F, Window\n\nevents = spark.table(\"bronze_events\")\n\nresult = (events\n    .dropDuplicates([\"event_id\"])\n    .select(\"event_id\", \"customer_id\", \"event_type\", \"ingest_ts\"))\n\nresult.show()",
    solution: "from pyspark.sql import functions as F, Window\n\nevents = spark.table(\"bronze_events\")\n\nw = Window.partitionBy(\"event_id\").orderBy(\"ingest_ts\")\nresult = (events\n    .withColumn(\"rn\", F.row_number().over(w))\n    .filter(\"rn = 1\")\n    .withColumn(\"quality\", F.when(F.col(\"customer_id\").isNull(), \"quarantine\").otherwise(\"valid\"))\n    .select(\"event_id\", \"customer_id\", \"event_type\", \"ingest_ts\", \"quality\"))\n\nresult.show()",
    requires: [{ re: "row_number|min\\(|min_by", msg: "dropDuplicates keeps an arbitrary copy. Choose the earliest ingest explicitly, for example with row_number() ordered by ingest_ts." }],
    hints: ["dropDuplicates keeps an arbitrary row per key, so it can't guarantee the earliest ingest.", "row_number() over Window.partitionBy(\"event_id\").orderBy(\"ingest_ts\") and keep rn = 1.", "F.when(F.col(\"customer_id\").isNull(), \"quarantine\").otherwise(\"valid\")."]
  },

  // ---------------------------------------------------------------- syntax
  {
    id: "pro-pat-foreachbatch", kind: "pattern", domain: "pro-code", level: "Hard", lang: "python",
    title: "Streaming upsert with foreachBatch and MERGE",
    prompt: "Complete a stream that upserts changes from <code>main.bronze.customer_changes</code> into <code>main.silver.customers</code>. In <code>upsert</code>, keep only the <strong>latest change per <code>customer_id</code></strong> (highest <code>seq</code>), then MERGE on <code>customer_id</code>: update all columns when matched, insert all when not matched. Write with <code>foreachBatch</code>, a <code>checkpointLocation</code>, and an <strong>availableNow</strong> trigger.",
    starter: "from delta.tables import DeltaTable\nfrom pyspark.sql import functions as F, Window\n\ndef upsert(batch_df, batch_id):\n    # 1. latest change per customer_id\n    latest = ____\n    # 2. MERGE into main.silver.customers\n    ____\n\n(spark.readStream.table(\"main.bronze.customer_changes\")\n    .writeStream\n    ____\n    .start())",
    solution: "from delta.tables import DeltaTable\nfrom pyspark.sql import functions as F, Window\n\ndef upsert(batch_df, batch_id):\n    w = Window.partitionBy(\"customer_id\").orderBy(F.col(\"seq\").desc())\n    latest = (batch_df.withColumn(\"rn\", F.row_number().over(w))\n                      .filter(\"rn = 1\").drop(\"rn\"))\n    (DeltaTable.forName(spark, \"main.silver.customers\").alias(\"t\")\n        .merge(latest.alias(\"s\"), \"t.customer_id = s.customer_id\")\n        .whenMatchedUpdateAll()\n        .whenNotMatchedInsertAll()\n        .execute())\n\n(spark.readStream.table(\"main.bronze.customer_changes\")\n    .writeStream\n    .foreachBatch(upsert)\n    .option(\"checkpointLocation\", \"/Volumes/main/chk/customers\")\n    .trigger(availableNow=True)\n    .start())",
    checks: [
      { re: "row_number\\(\\)|dropDuplicates|max_by", msg: "Deduplicate the batch to one row per customer_id. MERGE fails if several source rows match one target row." },
      { re: "seq[\"']\\s*\\)\\s*\\.desc\\(\\)|desc\\(\\s*[\"']seq[\"']\\s*\\)", msg: "Order by seq descending so the latest change wins." },
      { re: "DeltaTable\\.forName\\(\\s*spark\\s*,\\s*[\"']main\\.silver\\.customers[\"']\\s*\\)", msg: "Get the target with DeltaTable.forName(spark, \"main.silver.customers\")." },
      { re: "\\.merge\\(\\s*\\w+(\\.alias\\([\"']s[\"']\\))?\\s*,\\s*[\"'](t\\.customer_id\\s*=\\s*s\\.customer_id|s\\.customer_id\\s*=\\s*t\\.customer_id)[\"']", msg: "Merge the deduplicated batch on \"t.customer_id = s.customer_id\" (alias the target \"t\" and the source \"s\")." },
      { re: "\\.whenMatchedUpdateAll\\(\\)", msg: "Add .whenMatchedUpdateAll()." },
      { re: "\\.whenNotMatchedInsertAll\\(\\)", msg: "Add .whenNotMatchedInsertAll()." },
      { re: "\\.execute\\(\\)", msg: "Finish the merge builder with .execute()." },
      { re: "\\.foreachBatch\\(\\s*upsert\\s*\\)", msg: "Pass the function to .foreachBatch(upsert)." },
      { re: "[\"']checkpointLocation[\"']", msg: "Set the checkpointLocation option." },
      { re: "trigger\\(\\s*availableNow\\s*=\\s*True\\s*\\)", msg: "Use .trigger(availableNow=True)." }
    ],
    hints: ["Inside upsert, batch_df is an ordinary DataFrame, so window functions work.", "DeltaTable.forName(spark, name).alias(\"t\").merge(source.alias(\"s\"), condition) returns a builder; add the when... clauses and .execute().", "MERGE on a key is idempotent, which matters because a micro-batch can be replayed after a failure."]
  },
  {
    id: "pro-pat-autocdc", kind: "pattern", domain: "pro-code", level: "Medium", lang: "sql",
    title: "AUTO CDC into an SCD Type 2 table",
    prompt: "In a Lakeflow Declarative Pipeline, create the streaming table <code>customers_history</code> and a flow that applies the change feed <code>customer_changes</code> to it as <strong>SCD Type 2</strong>: key <code>customer_id</code>, ordered by <code>seq</code>, treating rows with <code>op = 'DELETE'</code> as deletes, and storing all columns except <code>op</code> and <code>seq</code>.",
    starter: "CREATE OR REFRESH ____ customers_history;\n\nCREATE FLOW customers_history_cdc AS ____ INTO customers_history\nFROM ____(customer_changes)\nKEYS (____)\nAPPLY AS DELETE WHEN ____\nSEQUENCE BY ____\nCOLUMNS * EXCEPT (____)\nSTORED AS ____;",
    solution: "CREATE OR REFRESH STREAMING TABLE customers_history;\n\nCREATE FLOW customers_history_cdc AS AUTO CDC INTO customers_history\nFROM STREAM(customer_changes)\nKEYS (customer_id)\nAPPLY AS DELETE WHEN op = 'DELETE'\nSEQUENCE BY seq\nCOLUMNS * EXCEPT (op, seq)\nSTORED AS SCD TYPE 2;",
    checks: [
      { re: "CREATE\\s+OR\\s+REFRESH\\s+STREAMING\\s+TABLE\\s+customers_history", msg: "The target of AUTO CDC is a streaming table: CREATE OR REFRESH STREAMING TABLE customers_history." },
      { re: "(AUTO\\s+CDC|APPLY\\s+CHANGES)\\s+INTO\\s+(LIVE\\.)?customers_history", msg: "Use AUTO CDC INTO customers_history (APPLY CHANGES INTO is the older name)." },
      { re: "FROM\\s+STREAM\\s*\\(\\s*(LIVE\\.)?customer_changes\\s*\\)", msg: "Read the source as a stream: FROM STREAM(customer_changes)." },
      { re: "KEYS\\s*\\(\\s*customer_id\\s*\\)", msg: "The key is KEYS (customer_id)." },
      { re: "APPLY\\s+AS\\s+DELETE\\s+WHEN\\s+op\\s*=\\s*'DELETE'", msg: "Mark deletes with APPLY AS DELETE WHEN op = 'DELETE'." },
      { re: "SEQUENCE\\s+BY\\s+seq\\b", msg: "Order changes with SEQUENCE BY seq." },
      { re: "COLUMNS\\s+\\*\\s+EXCEPT\\s*\\(\\s*(op\\s*,\\s*seq|seq\\s*,\\s*op)\\s*\\)", msg: "Leave out the CDC metadata: COLUMNS * EXCEPT (op, seq)." },
      { re: "STORED\\s+AS\\s+SCD\\s+TYPE\\s+2", msg: "Keep history with STORED AS SCD TYPE 2." }
    ],
    hints: ["AUTO CDC writes into a streaming table you declare first.", "SEQUENCE BY handles out-of-order events: an older change can't overwrite a newer one.", "SCD Type 2 adds __START_AT and __END_AT columns to the target."]
  },
  {
    id: "pro-pat-rowfilter", kind: "pattern", domain: "pro-security", level: "Medium", lang: "sql",
    title: "Row filter and column mask",
    prompt: "Protect two Unity Catalog tables. (1) Create <code>main.gov.region_filter(region STRING)</code> that returns true for members of the account group <code>admins</code>, or when <code>region = 'EU'</code>, and apply it as a <strong>row filter</strong> on <code>main.sales.orders</code> using its <code>region</code> column. (2) Create <code>main.gov.mask_email(email STRING)</code> that returns the email for members of <code>pii_readers</code> and <code>'***'</code> for everyone else, and set it as the <strong>mask</strong> on <code>main.sales.customers.email</code>.",
    starter: "CREATE OR REPLACE FUNCTION main.gov.region_filter(region STRING)\nRETURN ____;\n\nALTER TABLE main.sales.orders ____;\n\nCREATE OR REPLACE FUNCTION main.gov.mask_email(email STRING)\nRETURN ____;\n\nALTER TABLE main.sales.customers ____;",
    solution: "CREATE OR REPLACE FUNCTION main.gov.region_filter(region STRING)\nRETURN is_account_group_member('admins') OR region = 'EU';\n\nALTER TABLE main.sales.orders SET ROW FILTER main.gov.region_filter ON (region);\n\nCREATE OR REPLACE FUNCTION main.gov.mask_email(email STRING)\nRETURN CASE WHEN is_account_group_member('pii_readers') THEN email ELSE '***' END;\n\nALTER TABLE main.sales.customers ALTER COLUMN email SET MASK main.gov.mask_email;",
    checks: [
      { re: "region_filter\\s*\\(\\s*region\\s+STRING\\s*\\)\\s*RETURN[\\s\\S]*is_account_group_member\\s*\\(\\s*'admins'\\s*\\)[\\s\\S]*;", msg: "region_filter should check is_account_group_member('admins')." },
      { re: "RETURN[^;]*region\\s*=\\s*'EU'", msg: "region_filter should also return true when region = 'EU'." },
      { re: "RETURN[^;]*'admins'\\s*\\)\\s*OR\\s+region|RETURN\\s+region\\s*=\\s*'EU'\\s+OR\\s+is_account_group_member", msg: "Combine the two conditions with OR." },
      { re: "ALTER\\s+TABLE\\s+main\\.sales\\.orders\\s+SET\\s+ROW\\s+FILTER\\s+main\\.gov\\.region_filter\\s+ON\\s*\\(\\s*region\\s*\\)", msg: "Apply it: ALTER TABLE main.sales.orders SET ROW FILTER main.gov.region_filter ON (region)." },
      { re: "mask_email\\s*\\(\\s*email\\s+STRING\\s*\\)\\s*RETURN\\s+CASE\\s+WHEN\\s+is_account_group_member\\s*\\(\\s*'pii_readers'\\s*\\)\\s+THEN\\s+email\\s+ELSE\\s+'\\*\\*\\*'\\s+END", msg: "mask_email: CASE WHEN is_account_group_member('pii_readers') THEN email ELSE '***' END." },
      { re: "ALTER\\s+TABLE\\s+main\\.sales\\.customers\\s+ALTER\\s+COLUMN\\s+email\\s+SET\\s+MASK\\s+main\\.gov\\.mask_email", msg: "Attach it: ALTER TABLE main.sales.customers ALTER COLUMN email SET MASK main.gov.mask_email." },
      { re: "\\bis_member\\s*\\(", msg: "Use is_account_group_member(). is_member() checks legacy workspace-local groups.", absent: true }
    ],
    hints: ["A row filter function returns a BOOLEAN for each row. A mask function returns the value to show.", "SET ROW FILTER fn ON (column) passes the listed columns to the function as arguments.", "Masks are set per column with ALTER COLUMN ... SET MASK."]
  },
  {
    id: "pro-pat-bundle", kind: "pattern", domain: "pro-deploy", level: "Medium", lang: "yaml",
    title: "Bundle targets for dev and prod",
    prompt: "Finish this <code>databricks.yml</code>. Pass the <code>catalog</code> variable to the notebook as the <code>catalog</code> parameter. Add a <code>dev</code> target that is the <strong>default</strong> and deploys in <strong>development mode</strong>. Add a <code>prod</code> target in <strong>production mode</strong> that sets the catalog variable to <code>prod</code> and runs as the service principal <code>orders-sp</code>.",
    starter: "bundle:\n  name: orders_pipeline\n\nvariables:\n  catalog:\n    description: Catalog the job writes to\n    default: dev\n\nresources:\n  jobs:\n    orders_job:\n      name: orders_job\n      tasks:\n        - task_key: ingest\n          notebook_task:\n            notebook_path: ./src/ingest.ipynb\n            base_parameters:\n              catalog: ____\n\ntargets:\n  dev:\n    ____\n  prod:\n    ____\n",
    solution: "bundle:\n  name: orders_pipeline\n\nvariables:\n  catalog:\n    description: Catalog the job writes to\n    default: dev\n\nresources:\n  jobs:\n    orders_job:\n      name: orders_job\n      tasks:\n        - task_key: ingest\n          notebook_task:\n            notebook_path: ./src/ingest.ipynb\n            base_parameters:\n              catalog: ${var.catalog}\n\ntargets:\n  dev:\n    mode: development\n    default: true\n  prod:\n    mode: production\n    variables:\n      catalog: prod\n    run_as:\n      service_principal_name: orders-sp\n",
    checks: [
      { re: "catalog:\\s*[\"']?\\$\\{var\\.catalog\\}", msg: "Reference the variable as ${var.catalog}." },
      { re: "^\\s+dev:\\s*$[\\s\\S]*?mode:\\s*development[\\s\\S]*^\\s+prod:\\s*$", msg: "Under dev, set mode: development." },
      { re: "^\\s+dev:\\s*$[\\s\\S]*?default:\\s*true[\\s\\S]*^\\s+prod:\\s*$", msg: "Make dev the default target with default: true." },
      { re: "^\\s+prod:\\s*$[\\s\\S]*mode:\\s*production", msg: "Under prod, set mode: production." },
      { re: "^\\s+prod:\\s*$[\\s\\S]*variables:\\s*\\n\\s+catalog:\\s*[\"']?prod[\"']?\\s*$", msg: "Override the variable in prod: variables: then catalog: prod." },
      { re: "^\\s+prod:\\s*$[\\s\\S]*run_as:\\s*\\n\\s+service_principal_name:\\s*[\"']?orders-sp[\"']?\\s*$", msg: "Run prod as the service principal: run_as: then service_principal_name: orders-sp." }
    ],
    hints: ["Bundle variables are referenced as ${var.name}.", "A target can override variables with its own variables: block.", "Production deployments should run as a service principal, set with run_as."]
  },

  {
    id: "pro-pat-variant", kind: "pattern", domain: "pro-manip", level: "Medium", lang: "sql",
    title: "VARIANT payloads and AI enrichment",
    prompt: "<code>bronze.tickets_raw</code> has a STRING column <code>raw</code> with JSON of varying shape. (1) Create <code>silver.tickets_v</code> with a VARIANT column <code>payload</code>, using the function that returns <strong>NULL for invalid JSON</strong> instead of failing. (2) Query it: return <code>payload:ticket.id</code> as an INT named <code>ticket_id</code>, the string at <code>$.customer.tier</code> using <code>variant_get</code> as <code>tier</code>, and a <code>category</code> from <code>ai_classify</code> on <code>payload:body::STRING</code> with the labels <code>'billing'</code>, <code>'bug'</code> and <code>'other'</code>.",
    starter: "CREATE TABLE silver.tickets_v AS\nSELECT ____ AS payload FROM bronze.tickets_raw;\n\nSELECT ____ AS ticket_id,\n       ____ AS tier,\n       ____ AS category\nFROM silver.tickets_v;",
    solution: "CREATE TABLE silver.tickets_v AS\nSELECT try_parse_json(raw) AS payload FROM bronze.tickets_raw;\n\nSELECT payload:ticket.id::INT AS ticket_id,\n       variant_get(payload, '$.customer.tier', 'STRING') AS tier,\n       ai_classify(payload:body::STRING, ARRAY('billing', 'bug', 'other')) AS category\nFROM silver.tickets_v;",
    checks: [
      { re: "try_parse_json\\s*\\(\\s*raw\\s*\\)\\s+AS\\s+payload", msg: "Convert with try_parse_json(raw) AS payload. parse_json would fail the whole query on one bad record." },
      { re: "payload:ticket\\.id\\s*::\\s*INT\\s+AS\\s+ticket_id", msg: "Read the id with colon-path syntax and a cast: payload:ticket.id::INT AS ticket_id." },
      { re: "variant_get\\s*\\(\\s*payload\\s*,\\s*'\\$\\.customer\\.tier'\\s*,\\s*'STRING'\\s*\\)\\s+AS\\s+tier", msg: "Use variant_get(payload, '$.customer.tier', 'STRING') AS tier." },
      { re: "ai_classify\\s*\\(\\s*payload:body\\s*::\\s*STRING\\s*,\\s*ARRAY\\s*\\(\\s*'billing'\\s*,\\s*'bug'\\s*,\\s*'other'\\s*\\)\\s*\\)\\s+AS\\s+category", msg: "Classify with ai_classify(payload:body::STRING, ARRAY('billing', 'bug', 'other')) AS category." },
      { re: "(^|[^_])parse_json\\s*\\(", msg: "Use try_parse_json, not parse_json, so invalid JSON becomes NULL.", absent: true }
    ],
    hints: ["try_parse_json returns NULL for invalid input; parse_json raises an error.", "Colon paths navigate VARIANT values: payload:ticket.id, then cast with ::INT.", "variant_get takes the column, a JSON path starting with $, and the target type as a string."]
  },

  // ---------------------------------------------------------------- case studies
  {
    id: "pro-case-merge", kind: "scenario", domain: "pro-perf", level: "Hard",
    title: "Case study: a nightly MERGE that got slow",
    brief: "<p>A nightly job MERGEs about 5 million changed rows into <code>silver.transactions</code> (6 TB, partitioned by <code>txn_date</code>, about 2,000 partitions with many small files). The MERGE key is <code>txn_id</code>, and changes can touch any date in the last 90 days. Runtime grew from 40 minutes to 3.5 hours. In the Spark UI, one stage has 199 tasks finishing in about 30 seconds and one task running for over 2 hours.</p>",
    steps: [
      { q: "What does the Spark UI tell you first?",
        options: [
          { text: "Data skew: one partition of the shuffle holds far more data than the others, typically a hot or NULL join key", score: 2, feedback: "Right. Max task time far above the median in one stage is the signature of skew." },
          { text: "The cluster is too small, so add more workers", score: 0, feedback: "199 tasks finish in seconds. More workers won't speed up the single long task." },
          { text: "Spill to disk across all tasks, so use memory-optimized nodes", score: 0, feedback: "Spill would show across many tasks. Here only one task is slow." }
        ] },
      { q: "You find that 30% of source rows have a NULL txn_id (they are invalid). What do you do?",
        options: [
          { text: "Filter or quarantine NULL-key rows before the MERGE. They can never match a target row, and they all land in one shuffle partition", score: 2, feedback: "Right. NULL keys never match on equality, yet they skew the shuffle. Remove or quarantine them first." },
          { text: "Raise spark.sql.shuffle.partitions to 2,000", score: 0, feedback: "All NULL keys still hash to the same partition, so the skewed task stays." },
          { text: "Salt the txn_id column with a random number", score: 1, feedback: "Salting spreads the rows, but these rows are invalid and shouldn't be merged at all." }
        ] },
      { q: "The MERGE still scans most of the table. How should the table be laid out?",
        options: [
          { text: "Replace date partitioning with liquid clustering on txn_id and txn_date, and add a date-range predicate on the target in the MERGE condition", score: 2, feedback: "Right. Clustering lets data skipping prune files by key and date, the extra predicate narrows the scan, and you get rid of the many small partitions." },
          { text: "Add more partition columns: txn_date and txn_id", score: 0, feedback: "Partitioning by a high-cardinality key creates millions of tiny files. That's the worst option." },
          { text: "Z-order by txn_id every night", score: 1, feedback: "It helps skipping, but Z-order rewrites the whole table each time and can't be combined with liquid clustering's incremental behaviour." }
        ] },
      { q: "Each MERGE rewrites many large files even though few rows change in each. What helps most?",
        options: [
          { text: "Enable deletion vectors so updated rows are marked instead of rewriting whole files, and let OPTIMIZE / predictive optimization compact later", score: 2, feedback: "Right. Deletion vectors make MERGE/UPDATE/DELETE write much less, and maintenance cleans up asynchronously." },
          { text: "Run VACUUM before each MERGE", score: 0, feedback: "VACUUM deletes old unreferenced files. It doesn't change how much MERGE rewrites." },
          { text: "Convert the table to Parquet", score: 0, feedback: "Plain Parquet doesn't support MERGE or ACID transactions." }
        ] },
      { q: "Another job now writes to the same table at the same time and fails with ConcurrentAppendException. What's the best fix?",
        options: [
          { text: "Use row-level concurrency (liquid clustering + deletion vectors), and make each job's MERGE condition include explicit, disjoint predicates", score: 2, feedback: "Right. Row-level concurrency avoids file-level conflicts when writers touch different rows." },
          { text: "Retry the job until it succeeds", score: 0, feedback: "Retries hide the problem and waste compute. The conflict will keep happening." },
          { text: "Write the second job's output to a separate table and union them in a view", score: 1, feedback: "It avoids conflicts, but splits the data and complicates every consumer." }
        ] }
    ]
  },
  {
    id: "pro-case-stream", kind: "scenario", domain: "pro-code", level: "Hard",
    title: "Case study: a streaming pipeline that keeps breaking",
    brief: "<p>An IoT team ingests JSON telemetry from cloud storage with Auto Loader into bronze, then aggregates readings per device in 5-minute windows into silver with Structured Streaming. Over one month the pipeline failed four times, and the cluster's memory use keeps growing.</p>",
    steps: [
      { q: "Failure 1: firmware added a new field, battery_pct, and the stream stopped with UnknownFieldException. Data must not be lost, and new columns should flow through. What do you configure?",
        options: [
          { text: "Keep cloudFiles.schemaEvolutionMode = addNewColumns with a schemaLocation, and run the stream as a job with retries so it restarts with the new schema", score: 2, feedback: "Right. Failing once and restarting with the evolved schema is how addNewColumns works by design." },
          { text: "Switch to schemaEvolutionMode = none", score: 0, feedback: "With none, new columns are silently ignored. The new field would be lost." },
          { text: "Use rescue mode", score: 1, feedback: "No data is lost (it lands in _rescued_data), but the new column never becomes a real column, which was the requirement." }
        ] },
      { q: "Failure 2: a GDPR request deleted rows from bronze, and the silver stream that reads bronze failed. What's the right fix?",
        options: [
          { text: "Set skipChangeCommits on the bronze stream read (and handle the delete in silver separately), or read bronze's Change Data Feed to propagate deletes", score: 2, feedback: "Right. Delta streaming sources expect appends. Skip change commits, or consume the CDF if downstream must reflect the delete." },
          { text: "Delete the checkpoint and restart", score: 0, feedback: "That reprocesses all of bronze from the start and creates duplicates in silver." },
          { text: "Never delete from bronze", score: 0, feedback: "The legal obligation to delete still applies to bronze." }
        ] },
      { q: "The growing memory comes from the windowed aggregation. What do you add?",
        options: [
          { text: "withWatermark on the event-time column (for example 15 minutes) before the aggregation, plus the RocksDB state store", score: 2, feedback: "Right. The watermark lets Spark drop state for closed windows, and RocksDB keeps large state off the JVM heap." },
          { text: "A bigger driver", score: 0, feedback: "State grows without limit, so a bigger machine only delays the failure." },
          { text: "Switch to output mode complete", score: 0, feedback: "Complete mode keeps and rewrites all results every batch, which makes it worse." }
        ] },
      { q: "Failure 3: a developer changed the grouping from device_id to (device_id, site_id), and the restarted stream failed. How do you deploy the change?",
        options: [
          { text: "Use a new checkpoint location (and a new or truncated target), then backfill the history the new logic needs", score: 2, feedback: "Right. Changing grouping keys is incompatible with the stored state, so the query needs a fresh checkpoint." },
          { text: "Edit the state files in the checkpoint", score: 0, feedback: "Checkpoint internals aren't meant to be edited by hand, and the state schema still wouldn't match." },
          { text: "Set spark.sql.streaming.stateStore.compatibility to false", score: 0, feedback: "That setting doesn't exist. Incompatible state changes need a new checkpoint." }
        ] },
      { q: "The business needs results every 15 minutes, but the cluster runs 24/7 for this stream. How do you cut cost?",
        options: [
          { text: "Run the same query with trigger(availableNow=True) as a job every 15 minutes on job or serverless compute", score: 2, feedback: "Right. Same code and checkpoint, incremental processing, and no idle cluster between runs." },
          { text: "Use trigger(processingTime='15 minutes') on the same always-on cluster", score: 1, feedback: "Fewer batches, but you still pay for the cluster all day." },
          { text: "Rewrite it as a nightly batch job that reprocesses the last 24 hours", score: 0, feedback: "That misses the 15-minute requirement and reprocesses data unnecessarily." }
        ] }
    ]
  },
  {
    id: "pro-case-gdpr", kind: "scenario", domain: "pro-security", level: "Medium",
    title: "Case study: right to be forgotten",
    brief: "<p>A retailer receives a deletion request from a customer under GDPR and must complete it within 30 days. The customer's data is in bronze (raw JSON loaded to Delta), silver customer and order tables, gold aggregates and an ML feature table. Tables keep the default 7-day file retention, deletion vectors are enabled, and silver has Change Data Feed on.</p>",
    steps: [
      { q: "How do you remove the customer from all layers?",
        options: [
          { text: "Delete from bronze and silver, and let downstream tables pick up the deletes through the Change Data Feed / pipeline logic", score: 2, feedback: "Right. Deletes propagate through the same incremental path as other changes, so no layer is forgotten." },
          { text: "Delete only from gold, since that's what users query", score: 0, feedback: "The data would still be in bronze and silver, and would come back on the next rebuild." },
          { text: "Rebuild every table from the source systems", score: 1, feedback: "It works if the sources are clean, but it's expensive. It also fails if bronze is your only copy of historic data." }
        ] },
      { q: "After the DELETE, an auditor can still see the customer with VERSION AS OF. What else is needed?",
        options: [
          { text: "Run REORG TABLE ... APPLY (PURGE) to rewrite files with deletion vectors, then VACUUM after the retention period to remove old files", score: 2, feedback: "Right. Deletion vectors only mark rows, PURGE rewrites the files, and VACUUM physically deletes the old ones." },
          { text: "Nothing: DELETE removes the data physically", score: 0, feedback: "Delta keeps old files for time travel until VACUUM removes them." },
          { text: "Set delta.logRetentionDuration to 0", score: 0, feedback: "Log retention affects history metadata, not the data files that still hold the rows." }
        ] },
      { q: "Streaming jobs that read the bronze table start failing after the deletes. Why, and what do you do?",
        options: [
          { text: "Delta streaming sources fail on commits that change existing rows. Use skipChangeCommits, or have them read the CDF", score: 2, feedback: "Right. That's expected behaviour for a stream reading a table that has a DELETE." },
          { text: "The checkpoint is corrupt; delete it", score: 0, feedback: "The checkpoint is fine, and deleting it would cause a full reprocess." },
          { text: "Increase the cluster size", score: 0, feedback: "This is a semantic failure, not a resource problem." }
        ] },
      { q: "How can you make future deletion requests cheaper?",
        options: [
          { text: "Pseudonymize: keep direct identifiers in one restricted lookup table keyed by a random token, and use the token everywhere else", score: 2, feedback: "Right. Deleting the lookup row breaks the link to the person, and the rest of the data no longer identifies them." },
          { text: "Replace emails with an unsalted SHA-256 hash in every table", score: 0, feedback: "An unsalted hash of a known email can be recomputed, so it's still personal data." },
          { text: "Shorten retention to 0 days on every table", score: 0, feedback: "It breaks time travel and can break running streams and long queries." }
        ] },
      { q: "How do you prove to the auditor that the deletion happened?",
        options: [
          { text: "Show DESCRIBE HISTORY for each table and the DELETE/VACUUM events in system.access.audit, plus a query showing no rows remain", score: 2, feedback: "Right. The Delta history and the audit system table provide a verifiable record." },
          { text: "Screenshot the notebook that ran the deletes", score: 0, feedback: "That isn't a reliable or complete record." },
          { text: "Rely on the data team's ticket being closed", score: 0, feedback: "A ticket isn't evidence that the data was deleted." }
        ] }
    ]
  },
  {
    id: "pro-case-sharing", kind: "scenario", domain: "pro-ingest", level: "Medium",
    title: "Case study: sharing data with partners",
    brief: "<p>A logistics company on Azure Databricks wants to share shipment data. Partner A runs Databricks on AWS. Partner B has no Databricks and works in Python. Each partner may only see their own shipments. The company also wants analysts to use a small, frequently updated carrier-rates table that lives in an Azure SQL database, without building a pipeline.</p>",
    steps: [
      { q: "How do you share live shipment data with Partner A?",
        options: [
          { text: "Databricks-to-Databricks Delta Sharing: create a share and a recipient from Partner A's sharing identifier", score: 2, feedback: "Right. Live data, no copies, works across clouds, and Partner A governs it in its own Unity Catalog." },
          { text: "Nightly CSV exports to a storage container Partner A can read", score: 0, feedback: "Copies go stale, need maintenance and lose governance." },
          { text: "Create user accounts for Partner A's engineers in your workspace", score: 0, feedback: "That gives outsiders access to your workspace instead of sharing only the data." }
        ] },
      { q: "How does Partner B get access?",
        options: [
          { text: "Open sharing: create a recipient with token (or OIDC) authentication and send the activation link; they read with the delta-sharing Python connector", score: 2, feedback: "Right. Open sharing works with any client that supports the protocol." },
          { text: "Give Partner B a personal access token for your workspace", score: 0, feedback: "A PAT gives workspace access and is tied to a user. That's not how external sharing should work." },
          { text: "Ask Partner B to buy Databricks", score: 0, feedback: "That isn't necessary. Open sharing exists for exactly this case." }
        ] },
      { q: "How do you make each partner see only their own shipments?",
        options: [
          { text: "Share a view that filters on CURRENT_RECIPIENT('partner_id'), with a partner_id property set on each recipient (or a separate share per partner with partition filters)", score: 2, feedback: "Right. Recipient properties let one view return different rows to each recipient." },
          { text: "Share the full table and ask partners to filter", score: 0, feedback: "That exposes every partner's data." },
          { text: "Apply a row filter using is_account_group_member()", score: 0, feedback: "Recipients aren't members of your account groups, so this doesn't identify them." }
        ] },
      { q: "Partner A reads a lot, from another cloud. What cost do you watch for?",
        options: [
          { text: "Cloud egress charges on the provider side, and consider replicating the shared tables to Partner A's region if volumes are large", score: 2, feedback: "Right. Delta Sharing reads data from the provider's storage, so cross-cloud reads incur egress." },
          { text: "DBU charges for Partner A's queries on your workspace", score: 0, feedback: "Recipients use their own compute. Your cost is storage and egress." },
          { text: "There are no costs because no data is copied", score: 0, feedback: "Data still travels from your storage to the recipient, which creates egress costs." }
        ] },
      { q: "How do analysts use the Azure SQL carrier-rates table?",
        options: [
          { text: "Lakehouse Federation: create a connection and a foreign catalog, grant SELECT to the analysts' group", score: 2, feedback: "Right. Small, live reference data with no pipeline, governed by Unity Catalog." },
          { text: "Copy the table hourly with a custom JDBC notebook", score: 1, feedback: "It works, but it's a pipeline to maintain and the data is up to an hour old." },
          { text: "Give analysts the database password in a notebook", score: 0, feedback: "That bypasses governance and exposes credentials." }
        ] }
    ]
  },
  {
    id: "pro-case-cicd", kind: "scenario", domain: "pro-deploy", level: "Medium",
    title: "Case study: from notebooks to a production release process",
    brief: "<p>A data team runs 30 production jobs from notebooks in their personal workspace folders. Jobs run as the engineer who created them, and changes are made directly in production. Last month a job broke after a quick fix and nobody noticed for two days. You're asked to set up a proper process across dev, staging and prod workspaces.</p>",
    steps: [
      { q: "How should jobs and pipelines be defined and deployed?",
        options: [
          { text: "Declarative Automation Bundles in Git, with dev/staging/prod targets and variables, deployed with databricks bundle deploy", score: 2, feedback: "Right. One versioned definition, deployed consistently to each environment." },
          { text: "Export job JSON from the UI and import it into each workspace by hand", score: 0, feedback: "Manual and error-prone, and the code itself isn't versioned with the job definition." },
          { text: "Keep editing in production but take daily workspace backups", score: 0, feedback: "Backups don't prevent broken changes from reaching production." }
        ] },
      { q: "Which identity should production jobs run as?",
        options: [
          { text: "A service principal, set with run_as in the prod target, with only the grants the jobs need", score: 2, feedback: "Right. Jobs don't break when people leave, and permissions are explicit and minimal." },
          { text: "The team lead's user account", score: 0, feedback: "Jobs fail when that person leaves, and they run with all of that person's permissions." },
          { text: "A shared 'etl_user' with a password in a notebook", score: 0, feedback: "Shared credentials are insecure and unauditable." }
        ] },
      { q: "How do you stop untested changes from reaching production?",
        options: [
          { text: "Pull requests run unit tests (pytest on transformation functions) and bundle validate; merging deploys to staging for integration tests, then to prod from CI", score: 2, feedback: "Right. Automated gates at each stage catch problems before production." },
          { text: "Ask engineers to test carefully in their own notebooks", score: 0, feedback: "Manual testing isn't repeatable, and nothing enforces it." },
          { text: "Deploy to prod and roll back if something breaks", score: 0, feedback: "That makes production the test environment." }
        ] },
      { q: "How does the team find out about failures quickly?",
        options: [
          { text: "Job failure notifications and duration health rules to the on-call channel, plus SQL alerts on system.lakeflow job run tables and data freshness", score: 2, feedback: "Right. Failures and slow runs alert immediately, and freshness checks catch silent problems." },
          { text: "Check the jobs page every morning", score: 0, feedback: "That's how a failure went unnoticed for two days." },
          { text: "Add print statements to every notebook", score: 0, feedback: "Nobody reads logs unless something tells them to look." }
        ] },
      { q: "Task 5 of an 8-task job failed after tasks 1–4 ran for 2 hours. The fix is deployed. How do you finish the run?",
        options: [
          { text: "Repair the run: only task 5 and the tasks that depend on it run again", score: 2, feedback: "Right. Repair run skips the tasks that already succeeded." },
          { text: "Start a new run of the whole job", score: 1, feedback: "It works, but repeats 2 hours of successful work and its cost." },
          { text: "Run task 5's notebook by hand and mark the job as done", score: 0, feedback: "Downstream tasks wouldn't run, and the run history wouldn't reflect what happened." }
        ] }
    ]
  }
);
