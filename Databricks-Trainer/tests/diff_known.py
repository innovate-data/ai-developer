"""Known, accepted differences between the trainer and real PySpark."""

# Differences that are known and accepted, with the reason. A case listed here may differ from real Spark.
KNOWN = {
    "lit-types": "NULL literals report int, Spark reports void",
    "array-literal": "empty array literal element type",
    "fn-lit-types": "NULL literals report int, Spark reports void",
    "fn-concat-null": "NULL literal typed as int by DuckDB",
    "window-no-partition": "auto-generated column name omits the default frame",
    "window-range": "auto-generated column name omits the frame",
    "array-distinct-sort": "auto-generated names of lambda-based functions",
    "array-join": "auto-generated name of a nested cast",
    "transform-filter": "auto-generated names of higher-order functions",
    "aggregate-fn": "auto-generated names of higher-order functions",
    "sql-pivot": "SQL PIVOT count: DuckDB gives 0 where Spark gives NULL",
    "sql-round-div": "DIV returns int, Spark returns bigint",
    "fn-div-mod": "DIV returns int, Spark returns bigint",
    "sql-show-tables": "sample tables are catalog tables here, temp views in the test harness",
    "describe": "stddev differs in the last digit",
    "summary-like": "stddev differs in the last digit",
    "count-star-name": "duplicate auto-generated names are de-duplicated by DuckDB",
    "fn-math": "bround(2.5) literal typed decimal by Spark",
    "fn-agg": "collect_set order is unspecified",
    "from-json": "JSON functions are not available in the browser trainer",
}
