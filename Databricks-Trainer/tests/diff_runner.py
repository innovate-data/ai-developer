"""Runs every case in diff_cases.py on real PySpark and on the trainer's PySpark-compatible layer.

Prints one JSON object {case name: [status, message]}. test_matches_real_pyspark.py runs this in a subprocess,
because the shim registers its own `pyspark` modules and the two can't share a process without being swapped
in and out (done below with use()).
"""
import contextlib, datetime, decimal, io, json, os, pathlib, re, subprocess, sys
os.environ["TZ"] = "UTC"
import duckdb
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
# Real PySpark must be imported before the shim, which registers its own pyspark modules in sys.modules.
import pyspark, pyspark.sql, pyspark.sql.functions, pyspark.sql.window, pyspark.sql.types, pyspark.errors
from pyspark.sql import SparkSession, Row
from pyspark.sql import types as T
NAMES = ["pyspark", "pyspark.sql", "pyspark.sql.functions", "pyspark.sql.window", "pyspark.sql.types", "pyspark.sql.utils", "pyspark.errors"]
import pyspark.sql.utils
REAL_MODS = {n: sys.modules[n] for n in NAMES}
import pyspark_shim as shim
SHIM_MODS = {n: sys.modules[n] for n in NAMES}
@contextlib.contextmanager
def use(mods):
    saved = {n: sys.modules[n] for n in NAMES}
    sys.modules.update(mods)
    try: yield
    finally: sys.modules.update(saved)

content = json.loads(subprocess.check_output(["node", "-e", """
globalThis.window = globalThis;
for (const f of ["lessons", "quiz", "exercises", "pyspark", "architect", "quiz-extra"]) require(process.argv[1] + "/js/content-" + f + ".js");
process.stdout.write(JSON.stringify({ sql: TRAINER.datasetSql }));""", str(ROOT)]))

con = duckdb.connect()
def kind_of(values, code):
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
def conv(v):
    if isinstance(v, datetime.datetime): return v.isoformat(sep=" ")
    if isinstance(v, datetime.date): return v.isoformat()
    if isinstance(v, decimal.Decimal): return float(v) if v != int(v) else int(v)
    if isinstance(v, list): return [conv(x) for x in v]
    if isinstance(v, dict): return {k: conv(x) for k, x in v.items()}
    return v
def query_json(sql):
    r = con.execute(sql)
    if not r.description: return json.dumps({"columns": [], "kinds": [], "rows": []})
    raw = r.fetchall()
    kinds = [kind_of([row[i] for row in raw], r.description[i][1]) for i in range(len(r.description))]
    return json.dumps({"columns": [d[0] for d in r.description], "kinds": kinds, "rows": [[conv(v) for v in row] for row in raw]})
shim.setup(query_json)
def reset_duck():
    for (v,) in con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall(): con.execute(f'DROP VIEW "{v}"')
    for (t,) in con.execute("SELECT table_name FROM duckdb_tables() WHERE NOT internal").fetchall(): con.execute(f'DROP TABLE "{t}"')
    for stmt in content["sql"]: con.execute(stmt)
reset_duck()

# real Spark with the same tables
with use(REAL_MODS):
    spark = (SparkSession.builder.master("local[2]").config("spark.ui.enabled", "false").config("spark.sql.shuffle.partitions", "4")
             .config("spark.sql.session.timeZone", "UTC").config("spark.sql.ansi.enabled", "false").getOrCreate())
    spark.sparkContext.setLogLevel("ERROR")
SCHEMAS = {
 "customers": T.StructType([T.StructField("customer_id", T.IntegerType()), T.StructField("name", T.StringType()), T.StructField("email", T.StringType()), T.StructField("country", T.StringType()), T.StructField("signup_date", T.DateType())]),
 "products": T.StructType([T.StructField("product_id", T.IntegerType()), T.StructField("product_name", T.StringType()), T.StructField("category", T.StringType()), T.StructField("price", T.DoubleType())]),
 "orders": T.StructType([T.StructField("order_id", T.IntegerType()), T.StructField("customer_id", T.IntegerType()), T.StructField("order_date", T.DateType()), T.StructField("status", T.StringType())]),
 "order_items": T.StructType([T.StructField("order_id", T.IntegerType()), T.StructField("product_id", T.IntegerType()), T.StructField("quantity", T.IntegerType())]),
 "bronze_events": T.StructType([T.StructField("event_id", T.StringType()), T.StructField("customer_id", T.IntegerType()), T.StructField("event_type", T.StringType()), T.StructField("event_ts", T.TimestampType()), T.StructField("ingest_ts", T.TimestampType())]),
 "carts": T.StructType([T.StructField("cart_id", T.IntegerType()), T.StructField("customer_id", T.IntegerType()), T.StructField("items", T.ArrayType(T.IntegerType())), T.StructField("created_at", T.TimestampType())]),
}
with use(REAL_MODS):
    for name, schema in SCHEMAS.items():
        rows = con.execute(f'SELECT * FROM "{name}"').fetchall()
        spark.createDataFrame(rows, schema).createOrReplaceTempView(name)

