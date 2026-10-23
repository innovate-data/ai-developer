"""Checks the PySpark-compatible layer and every PySpark exercise against DuckDB in CPython.

    pip install duckdb==1.1.1 pytest
    pytest tests/

Node.js is used to load the exercise content from js/*.js. The browser runs the same shim on
DuckDB-WASM, which returns values in the same JSON shape that query_json() produces here.
"""
import contextlib
import datetime
import decimal
import io
import json
import pathlib
import subprocess
import sys

import duckdb
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
import pyspark_shim as shim  # noqa: E402

CONTENT = json.loads(subprocess.check_output(["node", "-e", """
globalThis.window = globalThis;
for (const f of ["lessons", "quiz", "exercises", "pyspark"]) require(process.argv[1] + "/js/content-" + f + ".js");
process.stdout.write(JSON.stringify({ exercises: TRAINER.exercises, sql: TRAINER.datasetSql }));
""", str(ROOT)]))

con = duckdb.connect()


def _kind_of(values, code):
    for v in values:
        if v is None: continue
        if isinstance(v, bool): return "bool"
        if isinstance(v, int): return "int"
        if isinstance(v, float): return "float"
        if isinstance(v, decimal.Decimal): return "int" if v == int(v) and v.as_tuple().exponent == 0 else "float"
        if isinstance(v, str): return "string"
        if isinstance(v, datetime.datetime): return "timestamp"
        if isinstance(v, datetime.date): return "date"
        if isinstance(v, list): return "list"
        if isinstance(v, dict): return "struct"
    return {"Date": "date", "DATETIME": "timestamp", "STRING": "string", "bool": "bool", "list": "list", "dict": "struct"}.get(str(code), "other")


def _conv(v):
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return int(v) if v == int(v) else float(v)
    if isinstance(v, list):
        return [_conv(x) for x in v]
    if isinstance(v, dict):
        return {k: _conv(x) for k, x in v.items()}
    return v


def query_json(sql):
    r = con.execute(sql)
    if not r.description:
        return json.dumps({"columns": [], "kinds": [], "rows": []})
    raw = r.fetchall()
    kinds = [_kind_of([row[i] for row in raw], r.description[i][1]) for i in range(len(r.description))]
    return json.dumps({"columns": [d[0] for d in r.description], "kinds": kinds,
                       "rows": [[_conv(v) for v in row] for row in raw]})


shim.setup(query_json)


def reset():
    for (v,) in con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall():
        con.execute(f'DROP VIEW "{v}"')
    for (t,) in con.execute("SELECT table_name FROM duckdb_tables() WHERE NOT internal").fetchall():
        con.execute(f'DROP TABLE "{t}"')
    for stmt in CONTENT["sql"]:
        con.execute(stmt)


def run(code):
    reset()
    ns = shim.new_namespace()
    with contextlib.redirect_stdout(io.StringIO()):
        err = shim.run_cell(code, ns)
    assert err is None, err
    return json.loads(shim.result_json(ns))


PY_EXERCISES = [x for x in CONTENT["exercises"] if x["kind"] == "python"]


@pytest.mark.parametrize("ex", PY_EXERCISES, ids=[x["id"] for x in PY_EXERCISES])
def test_solution_runs_and_starter_differs(ex):
    sol = run(ex["solution"])
    assert "error" not in sol and sol["rows"], sol
    reset()
    ns = shim.new_namespace()
    with contextlib.redirect_stdout(io.StringIO()):
        shim.run_cell(ex["starter"], ns)
    st = json.loads(shim.result_json(ns))
    if "error" not in st:
        same = (st["columns"] == sol["columns"] and
                (st["rows"] == sol["rows"] if ex.get("ordered") else sorted(map(json.dumps, st["rows"])) == sorted(map(json.dumps, sol["rows"]))))
        assert not same, "starter already produces the expected result"


def rows(code):
    return run(code + "\n")["rows"]


def test_join_keys_and_null_ordering():
    assert rows('result = spark.table("orders").join(spark.table("customers"), "customer_id").limit(1)')[0][0] == "1"
    r = rows('from pyspark.sql import functions as F\n'
             'result = spark.table("customers").select("country").distinct().orderBy("country")')
    assert r[0] == [None]  # Spark sorts NULLs first ascending


def test_pivot_count_missing_is_null():
    r = rows('result = spark.table("orders").groupBy("status").pivot("customer_id", [1]).count().orderBy("status")')
    assert r == [["CANCELLED", None], ["COMPLETED", "3"], ["PENDING", None]]


def test_errors_are_spark_like():
    reset()
    err = shim.run_cell('spark.table("orders").select("nope")', shim.new_namespace())
    assert "UNRESOLVED_COLUMN" in err
    err = shim.run_cell('o = spark.table("orders")\no.filter(o.status == "A" and o.order_id > 1)', shim.new_namespace())
    assert "Cannot convert column into bool" in err