def norm(v):
    if v is None: return None
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, int): return str(v)
    if isinstance(v, float):
        if v != v: return "NaN"
        r = round(v, 6); return str(int(r)) if r == int(r) else repr(r)
    if isinstance(v, decimal.Decimal): return norm(float(v))
    if isinstance(v, datetime.datetime): return v.isoformat(sep=" ")
    if isinstance(v, datetime.date): return v.isoformat()
    if isinstance(v, (list, tuple)): return json.dumps([norm(x) for x in v])
    if isinstance(v, dict): return json.dumps({str(k): norm(x) for k, x in v.items()})
    return str(v)

def run_real(code):
    ns = {"spark": spark, "__name__": "__main__"}
    try:
        with use(REAL_MODS):
            with contextlib.redirect_stdout(io.StringIO()):
                exec(compile(code, "<snippet>", "exec"), ns)
            df = ns["result"]
            rows = df.collect()
            return {"cols": df.columns, "dtypes": [d[1] for d in df.dtypes], "rows": [[norm(x) for x in r] for r in rows], "show": df._jdf.showString(20, 20, False) + "\n"}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e).splitlines()[0][:140] if str(e) else ''}"}

def run_shim(code):
    reset_duck()
    ns = shim.new_namespace(); buf = io.StringIO()
    with use(SHIM_MODS), contextlib.redirect_stdout(buf):
        err = shim.run_cell(code, ns)
    if err: return {"error": err.splitlines()[-1][:160]}
    df = ns.get("result")
    if df is None: return {"error": "no result"}
    try:
        rows = df.collect()
        with contextlib.redirect_stdout(buf):
            buf.truncate(0); buf.seek(0); df.show()
        return {"cols": df.columns, "dtypes": [d[1] for d in df.dtypes], "rows": [[norm(x) for x in r] for r in rows], "show": buf.getvalue()}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:140]}"}

def compare(name, code, ordered=False, show=False):
    r, s = run_real(code), run_shim(code)
    if "error" in r and "error" in s: return ("both-error", name, f"real: {r['error'][:70]} | shim: {s['error'][:70]}")
    if "error" in r: return ("shim-permissive", name, f"real errors: {r['error'][:110]}")
    if "error" in s: return ("SHIM-FAILS", name, f"shim: {s['error'][:130]}  (real ok)")
    diffs = []
    if [c.lower() for c in r["cols"]] != [c.lower() for c in s["cols"]]: diffs.append(f"cols real={r['cols']} shim={s['cols']}")
    if r["dtypes"] != s["dtypes"]: diffs.append(f"dtypes real={r['dtypes']} shim={s['dtypes']}")
    a, b = r["rows"], s["rows"]
    if not ordered: a, b = sorted(map(json.dumps, a)), sorted(map(json.dumps, b))
    else: a, b = list(map(json.dumps, a)), list(map(json.dumps, b))
    if a != b:
        diffs.append("rows differ: real=" + str(a[:3])[:150] + " shim=" + str(b[:3])[:150] + f" (n={len(a)}/{len(b)})")
    if show and r["show"] != s["show"]:
        for lr, ls in zip(r["show"].splitlines(), s["show"].splitlines()):
            if lr != ls: diffs.append(f"show line real={lr!r} shim={ls!r}"); break
        else: diffs.append(f"show length real={len(r['show'].splitlines())} shim={len(s['show'].splitlines())}")
    return ("ok", name, "") if not diffs else ("MISMATCH", name, " ; ".join(diffs))


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    from diff_cases import C
    out = {}
    for name, code, ordered, show in C:
        try:
            status, _, msg = compare(name, code, ordered, show)
        except Exception as e:  # noqa: BLE001
            status, msg = "HARNESS-ERROR", f"{type(e).__name__}: {str(e)[:200]}"
        out[name] = [status, msg]
    print("RESULTS-JSON " + json.dumps(out))
