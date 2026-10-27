"""A small PySpark-compatible DataFrame API for the in-browser trainer.

DataFrame operations are compiled to SQL and run on DuckDB (DuckDB-WASM in the
browser). It covers the commonly used part of pyspark.sql: DataFrame
transformations and actions, Column expressions, pyspark.sql.functions, Window,
Row and pyspark.sql.types. Things that need a real cluster (file I/O, Delta,
streaming, RDDs, Python UDFs) raise a clear error instead.

The host provides one function, `query_json(sql) -> str`, returning
{"columns": [...], "kinds": [...], "rows": [[...], ...]} where kinds are
"int", "float", "string", "bool", "date", "timestamp", "list", "struct" or "other",
dates/timestamps are ISO strings and decimals are plain numbers.
"""

import datetime
import itertools
import json
import re
import sys
import time
import traceback
import types as _pytypes

_host = {"query": None, "display": None}

_LONG_MIN = -(1 << 63)
_LONG_MAX = (1 << 63) - 1
_BT = chr(96)  # backtick


# --------------------------------------------------------------------------- errors

class AnalysisException(Exception):
    """Raised when a query can't be analyzed (unknown column, type mismatch, ...)."""


class PySparkTypeError(TypeError):
    pass


class PySparkValueError(ValueError):
    pass


class NotAvailableInTrainer(Exception):
    """Raised for Spark features that need a real cluster."""


_FILES_MSG = ("Reading and writing files needs a Databricks cluster. In this trainer the sample "
              "tables are already loaded: try spark.table(\"orders\"), or build data with "
              "spark.createDataFrame(...).")


def _clean_error(msg):
    msg = str(msg)
    m = re.search(r'Referenced column "(.+?)" not found in FROM clause!(?:\s*Candidate bindings: (.*))?', msg)
    if m:
        hint = ""
        if m.group(2):
            names = re.findall(r'"([^"]+)"', m.group(2).splitlines()[0])
            names = [n.split(".")[-1] for n in names]
            if names:
                hint = " Did you mean one of the following? [" + ", ".join(f"`{n}`" for n in names) + "]."
        return (f"[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column or function parameter with name `{m.group(1)}` "
                f"cannot be resolved.{hint}")
    m = re.search(r'Table with name (\S+) does not exist', msg)
    if m:
        return (f"[TABLE_OR_VIEW_NOT_FOUND] The table or view `{m.group(1)}` cannot be found. "
                "The sample tables are customers, products, orders, order_items, bronze_events and carts.")
    m = re.search(r"((?:Binder|Parser|Catalog|Conversion|Invalid Input|Not implemented|Constraint|"
                  r"Out of Range|Invalid|Dependency|Syntax) Error: .*)", msg, re.S)
    if m:
        msg = m.group(1)
    return msg.strip().splitlines()[0]


def _run(sql):
    try:
        return json.loads(_host["query"](sql))
    except AnalysisException:
        raise
    except Exception as e:  # JsException or duckdb.Error
        raise AnalysisException(_clean_error(e)) from None


# --------------------------------------------------------------------------- SQL helpers

def _qi(name):
    return '"' + str(name).replace('"', '""') + '"'


def _clean_name(n):
    n = str(n)
    if len(n) > 1 and n[0] == _BT and n[-1] == _BT:
        return n[1:-1]
    return n


def _table_ident(name):
    # Unity Catalog style names (main.sales.orders) map to the sample tables by their last part.
    return _qi(_clean_name(str(name).split(".")[-1]))


_REF = re.compile("\x00([^\x01]*)\x01([^\x02]*)\x02")


def _ref(alias, name):
    return f"\x00{alias}\x01{name}\x02"


def _resolve(sql, scope):
    return _REF.sub(lambda m: (_qi(m.group(1)) + "." + _qi(m.group(2)))
                    if m.group(1) in scope else _qi(m.group(2)), sql)


def _lit_sql(v, data=False):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return f"CAST({v} AS BIGINT)" if data else str(v)
    if isinstance(v, float):
        if v != v:
            return "CAST('NaN' AS DOUBLE)"
        if v in (float("inf"), float("-inf")):
            return f"CAST('{'-' if v < 0 else ''}Infinity' AS DOUBLE)"
        return f"CAST({v!r} AS DOUBLE)"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    if isinstance(v, datetime.datetime):
        return f"TIMESTAMP '{v.isoformat(sep=' ')}'"
    if isinstance(v, datetime.date):
        return f"DATE '{v.isoformat()}'"
    if isinstance(v, Row) and v._fields:
        return "{" + ", ".join(f"'{k}': {_lit_sql(x, data)}" for k, x in zip(v._fields, v)) + "}"
    if isinstance(v, dict):
        return "{" + ", ".join(f"'{k}': {_lit_sql(x, data)}" for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_lit_sql(x, data) for x in v) + "]"
    try:
        import decimal
        if isinstance(v, decimal.Decimal):
            return f"CAST('{v}' AS DOUBLE)"
    except ImportError:
        pass
    raise PySparkTypeError(f"Unsupported literal type: {type(v).__name__}")


def _lit_name(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


# --------------------------------------------------------------------------- types

class DataType:
    _duck_name = "VARCHAR"
    _simple = "string"
    _type_name = "string"

    def simpleString(self):
        return self._simple

    def typeName(self):
        return self._type_name

    def _duck(self):
        return self._duck_name

    def __repr__(self):
        return type(self).__name__ + "()"

    def __eq__(self, other):
        return type(self) is type(other) and repr(self) == repr(other)

    def __hash__(self):
        return hash(repr(self))


def _simple_type(cls_name, duck, simple, tname):
    return type(cls_name, (DataType,), {"_duck_name": duck, "_simple": simple, "_type_name": tname})


StringType = _simple_type("StringType", "VARCHAR", "string", "string")
IntegerType = _simple_type("IntegerType", "INTEGER", "int", "integer")
LongType = _simple_type("LongType", "BIGINT", "bigint", "long")
ShortType = _simple_type("ShortType", "SMALLINT", "smallint", "short")
ByteType = _simple_type("ByteType", "TINYINT", "tinyint", "byte")
DoubleType = _simple_type("DoubleType", "DOUBLE", "double", "double")
FloatType = _simple_type("FloatType", "FLOAT", "float", "float")
BooleanType = _simple_type("BooleanType", "BOOLEAN", "boolean", "boolean")
DateType = _simple_type("DateType", "DATE", "date", "date")
TimestampType = _simple_type("TimestampType", "TIMESTAMP", "timestamp", "timestamp")
NullType = _simple_type("NullType", "VARCHAR", "void", "void")


class DecimalType(DataType):
    def __init__(self, precision=10, scale=0):
        self.precision, self.scale = precision, scale

    def simpleString(self):
        return f"decimal({self.precision},{self.scale})"

    typeName = simpleString

    def _duck(self):
        return f"DECIMAL({self.precision},{self.scale})"

    def __repr__(self):
        return f"DecimalType({self.precision}, {self.scale})"


class ArrayType(DataType):
    def __init__(self, elementType, containsNull=True):
        self.elementType, self.containsNull = elementType, containsNull

    def simpleString(self):
        return f"array<{self.elementType.simpleString()}>"

    def typeName(self):
        return "array"

    def _duck(self):
        return self.elementType._duck() + "[]"

    def __repr__(self):
        return f"ArrayType({self.elementType!r}, {self.containsNull})"


class MapType(DataType):
    def __init__(self, keyType, valueType, valueContainsNull=True):
        self.keyType, self.valueType = keyType, valueType

    def simpleString(self):
        return f"map<{self.keyType.simpleString()},{self.valueType.simpleString()}>"

    def typeName(self):
        return "map"

    def _duck(self):
        return f"MAP({self.keyType._duck()}, {self.valueType._duck()})"

    def __repr__(self):
        return f"MapType({self.keyType!r}, {self.valueType!r})"


class StructField:
    def __init__(self, name, dataType, nullable=True, metadata=None):
        self.name, self.dataType, self.nullable = name, dataType, nullable

    def simpleString(self):
        return f"{self.name}:{self.dataType.simpleString()}"

    def __repr__(self):
        return f"StructField('{self.name}', {self.dataType!r}, {self.nullable})"

    def __eq__(self, other):
        return isinstance(other, StructField) and repr(self) == repr(other)


class StructType(DataType):
    def __init__(self, fields=None):
        self.fields = list(fields or [])

    def add(self, field, data_type=None, nullable=True, metadata=None):
        if isinstance(field, StructField):
            self.fields.append(field)
        else:
            if isinstance(data_type, str):
                data_type = _parse_spark_type(data_type)
            self.fields.append(StructField(field, data_type, nullable))
        return self

    def fieldNames(self):
        return [f.name for f in self.fields]

    @property
    def names(self):
        return self.fieldNames()

    def simpleString(self):
        return "struct<" + ",".join(f.simpleString() for f in self.fields) + ">"

    def typeName(self):
        return "struct"

    def _duck(self):
        return "STRUCT(" + ", ".join(f"{_qi(f.name)} {f.dataType._duck()}" for f in self.fields) + ")"

    def __iter__(self):
        return iter(self.fields)

    def __len__(self):
        return len(self.fields)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self.fields[key]
        for f in self.fields:
            if f.name == key:
                return f
        raise KeyError(key)

    def __repr__(self):
        return "StructType([" + ", ".join(repr(f) for f in self.fields) + "])"


_SPARK_TYPE_ALIASES = {
    "string": StringType, "varchar": StringType, "char": StringType,
    "int": IntegerType, "integer": IntegerType, "bigint": LongType, "long": LongType,
    "smallint": ShortType, "short": ShortType, "tinyint": ByteType, "byte": ByteType,
    "double": DoubleType, "float": FloatType, "real": FloatType,
    "boolean": BooleanType, "bool": BooleanType, "date": DateType,
    "timestamp": TimestampType, "timestamp_ntz": TimestampType, "void": NullType,
}


def _split_top(s, sep=","):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "<(":
            depth += 1
        elif ch in ">)":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [x.strip() for x in out]


def _parse_spark_type(s):
    s = s.strip()
    low = s.lower()
    if low in _SPARK_TYPE_ALIASES:
        return _SPARK_TYPE_ALIASES[low]()
    m = re.fullmatch(r"(?:decimal|numeric|dec)\s*(?:\((\d+)\s*,\s*(\d+)\))?", low)
    if m:
        return DecimalType(int(m.group(1) or 10), int(m.group(2) or 0))
    m = re.fullmatch(r"array\s*<(.*)>", s, re.I | re.S)
    if m:
        return ArrayType(_parse_spark_type(m.group(1)))
    m = re.fullmatch(r"map\s*<(.*)>", s, re.I | re.S)
    if m:
        k, v = _split_top(m.group(1))
        return MapType(_parse_spark_type(k), _parse_spark_type(v))
    m = re.fullmatch(r"struct\s*<(.*)>", s, re.I | re.S)
    if m:
        fields = []
        for part in _split_top(m.group(1)):
            name, typ = re.split(r"\s*:\s*|\s+", part, maxsplit=1)
            fields.append(StructField(_clean_name(name), _parse_spark_type(typ)))
        return StructType(fields)
    raise PySparkValueError(f"Unsupported data type: {s}")


def _parse_ddl(ddl):
    fields = []
    for part in _split_top(ddl):
        name, typ = re.split(r"\s*:\s*|\s+", part.strip(), maxsplit=1)
        fields.append(StructField(_clean_name(name), _parse_spark_type(typ)))
    return StructType(fields)


def _duck_type(t):
    if isinstance(t, DataType):
        return t._duck()
    if isinstance(t, type) and issubclass(t, DataType):
        return t()._duck()
    return _parse_spark_type(str(t))._duck()


def _from_duck_type(t):
    """DuckDB type string -> Spark DataType."""
    t = t.strip()
    up = t.upper()
    if up.endswith("[]"):
        return ArrayType(_from_duck_type(t[:-2]))
    simple = {
        "VARCHAR": StringType, "INTEGER": IntegerType, "BIGINT": LongType, "HUGEINT": LongType,
        "SMALLINT": ShortType, "TINYINT": ByteType, "UINTEGER": LongType, "UBIGINT": LongType,
        "DOUBLE": DoubleType, "FLOAT": FloatType, "BOOLEAN": BooleanType, "DATE": DateType,
        "TIMESTAMP": TimestampType, "TIMESTAMP WITH TIME ZONE": TimestampType, '"NULL"': NullType,
        "NULL": NullType,
    }
    if up in simple:
        return simple[up]()
    m = re.fullmatch(r"DECIMAL\((\d+),\s*(\d+)\)", up)
    if m:
        p, s = int(m.group(1)), int(m.group(2))
        return LongType() if s == 0 and p == 38 else DecimalType(p, s)
    m = re.fullmatch(r"STRUCT\((.*)\)", t, re.S | re.I)
    if m:
        fields = []
        for part in _split_top(m.group(1)):
            pm = re.match(r'("(?:[^"]|"")*"|\S+)\s+(.*)', part, re.S)
            name = pm.group(1)
            if name.startswith('"'):
                name = name[1:-1].replace('""', '"')
            fields.append(StructField(name, _from_duck_type(pm.group(2))))
        return StructType(fields)
    m = re.fullmatch(r"MAP\((.*)\)", t, re.S | re.I)
    if m:
        k, v = _split_top(m.group(1))
        return MapType(_from_duck_type(k), _from_duck_type(v))
    return StringType()


# --------------------------------------------------------------------------- Row

class Row(tuple):
    """A row of data, accessible by position, attribute or key."""

    def __new__(cls, *args, **kwargs):
        if args and kwargs:
            raise ValueError("Can not use both args and kwargs to create Row")
        if kwargs:
            r = tuple.__new__(cls, kwargs.values())
            r._fields = list(kwargs.keys())
        else:
            r = tuple.__new__(cls, args)
            r._fields = None
        return r

    @classmethod
    def _make(cls, fields, values):
        r = tuple.__new__(cls, values)
        r._fields = list(fields)
        return r

    def __call__(self, *values):
        # Row("a", "b")(1, 2) creates Row(a=1, b=2)
        return Row._make(list(self), values)

    def asDict(self, recursive=False):
        if not self._fields:
            raise TypeError("Cannot convert a Row class into dict")
        def conv(v):
            if recursive and isinstance(v, Row) and v._fields:
                return v.asDict(True)
            if recursive and isinstance(v, list):
                return [conv(x) for x in v]
            return v
        return {k: conv(v) for k, v in zip(self._fields, self)}

    def __getattr__(self, item):
        if item.startswith("__") or item == "_fields":
            raise AttributeError(item)
        fields = self.__dict__.get("_fields") or []
        if item in fields:
            return tuple.__getitem__(self, fields.index(item))
        raise AttributeError(item)

    def __getitem__(self, item):
        if isinstance(item, str):
            fields = self._fields or []
            if item in fields:
                return tuple.__getitem__(self, fields.index(item))
            raise KeyError(item)
        return tuple.__getitem__(self, item)

    def __contains__(self, item):
        return item in (self._fields or tuple(self))

    def __repr__(self):
        if self._fields:
            return "Row(" + ", ".join(f"{k}={v!r}" for k, v in zip(self._fields, self)) + ")"
        return "<Row(" + ", ".join(repr(v) for v in self) + ")>"


# --------------------------------------------------------------------------- Spark SQL -> DuckDB SQL
#
# spark.sql(), F.expr(), selectExpr() and string filters take Spark SQL, but the query runs on DuckDB.
# This token-based rewriter maps the common Spark idioms (functions, backticks, LEFT ANTI JOIN,
# LATERAL VIEW, three-part table names, :named parameters) so they behave the way they do on Databricks.

_SQL_TOKEN = re.compile(r"""
    (?P<str>'(?:\\.|[^'\\])*')
  | (?P<btq>`(?:[^`]|``)*`)
  | (?P<dq>"(?:[^"]|"")*")
  | (?P<cmt>--[^\n]*|/\*.*?\*/)
  | (?P<num>\d+\.?\d*(?:[eE][+-]?\d+)?)
  | (?P<id>[A-Za-z_][A-Za-z_0-9]*)
  | (?P<ws>\s+)
  | (?P<op><=>|<=|>=|<>|!=|==|::|->|\|\||.)
""", re.X | re.S)

_SQL_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "0": "\0"}


def _sx_tokens(sql):
    return [(m.lastgroup, m.group()) for m in _SQL_TOKEN.finditer(sql)]


def _sx_str(tok):
    """A Spark string literal ('..' or "..", with backslash escapes) as a DuckDB string literal."""
    return "'" + _sx_unescape(tok).replace("'", "''") + "'"


def _sx_unescape(tok):
    body, out, i = tok[1:-1], [], 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            n = body[i + 1]
            if n in "%_":
                out.append("\\" + n)
            else:
                out.append(_SQL_ESC.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _sx_next(toks, i, hi):
    while i < hi and toks[i][0] in ("ws", "cmt"):
        i += 1
    return i


def _sx_match(toks, i, hi, op="(", cl=")"):
    depth = 0
    for k in range(i, hi):
        if toks[k][0] == "op":
            if toks[k][1] == op:
                depth += 1
            elif toks[k][1] == cl:
                depth -= 1
                if depth == 0:
                    return k
    raise AnalysisException("[PARSE_SYNTAX_ERROR] Syntax error: unbalanced brackets in SQL.")


def _sx_prev(toks, i, lo):
    i -= 1
    while i >= lo and toks[i][0] in ("ws", "cmt"):
        i -= 1
    return i


def _sx_prepass(toks):
    """Rewrites `x RLIKE 'p'` / `x NOT REGEXP 'p'` into regexp_matches(x, 'p')."""
    k = 0
    while k < len(toks):
        kd, t = toks[k]
        nxt = _sx_next(toks, k + 1, len(toks))
        is_call = nxt < len(toks) and toks[nxt] == ("op", "(")
        if kd == "id" and t.lower() in ("rlike", "regexp") and not is_call:
            e = _sx_prev(toks, k, 0)
            negated = e >= 0 and toks[e][0] == "id" and toks[e][1].lower() == "not"
            first = e
            if negated:
                e = _sx_prev(toks, e, 0)
            if e < 0:
                k += 1
                continue
            if toks[e] == ("op", ")"):
                depth, m = 0, e
                while m >= 0:
                    if toks[m] == ("op", ")"):
                        depth += 1
                    elif toks[m] == ("op", "("):
                        depth -= 1
                        if depth == 0:
                            break
                    m -= 1
                start = m
                pm = _sx_prev(toks, m, 0)
                if pm >= 0 and toks[pm][0] == "id" and toks[pm][1].lower() not in _SX_KEYWORDS:
                    start = pm
            elif toks[e][0] in ("id", "btq", "dq", "str", "num"):
                start = e
                while True:
                    d = _sx_prev(toks, start, 0)
                    if d >= 0 and toks[d] == ("op", "."):
                        q = _sx_prev(toks, d, 0)
                        if q >= 0 and toks[q][0] in ("id", "btq", "dq"):
                            start = q
                            continue
                    break
            else:
                k += 1
                continue
            r = nxt
            if r >= len(toks):
                k += 1
                continue
            if toks[r][0] in ("str", "dq", "num"):
                r_end = r
            elif toks[r][0] in ("id", "btq"):
                r_end = r
                n2 = _sx_next(toks, r + 1, len(toks))
                if n2 < len(toks) and toks[n2] == ("op", "("):
                    r_end = _sx_match(toks, n2, len(toks))
            else:
                k += 1
                continue
            new = ([("id", "NOT"), ("ws", " ")] if negated else []) + [("id", "regexp_matches"), ("op", "(")] \
                + toks[start:e + 1] + [("op", ","), ("ws", " ")] + toks[r:r_end + 1] + [("op", ")")]
            cut = first if negated else start
            toks[min(cut, start):r_end + 1] = new
            k = min(cut, start) + len(new)
            continue
        k += 1
    return toks


def _sx_split(toks, lo, hi):
    if _sx_next(toks, lo, hi) >= hi:
        return []
    out, depth, start = [], 0, lo
    for k in range(lo, hi):
        if toks[k][0] == "op":
            t = toks[k][1]
            if t in ("(", "[", "{"):
                depth += 1
            elif t in (")", "]", "}"):
                depth -= 1
            elif t == "," and depth == 0:
                out.append((start, k))
                start = k + 1
    out.append((start, hi))
    return out


def _sx_unquote(kind, text):
    if kind == "btq":
        return text[1:-1].replace("``", "`")
    if kind == "dq":
        return text[1:-1].replace('""', '"')
    return text


_SX_KEYWORDS = {"from", "join", "in", "as", "on", "and", "or", "not", "where", "having", "select", "union", "all",
                "intersect", "except", "values", "over", "by", "with", "any", "some", "between", "case", "when",
                "then", "else", "using", "partition", "order", "group", "limit", "offset", "distinct", "table", "into"}
_SX_TABLE_KW = {"from", "join", "into", "table", "view", "update", "truncate", "exists"}
_SX_FUNCS = {}


def _sx_chain(toks, k, hi):
    """Parts of a dotted name starting at token k, and the index after it."""
    parts, end = [], k
    while k < hi and toks[k][0] in ("id", "btq", "dq"):
        parts.append(_sx_unquote(*toks[k]))
        end = k + 1
        n = _sx_next(toks, k + 1, hi)
        if n < hi and toks[n] == ("op", "."):
            m = _sx_next(toks, n + 1, hi)
            if m < hi and toks[m][0] in ("id", "btq", "dq"):
                k = m
                continue
        break
    return parts, end


def _sx_is_subscript(toks, i, lo):
    p = _sx_prev(toks, i, lo)
    if p < lo:
        return False
    kd, t = toks[p]
    return (kd in ("btq", "dq") or (kd == "id" and t.lower() not in _SX_KEYWORDS and t.lower() not in ("array",))
            or (kd == "op" and t in (")", "]")))


def _sx_emit(toks, lo, hi, params, in_func=False):
    out, i = [], lo
    while i < hi:
        kd, t = toks[i]
        if kd in ("str", "dq"):
            raw, j = _sx_unescape(t), i + 1
            while True:  # Spark joins adjacent string literals: 'it''s' is its
                n = _sx_next(toks, j, hi)
                if n < hi and toks[n][0] in ("str", "dq"):
                    raw += _sx_unescape(toks[n][1])
                    j = n + 1
                else:
                    break
            out.append("'" + raw.replace("'", "''") + "'")
            i = j
        elif kd == "btq":
            out.append(_qi(_sx_unquote(kd, t)))
            i += 1
        elif kd == "op":
            if t == "<=>":
                out.append(" IS NOT DISTINCT FROM ")
            elif t == ":" and i + 1 < hi and toks[i + 1][0] == "id" and toks[i + 1][1] in params:
                out.append(_lit_sql(params[toks[i + 1][1]]))
                i += 1
            elif t == "[" and _sx_is_subscript(toks, i, lo):
                close = _sx_match(toks, i, hi, "[", "]")
                inner = _sx_emit(toks, i + 1, close, params, True).strip()
                # Spark arrays are indexed from 0, DuckDB lists from 1. String keys (maps) stay as they are.
                out.append("[" + (inner if inner.startswith("'") else f"({inner}) + 1") + "]")
                i = close
            else:
                out.append(t)
            i += 1
        elif kd == "id":
            i = _sx_ident(toks, i, hi, params, out, in_func)
        else:
            out.append(t)
            i += 1
    return "".join(out)


def _sx_ident(toks, i, hi, params, out, in_func):
    t = toks[i][1]
    low = t.lower()
    j = _sx_next(toks, i + 1, hi)
    if j < hi and toks[j] == ("op", "("):
        close = _sx_match(toks, j, hi)
        if low in ("row_number", "rank", "dense_rank", "ntile"):
            o = _sx_next(toks, close + 1, hi)
            p = _sx_next(toks, o + 1, hi)
            if o < hi and toks[o][1].lower() == "over" and p < hi and toks[p] == ("op", "("):
                oc = _sx_match(toks, p, hi)
                call = t + "(" + _sx_emit(toks, j + 1, close, params, True) + ")"
                out.append(f"CAST({call} OVER ({_sx_emit(toks, p + 1, oc, params, True)}) AS INTEGER)")
                return oc + 1  # Spark's ranking functions return int
        fn = _SX_FUNCS.get(low)
        if fn is not None:
            args = [_sx_emit(toks, a, b, params, True).strip() for a, b in _sx_split(toks, j + 1, close)]
            res = fn(args)
            if res is not None:
                out.append(res)
                return close + 1
        ws = "".join(x[1] for x in toks[i + 1:j])
        out.append(t + ws + "(" + _sx_emit(toks, j + 1, close, params, in_func or low not in _SX_KEYWORDS) + ")")
        return close + 1
    if low in ("array", "map", "struct") and j < hi and toks[j] == ("op", "<"):
        depth, k = 0, j
        while k < hi:
            if toks[k] == ("op", "<"):
                depth += 1
            elif toks[k] == ("op", ">"):
                depth -= 1
                if depth == 0:
                    break
            k += 1
        if k < hi:
            text = "".join(x[1] for x in toks[i:k + 1])
            try:
                out.append(_parse_spark_type(text)._duck())
                return k + 1
            except Exception:  # noqa: BLE001 - fall through and let DuckDB report it
                pass
    if low == "div" and out and "".join(out).strip():
        out.append("//")
        return i + 1
    if low == "left" and j < hi and toks[j][0] == "id" and toks[j][1].lower() in ("anti", "semi"):
        return i + 1  # DuckDB spells it ANTI JOIN / SEMI JOIN
    if low == "using" and j < hi and toks[j][0] == "id" and toks[j][1].lower() in (
            "delta", "parquet", "csv", "json", "orc", "text", "avro"):
        return j + 1  # CREATE TABLE ... USING delta
    if low == "lateral" and j < hi and toks[j][1].lower() == "view":
        k = _sx_next(toks, j + 1, hi)
        if k < hi and toks[k][1].lower() == "outer":
            raise NotAvailableInTrainer("LATERAL VIEW OUTER isn't supported here. Use explode_outer() in a select.")
        if k < hi and toks[k][1].lower() == "explode":
            p = _sx_next(toks, k + 1, hi)
            if p < hi and toks[p] == ("op", "("):
                close = _sx_match(toks, p, hi)
                arg = _sx_emit(toks, p + 1, close, params, True)
                a = _sx_next(toks, close + 1, hi)
                if a < hi and toks[a][0] == "id":
                    n = _sx_next(toks, a + 1, hi)
                    if n < hi and toks[n][1].lower() == "as":
                        c = _sx_next(toks, n + 1, hi)
                        if c < hi and toks[c][0] in ("id", "btq"):
                            out.append(f" CROSS JOIN UNNEST({arg}) AS {_qi(toks[a][1])}({_qi(_sx_unquote(*toks[c]))})")
                            return c + 1
    if low in _SX_TABLE_KW and not in_func:
        parts, end = _sx_chain(toks, j, hi)
        if len(parts) >= 2:
            out.append(t + " " + _qi(parts[-1]))  # catalog.schema.table -> the sample table with that name
            return end
    out.append(t)
    return i + 1


def _spark_sql(sql, params=None):
    toks = _sx_prepass(_sx_tokens(sql))
    return _sx_emit(toks, 0, len(toks), params or {})


def _sx_alias(s):
    """Splits a trailing top-level `AS alias` off an expression. Returns (expression, alias or None)."""
    toks, depth, last, pos, offs = _sx_tokens(s), 0, None, 0, []
    for k, (kd, t) in enumerate(toks):
        offs.append(pos)
        pos += len(t)
        if kd == "op":
            if t in ("(", "[", "{"):
                depth += 1
            elif t in (")", "]", "}"):
                depth -= 1
        elif kd == "id" and t.lower() == "as" and depth == 0:
            last = k
    if last is None:
        return s, None
    rest = [x for x in toks[last + 1:] if x[0] not in ("ws", "cmt")]
    if len(rest) == 1 and rest[0][0] in ("id", "btq", "dq", "str"):
        name = rest[0][1]
        name = name[1:-1] if rest[0][0] in ("btq", "dq", "str") else name
        return s[:offs[last]], name
    return s, None


_SX_NOT_ALIAS = {"null", "true", "false", "end", "asc", "desc", "first", "last", "over", "filter", "distinct",
                 "and", "or", "not", "is", "in", "like", "between", "then", "else", "when", "case", "interval",
                 "escape", "as", "div", "rlike", "ilike", "regexp"}


def _sx_implicit_alias(text):
    """(expression, alias) for `expr alias` without AS, else (text, None)."""
    toks = [(k, x) for k, x in enumerate(_sx_tokens(text)) if x[0] not in ("ws", "cmt")]
    if len(toks) < 2:
        return text, None
    (lk, (lkind, ltext)), (pk, (pkind, ptext)) = toks[-1], toks[-2]
    if lkind not in ("id", "btq") or (lkind == "id" and ltext.lower() in _SX_NOT_ALIAS):
        return text, None
    not_ending = _SX_NOT_ALIAS - {"null", "true", "false", "end"}
    ends_expr = (pkind in ("num", "str", "btq", "dq") or (pkind == "op" and ptext in (")", "]"))
                 or (pkind == "id" and ptext.lower() not in not_ending))
    if not ends_expr:
        return text, None
    if pkind == "op" and ptext == "." or (pkind == "id" and ptext.lower() in ("nulls",)):
        return text, None
    pos = sum(len(x[1]) for x in _sx_tokens(text)[:lk])
    return text[:pos], _sx_unquote(lkind, ltext)


def _sx_item_name(text):
    """Spark-style column name for an unaliased select item: plain columns by name, calls as name(args)."""
    t = " ".join(text.split())
    toks = [x for x in _sx_tokens(t) if x[0] not in ("ws", "cmt")]
    if toks and all(x[0] in ("id", "btq", "dq") or x == ("op", ".") for x in toks) and len(toks) % 2 == 1:
        return _sx_unquote(*toks[-1])
    m = re.match(r"^(\w+)\s*\((.*)\)$", t, re.S)
    if m and _sx_match(_sx_tokens(t), 1 if len(_sx_tokens(t)) > 1 and _sx_tokens(t)[1][0] != "ws" else 2, 10 ** 6) == len(_sx_tokens(t)) - 1:
        args = ", ".join(" ".join(a.split()) for a in re.split(r",\s*(?![^()]*\))", m.group(2))) if m.group(2).strip() else ""
        args = re.sub(r"'((?:[^']|'')*)'", lambda q: q.group(1).replace("''", "'"), args)  # Spark prints literals unquoted
        if args.strip() == "*":
            args = "1"
        return f"{m.group(1).lower()}({args})"
    ops = [x for x in toks if x[0] == "op" and x[1] in ("+", "-", "*", "/", "%")]
    depth0 = all(x[1] not in ("(", ")") for x in toks if x[0] == "op")
    if ops and depth0 and all(x[0] in ("id", "num", "btq", "op") for x in toks):
        spaced = " ".join(_sx_unquote(*x) if x[0] == "btq" else x[1] for x in toks)
        return "(" + spaced + ")"  # Spark parenthesises arithmetic in generated names
    return t


def _sx_select_names(sql):
    """Names for the select list of a single top-level SELECT, or None when they can't be worked out."""
    toks = _sx_tokens(sql)
    depth, selects = 0, []
    for k, (kd, t) in enumerate(toks):
        if kd == "op" and t in ("(", "["):
            depth += 1
        elif kd == "op" and t in (")", "]"):
            depth -= 1
        elif kd == "id" and depth == 0 and t.lower() in ("select", "union", "intersect", "except", "values"):
            selects.append((k, t.lower()))
    if len(selects) != 1 or selects[0][1] != "select":
        return None
    start = selects[0][0] + 1
    while start < len(toks) and (toks[start][0] == "ws" or toks[start][1].lower() == "distinct"):
        start += 1
    end, depth = len(toks), 0
    for k in range(start, len(toks)):
        kd, t = toks[k]
        if kd == "op" and t in ("(", "["):
            depth += 1
        elif kd == "op" and t in (")", "]"):
            depth -= 1
        elif kd == "id" and depth == 0 and t.lower() in ("from", "where", "group", "order", "having", "limit", "window", "qualify"):
            end = k
            break
    names = []
    for a, b in _sx_split(toks, start, end):
        text = "".join(x[1] for x in toks[a:b]).strip()
        if not text or text == "*" or text.endswith(".*"):
            return None
        body, alias = _sx_alias(text)
        if not alias:
            body, alias = _sx_implicit_alias(text)
        names.append(alias if alias else _sx_item_name(body))
    return names


def _spark_expr(s):
    """A Spark SQL expression as (duckdb sql, alias or None)."""
    body, alias = _sx_alias(s)
    if not alias:
        body, alias = _sx_implicit_alias(body)
    return _spark_sql(body), alias


# -- function table: each entry takes the already-rewritten argument strings and returns SQL (or None to leave the call alone)
def _sx(*names):
    def deco(f):
        for n in names:
            _SX_FUNCS[n] = f
        return f
    return deco


def _uniq(a):
    nulls = f"list_position(list_transform({a}, __y -> __y IS NULL), true)"
    return (f"list_filter({a}, (__x, __i) -> (__x IS NOT NULL AND list_position({a}, __x) = __i) "
            f"OR (__x IS NULL AND {nulls} = __i))")


def _lam_parts(lam):
    p, _, body = lam.partition("->")
    return p.strip(), body.strip()


def _fmt_arg(a):
    m = re.fullmatch(r"'((?:[^']|'')*)'", a)
    if not m:
        return a
    return "'" + _java_fmt(m.group(1).replace("''", "'")).replace("'", "''") + "'"


_SX_INT_FUNCS = {"year": "year", "month": "month", "day": "day", "dayofmonth": "day", "dayofyear": "dayofyear",
                 "hour": "hour", "minute": "minute", "second": "second", "weekofyear": "weekofyear",
                 "quarter": "quarter", "length": "length", "char_length": "length", "character_length": "length",
                 "instr": "instr"}


def _int_fn(duck):
    return lambda a: f"CAST({duck}({', '.join(a)}) AS INTEGER)"


for _n, _d in _SX_INT_FUNCS.items():
    _SX_FUNCS[_n] = _int_fn(_d)

_SX_SIMPLE = {"mean": "avg", "array_contains": "list_contains", "array_max": "list_max", "array_min": "list_min",
              "max_by": "arg_max", "min_by": "arg_min", "rand": "random", "array_size": "len", "sha1": "sha1",
              "std": "stddev_samp", "regexp_like": "regexp_matches", "regexp": "regexp_matches"}
for _n, _d in _SX_SIMPLE.items():
    _SX_FUNCS[_n] = (lambda d: lambda a: f"{d}({', '.join(a)})")(_d)


@_sx("bround")
def _sx_bround(a): return f"round_even({a[0]}, {a[1] if len(a) > 1 else 0})"


@_sx("extract", "date_part")
def _sx_extract(a): return f"CAST(extract({a[0]}) AS INTEGER)" if len(a) == 1 and " from " in a[0].lower() else None


@_sx("dayofweek")
def _sx_dayofweek(a): return f"CAST(dayofweek({a[0]}) + 1 AS INTEGER)"


for _n in ("ceil", "ceiling", "floor"):
    _SX_FUNCS[_n] = (lambda n: lambda a: f"CAST({'ceil' if n != 'floor' else 'floor'}({a[0]}) AS BIGINT)" if len(a) == 1 else None)(_n)


@_sx("signum")
def _sx_signum(a): return f"CAST(sign({a[0]}) AS DOUBLE)"


@_sx("datediff")
def _sx_datediff(a):
    if len(a) != 2:
        return None
    return f"CAST(date_diff('day', TRY_CAST({a[1]} AS DATE), TRY_CAST({a[0]} AS DATE)) AS INTEGER)"


@_sx("date_add", "dateadd")
def _sx_date_add(a): return f"CAST(TRY_CAST({a[0]} AS DATE) + CAST({a[1]} AS INTEGER) AS DATE)" if len(a) == 2 else None


@_sx("date_sub")
def _sx_date_sub(a): return f"CAST(TRY_CAST({a[0]} AS DATE) - CAST({a[1]} AS INTEGER) AS DATE)" if len(a) == 2 else None


@_sx("add_months")
def _sx_add_months(a): return f"CAST(TRY_CAST({a[0]} AS DATE) + to_months(CAST({a[1]} AS INTEGER)) AS DATE)"


@_sx("current_date", "curdate")
def _sx_current_date(a): return "current_date" if not a else None


@_sx("current_timestamp", "now", "localtimestamp")
def _sx_current_ts(a): return "CAST(current_timestamp AS TIMESTAMP)" if not a else None


@_sx("to_date")
def _sx_to_date(a):
    if len(a) == 1:
        return f"TRY_CAST({a[0]} AS DATE)"
    return f"CAST(try_strptime(CAST({a[0]} AS VARCHAR), {_fmt_arg(a[1])}) AS DATE)"


@_sx("to_timestamp")
def _sx_to_timestamp(a):
    if len(a) == 1:
        return f"TRY_CAST({a[0]} AS TIMESTAMP)"
    return f"CAST(try_strptime(CAST({a[0]} AS VARCHAR), {_fmt_arg(a[1])}) AS TIMESTAMP)"


@_sx("date_format")
def _sx_date_format(a): return f"strftime(TRY_CAST({a[0]} AS TIMESTAMP), {_fmt_arg(a[1])})" if len(a) == 2 else None


@_sx("trunc")
def _sx_trunc(a):
    m = re.fullmatch(r"'(\w+)'", a[1]) if len(a) == 2 else None
    part = _TRUNC.get(m.group(1).lower()) if m else None
    return f"CAST(date_trunc('{part}', TRY_CAST({a[0]} AS DATE)) AS DATE)" if part else None


@_sx("date_trunc")
def _sx_date_trunc(a):
    m = re.fullmatch(r"'(\w+)'", a[0]) if len(a) == 2 else None
    part = _TRUNC.get(m.group(1).lower()) if m else None
    return f"CAST(date_trunc('{part}', TRY_CAST({a[1]} AS TIMESTAMP)) AS TIMESTAMP)" if part else None


@_sx("unix_timestamp", "to_unix_timestamp")
def _sx_unix_timestamp(a):
    if not a:
        return "CAST(epoch(current_timestamp) AS BIGINT)"
    src = (f"try_strptime(CAST({a[0]} AS VARCHAR), {_fmt_arg(a[1])})" if len(a) > 1
           else f"TRY_CAST(CAST({a[0]} AS VARCHAR) AS TIMESTAMP)")
    return f"CAST(floor(epoch({src})) AS BIGINT)"


@_sx("from_unixtime")
def _sx_from_unixtime(a):
    fmt = _fmt_arg(a[1]) if len(a) > 1 else "'%Y-%m-%d %H:%M:%S'"
    return f"strftime(make_timestamp(CAST(CAST({a[0]} AS DOUBLE) * 1000000 AS BIGINT)), {fmt})"


@_sx("months_between")
def _sx_months_between(a):
    x, y = f"TRY_CAST({a[0]} AS TIMESTAMP)", f"TRY_CAST({a[1]} AS TIMESTAMP)"
    rnd = len(a) < 3 or a[2].strip().lower() != "false"
    months = f"((year({x}) - year({y})) * 12 + (month({x}) - month({y})))"
    secs = lambda t: f"((day({t}) - 1) * 86400 + hour({t}) * 3600 + minute({t}) * 60 + second({t}))"
    frac = f"({months} + ({secs(x)} - {secs(y)}) / (31.0 * 86400))"
    if rnd:
        frac = f"round({frac}, 8)"
    return (f"CASE WHEN {x} IS NULL OR {y} IS NULL THEN NULL "
            f"WHEN day({x}) = day({y}) OR (day({x}) = day(last_day({x})) AND day({y}) = day(last_day({y}))) "
            f"THEN CAST({months} AS DOUBLE) ELSE {frac} END")


@_sx("size", "cardinality")
def _sx_size(a): return f"CAST(coalesce(len({a[0]}), -1) AS INTEGER)" if len(a) == 1 else None


@_sx("array_distinct")
def _sx_array_distinct(a): return _uniq(a[0])


def _null_if_any_null(a, body):
    return f"CASE WHEN {a[0]} IS NULL OR {a[1]} IS NULL THEN NULL ELSE {body} END"


@_sx("array_union")
def _sx_array_union(a): return _null_if_any_null(a, _uniq(f"list_concat({a[0]}, {a[1]})"))


@_sx("array_intersect")
def _sx_array_intersect(a): return _null_if_any_null(a, f"list_filter({_uniq(a[0])}, __z -> list_contains({a[1]}, __z))")


@_sx("array_except")
def _sx_array_except(a): return _null_if_any_null(a, f"list_filter({_uniq(a[0])}, __z -> NOT list_contains({a[1]}, __z))")


@_sx("array_position")
def _sx_array_position(a):
    return (f"CASE WHEN {a[0]} IS NULL OR {a[1]} IS NULL THEN NULL "
            f"ELSE CAST(coalesce(list_position({a[0]}, {a[1]}), 0) AS BIGINT) END")


@_sx("array_join")
def _sx_array_join(a):
    inner = a[0] if len(a) < 3 else f"list_transform({a[0]}, __e -> coalesce(CAST(__e AS VARCHAR), {a[2]}))"
    return f"CASE WHEN {a[0]} IS NULL THEN NULL ELSE coalesce(array_to_string({inner}, {a[1]}), '') END"


@_sx("sort_array")
def _sx_sort_array(a):
    desc = len(a) > 1 and a[1].strip().lower() == "false"
    return f"list_sort({a[0]}, 'DESC', 'NULLS LAST')" if desc else f"list_sort({a[0]}, 'ASC', 'NULLS FIRST')"


@_sx("array_sort")
def _sx_array_sort(a): return f"list_sort({a[0]}, 'ASC', 'NULLS LAST')" if len(a) == 1 else None


@_sx("array")
def _sx_array(a): return "[" + ", ".join(a) + "]"


@_sx("element_at")
def _sx_element_at(a): return f"{a[0]}[{a[1]}]" if len(a) == 2 else None


@_sx("explode")
def _sx_explode(a): return f"unnest({a[0]})" if len(a) == 1 else None


@_sx("explode_outer")
def _sx_explode_outer(a): return f"unnest(CASE WHEN {a[0]} IS NULL OR len({a[0]}) = 0 THEN [NULL] ELSE {a[0]} END)"


@_sx("collect_list")
def _sx_collect_list(a): return f"coalesce(list({a[0]}) FILTER (WHERE {a[0]} IS NOT NULL), [])"


@_sx("collect_set")
def _sx_collect_set(a): return f"coalesce(list(DISTINCT {a[0]}) FILTER (WHERE {a[0]} IS NOT NULL), [])"


@_sx("approx_count_distinct")
def _sx_approx_cd(a): return f"count(DISTINCT {a[0]})"


@_sx("nvl", "ifnull")
def _sx_nvl(a): return f"coalesce({a[0]}, {a[1]})" if len(a) == 2 else None


@_sx("nvl2")
def _sx_nvl2(a): return f"CASE WHEN {a[0]} IS NOT NULL THEN {a[1]} ELSE {a[2]} END"


@_sx("isnull")
def _sx_isnull(a): return f"({a[0]} IS NULL)" if len(a) == 1 else None


@_sx("isnotnull")
def _sx_isnotnull(a): return f"({a[0]} IS NOT NULL)" if len(a) == 1 else None


@_sx("concat")
def _sx_concat(a): return "(" + " || ".join(a) + ")" if a else None  # NULL in, NULL out, like Spark


@_sx("regexp_replace")
def _sx_regexp_replace(a):
    if len(a) != 3:
        return None
    rep = re.sub(r"\$(\d)", lambda m: "\\" + m.group(1), a[2])  # Java $1 -> RE2 \1
    return f"regexp_replace({a[0]}, {a[1]}, {rep}, 'g')"


@_sx("regexp_extract")
def _sx_regexp_extract(a): return f"regexp_extract({a[0]}, {a[1]}, 1)" if len(a) == 2 else None


@_sx("split")
def _sx_split_fn(a): return f"string_split_regex({a[0]}, {a[1]})" if len(a) >= 2 else None


@_sx("locate")
def _sx_locate(a): return f"CAST(instr({a[1]}, {a[0]}) AS INTEGER)" if len(a) == 2 else None


@_sx("log")
def _sx_log(a):
    if len(a) == 1:
        return f"ln({a[0]})"
    return f"(ln({a[1]}) / ln({a[0]}))" if len(a) == 2 else None


@_sx("sha2")
def _sx_sha2(a): return f"sha256({a[0]})" if len(a) == 2 and a[1].strip() in ("256", "0") else None


@_sx("initcap")
def _sx_initcap(a):
    return f"array_to_string(list_transform(string_split(lower({a[0]}), ' '), __w -> upper(__w[1]) || __w[2:]), ' ')"


@_sx("transform")
def _sx_transform(a): return f"list_transform({a[0]}, {a[1]})" if len(a) == 2 and "->" in a[1] else None


@_sx("filter")
def _sx_filter(a): return f"list_filter({a[0]}, {a[1]})" if len(a) == 2 and "->" in a[1] else None


@_sx("exists")
def _sx_exists(a): return f"(len(list_filter({a[0]}, {a[1]})) > 0)" if len(a) == 2 and "->" in a[1] else None


@_sx("forall")
def _sx_forall(a):
    if len(a) != 2 or "->" not in a[1]:
        return None
    p, body = _lam_parts(a[1])
    return f"(len(list_filter({a[0]}, {p} -> NOT ({body}))) = 0)"


@_sx("aggregate", "reduce")
def _sx_aggregate(a):
    if len(a) < 3 or "->" not in a[2]:
        return None
    core = f"CASE WHEN {a[0]} IS NULL THEN NULL ELSE list_reduce(list_prepend({a[1]}, {a[0]}), {a[2]}) END"
    return core if len(a) == 3 else f"list_transform([{core}], {a[3]})[1]"


# --------------------------------------------------------------------------- Column

_PLAIN = re.compile(r'^(?:"(?:[^"]|"")*"|\x00[^\x01]*\x01[^\x02]*\x02)$')


def _is_plain(sql):
    return bool(_PLAIN.match(sql))


def _spark_type_name(dt):
    if isinstance(dt, str):
        dt = _parse_spark_type(dt)
    elif isinstance(dt, type):
        dt = dt()
    return dt.simpleString().upper()


_CAST_INTS = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT")
_INT_TYPES = "'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT'"


def _cast_sql(x, t):
    """CAST with Spark semantics: truncating numeric -> integer, timestamp <-> epoch seconds, NULL on bad input."""
    T = t.upper()
    if T in _CAST_INTS:
        return (f"CAST(CASE WHEN {x} IS NULL THEN NULL "
                f"WHEN typeof({x}) LIKE 'TIMESTAMP%' THEN floor(epoch(TRY_CAST(CAST({x} AS VARCHAR) AS TIMESTAMP))) "
                f"WHEN typeof({x}) = 'BOOLEAN' THEN CASE WHEN CAST({x} AS VARCHAR) = 'true' THEN 1 ELSE 0 END "
                f"WHEN typeof({x}) IN ({_INT_TYPES}) THEN TRY_CAST(CAST({x} AS VARCHAR) AS BIGINT) "
                f"ELSE trunc(TRY_CAST(trim(CAST({x} AS VARCHAR)) AS DOUBLE)) END AS {T})")
    if T == "TIMESTAMP":
        return (f"CASE WHEN typeof({x}) IN ('TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT') "
                f"THEN CAST(make_timestamp(CAST(TRY_CAST(CAST({x} AS VARCHAR) AS DOUBLE) * 1000000 AS BIGINT)) AS TIMESTAMP) "
                f"ELSE TRY_CAST(CAST({x} AS VARCHAR) AS TIMESTAMP) END")
    return f"TRY_CAST({x} AS {t})"


class Column:
    """An expression over the rows of a DataFrame."""

    def __init__(self, sql, name=None, agg=None, order=None):
        self._sql = sql
        self._name = sql if name is None else name
        self._top = None     # name when selected unaliased at the top level (differs from _name for casts)
        self._agg = agg      # (template(arg_sql) -> sql, arg_sql) for aggregate functions
        self._order = order  # "ASC NULLS FIRST" etc. when used for sorting

    def _with(self, **kw):
        c = Column(self._sql, self._name, self._agg, self._order)
        c._top = self._top
        for k, v in kw.items():
            setattr(c, "_" + k, v)
        return c

    def __repr__(self):
        return f"Column<'{self._name}'>"

    def __bool__(self):
        raise PySparkValueError(
            "Cannot convert column into bool: please use '&' for 'and', '|' for 'or', "
            "'~' for 'not' when building DataFrame boolean expressions.")

    __nonzero__ = __bool__

    def __iter__(self):
        raise PySparkTypeError("Column is not iterable")

    def __contains__(self, item):
        raise PySparkValueError("Cannot apply 'in' operator against a column: please use 'contains' "
                                "in a string column or 'array_contains' function for an array column.")

    __hash__ = object.__hash__

    # -- operators
    def _bin(self, other, op, label=None, reverse=False):
        o = _to_col_lit(other)
        a, b = (o, self) if reverse else (self, o)
        return Column(f"({a._sql} {op} {b._sql})", f"({a._name} {label or op} {b._name})")

    def __eq__(self, o): return self._bin(o, "=")
    def __ne__(self, o): return self._bin(o, "!=")
    def __lt__(self, o): return self._bin(o, "<")
    def __le__(self, o): return self._bin(o, "<=")
    def __gt__(self, o): return self._bin(o, ">")
    def __ge__(self, o): return self._bin(o, ">=")
    def __and__(self, o): return self._bin(o, "AND")
    def __or__(self, o): return self._bin(o, "OR")
    def __rand__(self, o): return self._bin(o, "AND", reverse=True)
    def __ror__(self, o): return self._bin(o, "OR", reverse=True)
    def __add__(self, o): return self._bin(o, "+")
    def __sub__(self, o): return self._bin(o, "-")
    def __mul__(self, o): return self._bin(o, "*")
    def __truediv__(self, o): return self._bin(o, "/")
    def __mod__(self, o): return self._bin(o, "%")
    def __pow__(self, o): return Column(f"pow({self._sql}, {_to_col_lit(o)._sql})", f"POWER({self._name}, {_to_col_lit(o)._name})")
    def __radd__(self, o): return self._bin(o, "+", reverse=True)
    def __rsub__(self, o): return self._bin(o, "-", reverse=True)
    def __rmul__(self, o): return self._bin(o, "*", reverse=True)
    def __rtruediv__(self, o): return self._bin(o, "/", reverse=True)
    def __rmod__(self, o): return self._bin(o, "%", reverse=True)
    def __neg__(self): return Column(f"(- {self._sql})", f"(- {self._name})")
    def __invert__(self): return Column(f"(NOT {self._sql})", f"(NOT {self._name})")

    # -- naming and types
    def alias(self, *alias, **kwargs):
        return self._with(name=str(alias[0]), top=None)

    name = alias

    def cast(self, dataType):
        c = Column(_cast_sql(self._sql, _duck_type(dataType)), f"CAST({self._name} AS {_spark_type_name(dataType)})")
        if _is_plain(self._sql):
            c._top = self._name  # Spark keeps the column's own name for a top-level cast
        return c

    astype = cast

    # -- predicates
    def isNull(self): return Column(f"({self._sql} IS NULL)", f"({self._name} IS NULL)")
    def isNotNull(self): return Column(f"({self._sql} IS NOT NULL)", f"({self._name} IS NOT NULL)")

    def isin(self, *cols):
        if len(cols) == 1 and isinstance(cols[0], (list, tuple, set)):
            cols = list(cols[0])
        if not cols:
            return Column("FALSE", f"({self._name} IN ())")
        vals = [_to_col_lit(c) for c in cols]
        return Column(f"({self._sql} IN ({', '.join(v._sql for v in vals)}))",
                      f"({self._name} IN ({', '.join(v._name for v in vals)}))")

    def between(self, lowerBound, upperBound):
        lo, hi = _to_col_lit(lowerBound), _to_col_lit(upperBound)
        return Column(f"({self._sql} BETWEEN {lo._sql} AND {hi._sql})",
                      f"(({self._name} >= {lo._name}) AND ({self._name} <= {hi._name}))")

    def like(self, other): return Column(f"({self._sql} LIKE {_lit_sql(other)})", f"{self._name} LIKE {other}")
    def ilike(self, other): return Column(f"({self._sql} ILIKE {_lit_sql(other)})", f"ilike({self._name}, {other})")
    def rlike(self, other): return Column(f"regexp_matches({self._sql}, {_lit_sql(other)})", f"RLIKE({self._name}, {other})")

    def startswith(self, other):
        o = _to_col_lit(other)
        return Column(f"starts_with({self._sql}, {o._sql})", f"startswith({self._name}, {o._name})")

    def endswith(self, other):
        o = _to_col_lit(other)
        return Column(f"suffix({self._sql}, {o._sql})", f"endswith({self._name}, {o._name})")

    def contains(self, other):
        o = _to_col_lit(other)
        return Column(f"contains({self._sql}, {o._sql})", f"contains({self._name}, {o._name})")

    def eqNullSafe(self, other):
        o = _to_col_lit(other)
        return Column(f"({self._sql} IS NOT DISTINCT FROM {o._sql})", f"({self._name} <=> {o._name})")

    def substr(self, startPos, length):
        s, n = _to_col_lit(startPos), _to_col_lit(length)
        return Column(f"substring({self._sql}, {s._sql}, {n._sql})", f"substring({self._name}, {s._name}, {n._name})")

    # -- nested data
    def getItem(self, key):
        if isinstance(key, int):
            return Column(f"{self._sql}[{key + 1}]", f"{self._name}[{key}]")
        return Column(f"{self._sql}[{_lit_sql(key)}]", f"{self._name}[{key}]")

    def getField(self, name):
        return Column(f"{self._sql}[{_lit_sql(name)}]", f"{self._name}.{name}")

    def __getitem__(self, k):
        if isinstance(k, slice):
            raise PySparkValueError("Column slicing isn't supported; use substr() or slice().")
        return self.getItem(k)

    # -- ordering
    def asc(self): return self._with(order="ASC NULLS FIRST")
    def asc_nulls_first(self): return self._with(order="ASC NULLS FIRST")
    def asc_nulls_last(self): return self._with(order="ASC NULLS LAST")
    def desc(self): return self._with(order="DESC NULLS LAST")
    def desc_nulls_first(self): return self._with(order="DESC NULLS FIRST")
    def desc_nulls_last(self): return self._with(order="DESC NULLS LAST")

    # -- windows and conditionals
    def over(self, window):
        if not isinstance(window, WindowSpec):
            raise PySparkTypeError("over() expects a WindowSpec, for example Window.partitionBy(...).orderBy(...)")
        spec = window._spec()
        sql = f"{self._sql} OVER ({spec})"
        if re.match(r"(row_number|rank|dense_rank|ntile)\(", self._sql):
            sql = f"CAST({sql} AS INTEGER)"  # Spark's ranking functions return int
        return Column(sql, f"{self._name} OVER ({window._label()})")

    def when(self, condition, value):
        raise PySparkTypeError("when() can only be applied on a Column previously generated by when() function")

    def otherwise(self, value):
        raise PySparkTypeError("otherwise() can only be applied on a Column previously generated by when() function")


class _Case(Column):
    def __init__(self, branches, default=None):
        self._branches, self._default = branches, default
        sql = "CASE " + " ".join(f"WHEN {c._sql} THEN {v._sql}" for c, v in branches)
        name = "CASE " + " ".join(f"WHEN {c._name} THEN {v._name}" for c, v in branches)
        if default is not None:
            sql += f" ELSE {default._sql}"
            name += f" ELSE {default._name}"
        super().__init__(sql + " END", name + " END")

    def when(self, condition, value):
        if self._default is not None:
            raise PySparkTypeError("when() can't be applied once otherwise() is applied")
        return _Case(self._branches + [(_cond(condition), _to_col_lit(value))])

    def otherwise(self, value):
        if self._default is not None:
            raise PySparkTypeError("otherwise() can only be applied once")
        return _Case(self._branches, _to_col_lit(value))


def _cond(c):
    if isinstance(c, Column):
        return c
    raise PySparkTypeError(f"condition should be a Column, got {type(c).__name__}")


def _to_col_lit(x):
    return x if isinstance(x, Column) else lit(x)


def _c(x):
    """Column, or a column name, or a literal."""
    if isinstance(x, Column):
        return x
    if isinstance(x, str):
        return col(x)
    return lit(x)


def _flatten(cols):
    if len(cols) == 1 and isinstance(cols[0], (list, tuple)):
        return list(cols[0])
    return list(cols)


def col(name):
    name = str(name)
    if name == "*":
        return Column("*", "*")
    if name.endswith(".*"):
        return Column(_qi(_clean_name(name[:-2])) + ".*", name)
    if "." in name and not name.startswith(_BT):
        parts = [_clean_name(p) for p in name.split(".")]
        return Column(".".join(_qi(p) for p in parts), parts[-1])
    n = _clean_name(name)
    return Column(_qi(n), n)


column = col


def lit(value):
    if isinstance(value, Column):
        return value
    return Column(_lit_sql(value), _lit_name(value))


# --------------------------------------------------------------------------- Window

class WindowSpec:
    def __init__(self, part=(), order=(), frame=None):
        self._part, self._orderby, self._frame = tuple(part), tuple(order), frame

    def partitionBy(self, *cols):
        return WindowSpec([_c(c) if isinstance(c, (str, Column)) else _c(c) for c in _flatten(cols)], self._orderby, self._frame)

    def orderBy(self, *cols):
        return WindowSpec(self._part, [_c(c) for c in _flatten(cols)], self._frame)

    def rowsBetween(self, start, end):
        return WindowSpec(self._part, self._orderby, ("ROWS", start, end))

    def rangeBetween(self, start, end):
        return WindowSpec(self._part, self._orderby, ("RANGE", start, end))

    @staticmethod
    def _bound(v):
        if v <= -(1 << 62):
            return "UNBOUNDED PRECEDING"
        if v >= (1 << 62):
            return "UNBOUNDED FOLLOWING"
        if v == 0:
            return "CURRENT ROW"
        return f"{-v} PRECEDING" if v < 0 else f"{v} FOLLOWING"

    def _spec(self):
        parts = []
        if self._part:
            parts.append("PARTITION BY " + ", ".join(c._sql for c in self._part))
        if self._orderby:
            parts.append("ORDER BY " + ", ".join(f"{c._sql} {c._order or 'ASC NULLS FIRST'}" for c in self._orderby))
        if self._frame:
            kind, s, e = self._frame
            parts.append(f"{kind} BETWEEN {self._bound(s)} AND {self._bound(e)}")
        return " ".join(parts)

    def _label(self):
        parts = []
        if self._part:
            parts.append("PARTITION BY " + ", ".join(c._name for c in self._part))
        if self._orderby:
            parts.append("ORDER BY " + ", ".join(f"{c._name} {(c._order or 'ASC NULLS FIRST')}" for c in self._orderby))
        return " ".join(parts)


class Window:
    unboundedPreceding = _LONG_MIN
    unboundedFollowing = _LONG_MAX
    currentRow = 0

    @staticmethod
    def partitionBy(*cols):
        return WindowSpec().partitionBy(*cols)

    @staticmethod
    def orderBy(*cols):
        return WindowSpec().orderBy(*cols)

    @staticmethod
    def rowsBetween(start, end):
        return WindowSpec().rowsBetween(start, end)

    @staticmethod
    def rangeBetween(start, end):
        return WindowSpec().rangeBetween(start, end)


# --------------------------------------------------------------------------- functions

_F = {}


def _fn(*names):
    def deco(f):
        for n in names:
            _F[n] = f
        return f
    return deco


def _call(duck, spark, *args):
    return Column(f"{duck}({', '.join(a._sql for a in args)})", f"{spark}({', '.join(a._name for a in args)})")


def _agg(spark, c, template, arg_sql=None):
    """Aggregate column. template(arg_sql) -> SQL; keeps the template so pivot() can rewrite it."""
    c = _c(c)
    a = c._sql if arg_sql is None else arg_sql
    return Column(template(a), f"{spark}({c._name})", agg=(template, a))


_F.update(col=col, column=column, lit=lit)


@_fn("expr")
def expr(s):
    sql, alias = _spark_expr(s)
    return Column(f"({sql})", alias or s)


@_fn("when")
def when(condition, value):
    return _Case([(_cond(condition), _to_col_lit(value))])


@_fn("coalesce")
def coalesce(*cols):
    return _call("coalesce", "coalesce", *[_c(c) for c in cols])


@_fn("nvl", "ifnull")
def nvl(c1, c2):
    return _call("coalesce", "nvl", _c(c1), _c(c2))


@_fn("nullif")
def nullif(c1, c2):
    return _call("nullif", "nullif", _c(c1), _c(c2))


@_fn("isnull")
def isnull(c):
    c = _c(c)
    return Column(f"({c._sql} IS NULL)", f"({c._name} IS NULL)")


@_fn("isnotnull")
def isnotnull(c):
    c = _c(c)
    return Column(f"({c._sql} IS NOT NULL)", f"({c._name} IS NOT NULL)")


@_fn("greatest")
def greatest(*cols):
    return _call("greatest", "greatest", *[_c(c) for c in cols])


@_fn("least")
def least(*cols):
    return _call("least", "least", *[_c(c) for c in cols])


# -- aggregates
@_fn("sum")
def f_sum(c): return _agg("sum", c, lambda a: f"sum({a})")


@_fn("avg", "mean")
def f_avg(c): return _agg("avg", c, lambda a: f"avg({a})")


@_fn("min")
def f_min(c): return _agg("min", c, lambda a: f"min({a})")


@_fn("max")
def f_max(c): return _agg("max", c, lambda a: f"max({a})")


@_fn("count")
def f_count(c):
    if (isinstance(c, str) and c == "*") or (isinstance(c, Column) and c._sql == "*"):
        return Column("count(*)", "count(1)", agg=(lambda a: f"count({a})", "1"))
    if not isinstance(c, (str, Column)):
        return Column("count(*)", f"count({_lit_name(c)})", agg=(lambda a: f"count({a})", "1"))
    return _agg("count", c, lambda a: f"count({a})")


@_fn("countDistinct", "count_distinct")
def count_distinct(c, *cols):
    if cols:
        cs = [_c(x) for x in (c,) + cols]
        inner = "(" + ", ".join(x._sql for x in cs) + ")"
        return Column(f"count(DISTINCT {inner})", f"count(DISTINCT {', '.join(x._name for x in cs)})",
                      agg=(lambda a: f"count(DISTINCT {a})", inner))
    c = _c(c)
    return Column(f"count(DISTINCT {c._sql})", f"count(DISTINCT {c._name})",
                  agg=(lambda a: f"count(DISTINCT {a})", c._sql))


@_fn("approx_count_distinct", "approxCountDistinct")
def approx_count_distinct(c, rsd=None): return _agg("approx_count_distinct", c, lambda a: f"count(DISTINCT {a})")


@_fn("sum_distinct", "sumDistinct")
def sum_distinct(c):
    c = _c(c)
    return Column(f"sum(DISTINCT {c._sql})", f"sum(DISTINCT {c._name})", agg=(lambda a: f"sum(DISTINCT {a})", c._sql))


@_fn("first")
def first(c, ignorenulls=False):
    if ignorenulls:
        return _agg("first", c, lambda a: f"first({a}) FILTER (WHERE {a} IS NOT NULL)")
    return _agg("first", c, lambda a: f"first({a})")


@_fn("last")
def last(c, ignorenulls=False):
    if ignorenulls:
        return _agg("last", c, lambda a: f"last({a}) FILTER (WHERE {a} IS NOT NULL)")
    return _agg("last", c, lambda a: f"last({a})")


@_fn("collect_list")
def collect_list(c): return _agg("collect_list", c, lambda a: f"coalesce(list({a}) FILTER (WHERE {a} IS NOT NULL), [])")


@_fn("collect_set")
def collect_set(c): return _agg("collect_set", c, lambda a: f"coalesce(list(DISTINCT {a}) FILTER (WHERE {a} IS NOT NULL), [])")


@_fn("stddev", "stddev_samp", "std")
def stddev(c): return _agg("stddev", c, lambda a: f"stddev_samp({a})")


@_fn("stddev_pop")
def stddev_pop(c): return _agg("stddev_pop", c, lambda a: f"stddev_pop({a})")


@_fn("variance", "var_samp")
def variance(c): return _agg("var_samp", c, lambda a: f"var_samp({a})")


@_fn("var_pop")
def var_pop(c): return _agg("var_pop", c, lambda a: f"var_pop({a})")


@_fn("median")
def median(c): return _agg("median", c, lambda a: f"median({a})")


@_fn("count_if")
def count_if(c): return _agg("count_if", c, lambda a: f"count_if({a})")


@_fn("max_by")
def max_by(c, ord):
    c, o = _c(c), _c(ord)
    return Column(f"arg_max({c._sql}, {o._sql})", f"max_by({c._name}, {o._name})")


@_fn("min_by")
def min_by(c, ord):
    c, o = _c(c), _c(ord)
    return Column(f"arg_min({c._sql}, {o._sql})", f"min_by({c._name}, {o._name})")


@_fn("percentile_approx")
def percentile_approx(c, percentage, accuracy=10000):
    c = _c(c)
    return Column(f"approx_quantile({c._sql}, {percentage})", f"percentile_approx({c._name}, {percentage}, {accuracy})")


# -- window functions
@_fn("row_number")
def row_number(): return Column("row_number()", "row_number()")


@_fn("rank")
def rank(): return Column("rank()", "RANK()")


@_fn("dense_rank")
def dense_rank(): return Column("dense_rank()", "DENSE_RANK()")


@_fn("percent_rank")
def percent_rank(): return Column("percent_rank()", "PERCENT_RANK()")


@_fn("cume_dist")
def cume_dist(): return Column("cume_dist()", "CUME_DIST()")


@_fn("ntile")
def ntile(n): return Column(f"ntile({int(n)})", f"ntile({n})")


@_fn("lag")
def lag(c, offset=1, default=None):
    c = _c(c)
    d = f", {_lit_sql(default)}" if default is not None else ""
    return Column(f"lag({c._sql}, {int(offset)}{d})", f"lag({c._name}, {offset}, {_lit_name(default)})")


@_fn("lead")
def lead(c, offset=1, default=None):
    c = _c(c)
    d = f", {_lit_sql(default)}" if default is not None else ""
    return Column(f"lead({c._sql}, {int(offset)}{d})", f"lead({c._name}, {offset}, {_lit_name(default)})")


# -- simple scalar functions: spark name -> (duckdb name, result type Spark returns that DuckDB doesn't)
for _spark, (_duck, _t) in {
    "upper": ("upper", None), "lower": ("lower", None), "trim": ("trim", None), "ltrim": ("ltrim", None),
    "rtrim": ("rtrim", None), "length": ("length", "INTEGER"), "reverse": ("reverse", None), "abs": ("abs", None),
    "sqrt": ("sqrt", None), "exp": ("exp", None), "floor": ("floor", "BIGINT"), "ceil": ("ceil", "BIGINT"),
    "ceiling": ("ceil", "BIGINT"), "signum": ("sign", "DOUBLE"), "log10": ("log10", None), "log2": ("log2", None),
    "year": ("year", "INTEGER"), "month": ("month", "INTEGER"), "dayofmonth": ("day", "INTEGER"),
    "day": ("day", "INTEGER"), "dayofyear": ("dayofyear", "INTEGER"), "hour": ("hour", "INTEGER"),
    "minute": ("minute", "INTEGER"), "second": ("second", "INTEGER"), "weekofyear": ("weekofyear", "INTEGER"),
    "quarter": ("quarter", "INTEGER"), "md5": ("md5", None), "isnan": ("isnan", None),
    "flatten": ("flatten", None), "array_max": ("list_max", None), "array_min": ("list_min", None),
    "last_day": ("last_day", None), "ascii": ("ascii", None), "sin": ("sin", None), "cos": ("cos", None),
}.items():
    def _mk(d, s_, t):
        def f(c):
            c = _c(c)
            sql = f"{d}({c._sql})"
            return Column(f"CAST({sql} AS {t})" if t else sql, f"{s_}({c._name})")
        return f
    _F[_spark] = _mk(_duck, _spark, _t)


def _sx_col(name, label, *args, wrap=lambda s: s):
    """A Column from the shared SQL function table (args are Columns or Python values)."""
    cols = [_to_col_lit(a) if not isinstance(a, str) else _c(a) for a in args]
    sql = _SX_FUNCS[name]([c._sql for c in cols])
    return Column(sql, f"{label}({', '.join(c._name for c in cols)})")


@_fn("dayofweek")
def dayofweek(c):
    c = _c(c)
    return Column(f"CAST(dayofweek({c._sql}) + 1 AS INTEGER)", f"dayofweek({c._name})")


@_fn("size", "array_size", "cardinality")
def size(c):
    c = _c(c)
    return Column(f"CAST(coalesce(len({c._sql}), -1) AS INTEGER)", f"size({c._name})")


@_fn("round")
def f_round(c, scale=0):
    c = _c(c)
    return Column(f"round({c._sql}, {int(scale)})", f"round({c._name}, {scale})")


@_fn("bround")
def bround(c, scale=0):
    c = _c(c)
    return Column(f"round_even({c._sql}, {int(scale)})", f"bround({c._name}, {scale})")


@_fn("pow", "power")
def f_pow(c1, c2):
    a, b = _c(c1), _c(c2)
    return Column(f"pow({a._sql}, {b._sql})", f"POWER({a._name}, {b._name})")


@_fn("log")
def log(arg1, arg2=None):
    if arg2 is None:
        c = _c(arg1)
        return Column(f"ln({c._sql})", f"ln({c._name})")
    c = _c(arg2)
    return Column(f"(ln({c._sql}) / ln({float(arg1)}))", f"LOG({arg1}, {c._name})")


@_fn("ln")
def ln(c):
    c = _c(c)
    return Column(f"ln({c._sql})", f"ln({c._name})")


@_fn("concat")
def concat(*cols):
    cs = [_c(c) for c in cols]
    return Column("(" + " || ".join(c._sql for c in cs) + ")", f"concat({', '.join(c._name for c in cs)})")


@_fn("concat_ws")
def concat_ws(sep, *cols):
    cs = [_c(c) for c in cols]
    return Column(f"concat_ws({_lit_sql(sep)}, {', '.join(c._sql for c in cs)})",
                  f"concat_ws({sep}, {', '.join(c._name for c in cs)})")


@_fn("substring", "substr")
def substring(c, pos, len):
    c = _c(c)
    return Column(f"substring({c._sql}, {int(pos)}, {int(len)})", f"substring({c._name}, {pos}, {len})")


@_fn("instr")
def instr(c, substr):
    c = _c(c)
    return Column(f"CAST(instr({c._sql}, {_lit_sql(substr)}) AS INTEGER)", f"instr({c._name}, {substr})")


@_fn("lpad")
def lpad(c, len, pad):
    c = _c(c)
    return Column(f"lpad({c._sql}, {int(len)}, {_lit_sql(pad)})", f"lpad({c._name}, {len}, {pad})")


@_fn("rpad")
def rpad(c, len, pad):
    c = _c(c)
    return Column(f"rpad({c._sql}, {int(len)}, {_lit_sql(pad)})", f"rpad({c._name}, {len}, {pad})")


@_fn("repeat")
def repeat(c, n):
    c = _c(c)
    return Column(f"repeat({c._sql}, {int(n)})", f"repeat({c._name}, {n})")


@_fn("initcap")
def initcap(c):
    c = _c(c)
    words = f"string_split(lower({c._sql}), ' ')"
    return Column(f"array_to_string(list_transform({words}, w -> upper(w[1]) || w[2:]), ' ')", f"initcap({c._name})")


@_fn("regexp_replace")
def regexp_replace(c, pattern, replacement):
    c = _c(c)
    repl = re.sub(r"\$(\d)", r"\\\1", str(replacement))  # Java $1 -> RE2 \1
    return Column(f"regexp_replace({c._sql}, {_lit_sql(pattern)}, {_lit_sql(repl)}, 'g')",
                  f"regexp_replace({c._name}, {pattern}, {replacement}, 1)")


@_fn("regexp_extract")
def regexp_extract(c, pattern, idx):
    c = _c(c)
    return Column(f"regexp_extract({c._sql}, {_lit_sql(pattern)}, {int(idx)})",
                  f"regexp_extract({c._name}, {pattern}, {idx})")


@_fn("split")
def split(c, pattern, limit=-1):
    c = _c(c)
    return Column(f"string_split_regex({c._sql}, {_lit_sql(pattern)})", f"split({c._name}, {pattern}, {limit})")


@_fn("translate")
def translate(c, matching, replace):
    c = _c(c)
    return Column(f"translate({c._sql}, {_lit_sql(matching)}, {_lit_sql(replace)})",
                  f"translate({c._name}, {matching}, {replace})")


@_fn("sha2")
def sha2(c, numBits):
    if int(numBits) not in (0, 256):
        raise NotAvailableInTrainer("Only sha2(col, 256) is available in this trainer.")
    c = _c(c)
    return Column(f"sha256({c._sql})", f"sha2({c._name}, {numBits})")


@_fn("format_number")
def format_number(c, d):
    c = _c(c)
    return Column(f"format('{{:,.{int(d)}f}}', {c._sql})", f"format_number({c._name}, {d})")


# -- dates
def _java_fmt(fmt):
    out = []
    for tok in re.findall(r"'[^']*'|y+|M+|d+|H+|h+|m+|s+|S+|E+|a|.", fmt):
        if tok.startswith("'"):
            out.append(tok[1:-1].replace("%", "%%") or "'")
        elif tok[0] == "y":
            out.append("%y" if len(tok) == 2 else "%Y")
        elif tok[0] == "M":
            out.append({1: "%-m", 2: "%m", 3: "%b"}.get(len(tok), "%B"))
        elif tok[0] == "d":
            out.append("%-d" if len(tok) == 1 else "%d")
        elif tok[0] == "H":
            out.append("%-H" if len(tok) == 1 else "%H")
        elif tok[0] == "h":
            out.append("%-I" if len(tok) == 1 else "%I")
        elif tok[0] == "m":
            out.append("%-M" if len(tok) == 1 else "%M")
        elif tok[0] == "s":
            out.append("%-S" if len(tok) == 1 else "%S")
        elif tok[0] == "S":
            out.append("%g")
        elif tok[0] == "E":
            out.append("%A" if len(tok) >= 4 else "%a")
        elif tok == "a":
            out.append("%p")
        else:
            out.append(tok.replace("%", "%%"))
    return "".join(out)


@_fn("to_date")
def to_date(c, format=None):
    c = _c(c)
    if format is None:
        return Column(f"TRY_CAST({c._sql} AS DATE)", f"to_date({c._name})")
    return Column(f"CAST(try_strptime(CAST({c._sql} AS VARCHAR), {_lit_sql(_java_fmt(format))}) AS DATE)",
                  f"to_date({c._name}, {format})")


@_fn("to_timestamp")
def to_timestamp(c, format=None):
    c = _c(c)
    if format is None:
        return Column(f"TRY_CAST({c._sql} AS TIMESTAMP)", f"to_timestamp({c._name})")
    return Column(f"CAST(try_strptime(CAST({c._sql} AS VARCHAR), {_lit_sql(_java_fmt(format))}) AS TIMESTAMP)",
                  f"to_timestamp({c._name}, {format})")


@_fn("date_format")
def date_format(c, format):
    c = _c(c)
    return Column(f"strftime(TRY_CAST({c._sql} AS TIMESTAMP), {_lit_sql(_java_fmt(format))})",
                  f"date_format({c._name}, {format})")


@_fn("date_add", "dateadd")
def date_add(c, days):
    c, d = _c(c), _to_col_lit(days)
    return Column(f"CAST(TRY_CAST({c._sql} AS DATE) + CAST({d._sql} AS INTEGER) AS DATE)", f"date_add({c._name}, {d._name})")


@_fn("date_sub")
def date_sub(c, days):
    c, d = _c(c), _to_col_lit(days)
    return Column(f"CAST(TRY_CAST({c._sql} AS DATE) - CAST({d._sql} AS INTEGER) AS DATE)", f"date_sub({c._name}, {d._name})")


@_fn("add_months")
def add_months(c, months):
    c, m = _c(c), _to_col_lit(months)
    return Column(f"CAST(TRY_CAST({c._sql} AS DATE) + to_months(CAST({m._sql} AS INTEGER)) AS DATE)",
                  f"add_months({c._name}, {m._name})")


@_fn("datediff", "date_diff")
def datediff(end, start):
    e, s = _c(end), _c(start)
    return Column(f"CAST(date_diff('day', TRY_CAST({s._sql} AS DATE), TRY_CAST({e._sql} AS DATE)) AS INTEGER)",
                  f"datediff({e._name}, {s._name})")


@_fn("current_date", "curdate")
def current_date(): return Column("current_date", "current_date()")


@_fn("current_timestamp", "now")
def current_timestamp(): return Column("CAST(current_timestamp AS TIMESTAMP)", "current_timestamp()")


_TRUNC = {"year": "year", "yyyy": "year", "yy": "year", "quarter": "quarter", "month": "month", "mon": "month",
          "mm": "month", "week": "week", "day": "day", "dd": "day", "hour": "hour", "minute": "minute",
          "second": "second"}


@_fn("date_trunc")
def date_trunc(format, timestamp):
    c = _c(timestamp)
    part = _TRUNC.get(str(format).lower())
    if not part:
        raise PySparkValueError(f"Unsupported date_trunc format: {format}")
    return Column(f"CAST(date_trunc('{part}', TRY_CAST({c._sql} AS TIMESTAMP)) AS TIMESTAMP)",
                  f"date_trunc({format}, {c._name})")


@_fn("trunc")
def trunc(date, format):
    c = _c(date)
    part = _TRUNC.get(str(format).lower())
    if not part:
        raise PySparkValueError(f"Unsupported trunc format: {format}")
    return Column(f"CAST(date_trunc('{part}', TRY_CAST({c._sql} AS DATE)) AS DATE)", f"trunc({c._name}, {format})")


@_fn("make_date")
def make_date(year, month, day):
    return _call("make_date", "make_date", _c(year), _c(month), _c(day))


# -- arrays and structs
@_fn("array")
def array(*cols):
    cs = [_c(c) for c in _flatten(cols)]
    return Column("[" + ", ".join(c._sql for c in cs) + "]", f"array({', '.join(c._name for c in cs)})")


@_fn("array_contains")
def array_contains(c, value):
    c, v = _c(c), _to_col_lit(value)
    return Column(f"list_contains({c._sql}, {v._sql})", f"array_contains({c._name}, {v._name})")


@_fn("element_at")
def element_at(c, extraction):
    c = _c(c)
    return Column(f"{c._sql}[{_to_col_lit(extraction)._sql}]", f"element_at({c._name}, {extraction})")


@_fn("array_join")
def array_join(c, delimiter, null_replacement=None):
    c = _c(c)
    args = [c._sql, _lit_sql(delimiter)] + ([_lit_sql(null_replacement)] if null_replacement is not None else [])
    return Column(_SX_FUNCS["array_join"](args), f"array_join({c._name}, {delimiter})")


@_fn("array_sort")
def array_sort(c):
    c = _c(c)
    return Column(f"list_sort({c._sql}, 'ASC', 'NULLS LAST')", f"array_sort({c._name})")


@_fn("sort_array")
def sort_array(c, asc=True):
    c = _c(c)
    order = "'ASC', 'NULLS FIRST'" if asc else "'DESC', 'NULLS LAST'"
    return Column(f"list_sort({c._sql}, {order})", f"sort_array({c._name}, {str(asc).lower()})")


@_fn("slice")
def f_slice(c, start, length):
    c = _c(c)
    return Column(f"list_slice({c._sql}, {int(start)}, {int(start) + int(length) - 1})", f"slice({c._name}, {start}, {length})")


@_fn("array_position")
def array_position(c, value):
    c = _c(c)
    return Column(_SX_FUNCS["array_position"]([c._sql, _lit_sql(value)]), f"array_position({c._name}, {value})")


@_fn("array_union")
def array_union(c1, c2):
    a, b = _c(c1), _c(c2)
    return Column(_SX_FUNCS["array_union"]([a._sql, b._sql]), f"array_union({a._name}, {b._name})")


@_fn("array_intersect")
def array_intersect(c1, c2):
    a, b = _c(c1), _c(c2)
    return Column(_SX_FUNCS["array_intersect"]([a._sql, b._sql]), f"array_intersect({a._name}, {b._name})")


@_fn("array_distinct")
def array_distinct(c):
    return _sx_col("array_distinct", "array_distinct", _c(c))


@_fn("array_except")
def array_except(c1, c2):
    return _sx_col("array_except", "array_except", _c(c1), _c(c2))


@_fn("explode")
def explode(c):
    c = _c(c)
    return Column(f"unnest({c._sql})", "col")


@_fn("explode_outer")
def explode_outer(c):
    c = _c(c)
    return Column(f"unnest(CASE WHEN {c._sql} IS NULL OR len({c._sql}) = 0 THEN [NULL] ELSE {c._sql} END)", "col")


@_fn("struct")
def struct(*cols):
    cs = [_c(c) for c in _flatten(cols)]
    return Column("struct_pack(" + ", ".join(f"{_qi(c._name)} := {c._sql}" for c in cs) + ")",
                  f"struct({', '.join(c._name for c in cs)})")


_lambda_ids = itertools.count(1)


def _lambda(f, nargs=1):
    names = [f"__x{next(_lambda_ids)}" for _ in range(nargs)]
    body = _to_col_lit(f(*[Column(n, n) for n in names]))
    params = names[0] if nargs == 1 else "(" + ", ".join(names) + ")"
    return f"{params} -> {body._sql}"


@_fn("transform")
def transform(c, f):
    c = _c(c)
    return Column(f"list_transform({c._sql}, {_lambda(f)})", f"transform({c._name}, lambdafunction)")


@_fn("filter")
def f_filter(c, f):
    c = _c(c)
    return Column(f"list_filter({c._sql}, {_lambda(f)})", f"filter({c._name}, lambdafunction)")


@_fn("exists")
def exists(c, f):
    c = _c(c)
    return Column(f"(len(list_filter({c._sql}, {_lambda(f)})) > 0)", f"exists({c._name}, lambdafunction)")


@_fn("forall")
def forall(c, f):
    c = _c(c)
    return Column(f"(len(list_filter({c._sql}, {_lambda(lambda x: ~_to_col_lit(f(x)))})) = 0)",
                  f"forall({c._name}, lambdafunction)")


@_fn("aggregate", "reduce")
def aggregate(c, initialValue, merge, finish=None):
    c, z = _c(c), _to_col_lit(initialValue)
    sql = (f"CASE WHEN {c._sql} IS NULL THEN NULL "
           f"ELSE list_reduce(list_prepend({z._sql}, {c._sql}), {_lambda(merge, 2)}) END")
    if finish is not None:
        out = _to_col_lit(finish(Column(f"({sql})")))
        sql = out._sql
    return Column(sql, f"aggregate({c._name}, {z._name}, lambdafunction)")


# -- misc
@_fn("broadcast")
def broadcast(df):
    return df  # a hint for Spark's planner; DuckDB picks join strategies itself


@_fn("monotonically_increasing_id")
def monotonically_increasing_id():
    return Column("(row_number() OVER () - 1)", "monotonically_increasing_id()")


@_fn("spark_partition_id")
def spark_partition_id():
    return Column("0", "SPARK_PARTITION_ID()")


@_fn("input_file_name")
def input_file_name():
    return Column("''", "input_file_name()")


for _n in ("asc", "desc", "asc_nulls_first", "asc_nulls_last", "desc_nulls_first", "desc_nulls_last"):
    _F[_n] = (lambda m: lambda c: getattr(_c(c), m)())(_n)


def _udf_unavailable(*args, **kwargs):
    raise NotAvailableInTrainer(
        "Python UDFs aren't available in this browser trainer. Use built-in functions instead: "
        "they're also much faster on Databricks, because a Python UDF sends every row to a Python process.")


@_fn("udf", "pandas_udf")
def udf(f=None, returnType=None, *args, **kwargs):
    if f is None or isinstance(f, (str, DataType)):
        return lambda fn: _udf_unavailable
    return _udf_unavailable


@_fn("months_between")
def months_between(date1, date2, roundOff=True):
    a, b = _c(date1), _c(date2)
    args = [a._sql, b._sql] + ([] if roundOff else ["false"])
    return Column(_SX_FUNCS["months_between"](args), f"months_between({a._name}, {b._name}, {str(bool(roundOff)).lower()})")


@_fn("unix_timestamp")
def unix_timestamp(timestamp=None, format=None):
    if timestamp is None:
        return Column(_SX_FUNCS["unix_timestamp"]([]), "unix_timestamp(current_timestamp(), yyyy-MM-dd HH:mm:ss)")
    c = _c(timestamp)
    args = [c._sql] + ([_lit_sql(format)] if format else [])
    return Column(_SX_FUNCS["unix_timestamp"](args), f"unix_timestamp({c._name}, {format or 'yyyy-MM-dd HH:mm:ss'})")


@_fn("from_unixtime")
def from_unixtime(timestamp, format="yyyy-MM-dd HH:mm:ss"):
    c = _c(timestamp)
    return Column(_SX_FUNCS["from_unixtime"]([c._sql, _lit_sql(format)]), f"from_unixtime({c._name}, {format})")


for _n in ("from_json", "to_json", "get_json_object", "json_tuple", "schema_of_json", "window", "session_window",
           "input_file_block_start"):
    _F[_n] = (lambda n: lambda *a, **k: (_ for _ in ()).throw(
        NotAvailableInTrainer(f"F.{n}() isn't available in this browser trainer.")))(_n)


# --------------------------------------------------------------------------- DataFrame

_ids = itertools.count(1)


def _new_id():
    return f"_t{next(_ids)}"


def _sel_item(c):
    if c._sql == "*" or c._sql.endswith(".*") or c._sql == _qi(c._name):
        return c._sql
    return f"{c._sql} AS {_qi(c._top if c._top is not None else c._name)}"


def _as_col(c):
    if isinstance(c, Column):
        return c
    if isinstance(c, str):
        return col(c)
    raise PySparkTypeError(f"Expected a column name or Column, got {type(c).__name__}")


class DataFrame:
    """A lazily evaluated, distributed-style table, compiled to SQL."""

    def __init__(self, session, from_, scope, id_, proj=None, where=(), group=None, order=(),
                 limit=None, distinct=False, qualify=(), analyze=True):
        self.sparkSession = session
        self._from, self._scope, self._id = from_, frozenset(scope), id_
        self._proj, self._where, self._group = proj, tuple(where), group
        self._order, self._limit, self._distinct, self._qualify = tuple(order), limit, distinct, tuple(qualify)
        self._cols = None
        if analyze:
            self._analyze()

    def _copy(self, analyze=True, **kw):
        f = dict(from_=self._from, scope=self._scope, id_=self._id, proj=self._proj, where=self._where,
                 group=self._group, order=self._order, limit=self._limit, distinct=self._distinct,
                 qualify=self._qualify)
        f.update(kw)
        return DataFrame(self.sparkSession, analyze=analyze, **f)

    # -- compilation
    def _sql(self):
        r = lambda s: _resolve(s, self._scope)
        sel = ", ".join(r(p) for p in self._proj) if self._proj is not None else "*"
        q = "SELECT " + ("DISTINCT " if self._distinct else "") + sel + " FROM " + r(self._from)
        if self._where:
            q += " WHERE " + " AND ".join("(" + r(w) + ")" for w in self._where)
        if self._group:
            q += " GROUP BY " + ", ".join(r(g) for g in self._group)
        if self._qualify:
            q += " QUALIFY " + " AND ".join("(" + r(w) + ")" for w in self._qualify)
        if self._order:
            q += " ORDER BY " + ", ".join(r(o) for o in self._order)
        if self._limit is not None:
            q += f" LIMIT {self._limit}"
        return q

    def _analyze(self):
        res = _run("DESCRIBE " + self._sql())
        self._cols = [(r[0], r[1]) for r in res["rows"]]

    def _schema_pairs(self):
        if self._cols is None:
            self._analyze()
        return self._cols

    def _grouped(self):
        return self._group is not None

    def _projectable(self):
        return (self._proj is None and not self._grouped() and self._limit is None
                and not self._distinct and not self._qualify)

    def _pure(self):
        return self._projectable() and not self._where and not self._order

    def _wrap(self, alias=None):
        a = alias or self._id
        return DataFrame(self.sparkSession, f"({self._sql()}) AS {_qi(a)}", {a}, a, analyze=False)._with_cols(self._cols)

    def _with_cols(self, cols):
        self._cols = cols
        return self

    def _as_from_item(self, avoid=frozenset(), single=False):
        if self._pure() and not (self._scope & avoid) and (len(self._scope) == 1 or not single):
            return self._from, self._scope
        a = self._id if self._id not in avoid else _new_id()
        return f"({self._sql()}) AS {_qi(a)}", frozenset({a})

    # -- schema
    @property
    def columns(self):
        return [n for n, _ in self._schema_pairs()]

    @property
    def dtypes(self):
        return [(n, _from_duck_type(t).simpleString()) for n, t in self._schema_pairs()]

    @property
    def schema(self):
        return StructType([StructField(n, _from_duck_type(t)) for n, t in self._schema_pairs()])

    def printSchema(self, level=None):
        lines = ["root"]

        def walk(name, dt, depth, label="nullable"):
            pad = " |   " * depth
            lines.append(f"{pad} |-- {name}: {dt.typeName()} ({label} = true)")
            if isinstance(dt, StructType):
                for f in dt.fields:
                    walk(f.name, f.dataType, depth + 1)
            elif isinstance(dt, ArrayType):
                walk("element", dt.elementType, depth + 1, "containsNull")
            elif isinstance(dt, MapType):
                lines.append(f"{' |   ' * (depth + 1)} |-- key: {dt.keyType.typeName()}")
                walk("value", dt.valueType, depth + 1, "valueContainsNull")

        for f in self.schema.fields:
            walk(f.name, f.dataType, 0)
        print("\n".join(lines) + "\n")

    def __repr__(self):
        return "DataFrame[" + ", ".join(f"{n}: {t}" for n, t in self.dtypes) + "]"

    def _has_col(self, name):
        return any(n.lower() == name.lower() for n in self.columns)

    def __getitem__(self, item):
        if isinstance(item, str):
            if item == "*":
                return Column("*", "*")
            name = _clean_name(item)
            if not self._has_col(name):
                raise AnalysisException(f"[UNRESOLVED_COLUMN] A column with name `{name}` cannot be resolved. "
                                        f"Did you mean one of: {', '.join(self.columns)}?")
            return Column(_ref(self._id, name), name)
        if isinstance(item, int):
            return self[self.columns[item]]
        if isinstance(item, Column):
            return self.filter(item)
        if isinstance(item, (list, tuple)):
            return self.select(*item)
        raise PySparkTypeError(f"Unexpected item type: {type(item).__name__}")

    def __getattr__(self, name):
        if name.startswith("_") or name in ("sparkSession",):
            raise AttributeError(name)
        if self._has_col(name):
            return self[name]
        raise AttributeError(f"'DataFrame' object has no attribute '{name}'")

    # -- transformations
    def select(self, *cols):
        cs = [_as_col(c) for c in _flatten(cols)]
        base = self if self._projectable() else self._wrap()
        return base._copy(proj=[_sel_item(c) for c in cs], id_=_new_id())

    def selectExpr(self, *exprs):
        items = []
        for e in _flatten(exprs):
            if e.strip() == "*" or e.strip().endswith(".*"):
                items.append(e.strip())
                continue
            sql, alias = _spark_expr(e)
            items.append(f"{sql} AS {_qi(alias or e.strip())}")
        base = self if self._projectable() else self._wrap()
        return base._copy(proj=items, id_=_new_id())

    def filter(self, condition):
        sql = f"({_spark_sql(condition)})" if isinstance(condition, str) else _cond(condition)._sql
        base = self if self._projectable() else self._wrap()
        return base._copy(where=base._where + (sql,))

    where = filter

    def withColumn(self, colName, col):
        if not isinstance(col, Column):
            raise PySparkTypeError(f"[NOT_COLUMN] Argument `col` should be a Column, got {type(col).__name__}.")
        base = self if self._projectable() else self._wrap()
        if base._has_col(colName):
            proj = [f"* REPLACE ({col._sql} AS {_qi(colName)})"]
        else:
            proj = ["*", f"{col._sql} AS {_qi(colName)}"]
        return base._copy(proj=proj, id_=_new_id())

    def withColumns(self, *colsMap):
        df = self
        for k, v in colsMap[0].items():
            df = df.withColumn(k, v)
        return df

    def withColumnRenamed(self, existing, new):
        if not self._has_col(existing):
            return self
        base = self if self._projectable() else self._wrap()
        proj = [f"{_qi(n)} AS {_qi(new)}" if n.lower() == existing.lower() else _qi(n) for n in base.columns]
        return base._copy(proj=proj, id_=_new_id())

    def withColumnsRenamed(self, colsMap):
        df = self
        for k, v in colsMap.items():
            df = df.withColumnRenamed(k, v)
        return df

    def toDF(self, *cols):
        a = _new_id()
        names = ", ".join(_qi(c) for c in cols)
        return DataFrame(self.sparkSession, f"({self._sql()}) AS {_qi(a)}({names})", {a}, a)

    def drop(self, *cols):
        names = set()
        for c in cols:
            names.add((c if isinstance(c, str) else c._name).lower())
        keep = [n for n in self.columns if n.lower() not in names]
        if len(keep) == len(self.columns):
            return self
        base = self if self._projectable() else self._wrap()
        return base._copy(proj=[_qi(n) for n in keep], id_=_new_id())

    def alias(self, alias):
        return DataFrame(self.sparkSession, f"({self._sql()}) AS {_qi(alias)}", {alias}, alias)

    def orderBy(self, *cols, ascending=None):
        cs = [_as_col(c) for c in _flatten(cols)]
        items = []
        for i, c in enumerate(cs):
            asc = ascending[i] if isinstance(ascending, (list, tuple)) else ascending
            if asc is None:
                od = c._order or "ASC NULLS FIRST"
            else:
                od = "ASC NULLS FIRST" if asc else "DESC NULLS LAST"
            items.append(f"{c._sql} {od}")
        base = self if (self._limit is None and not self._distinct) else self._wrap()
        return base._copy(order=items)

    sort = orderBy
    sortWithinPartitions = orderBy

    def limit(self, num):
        n = int(num) if self._limit is None else min(int(num), self._limit)
        return self._copy(limit=n)

    def distinct(self):
        base = self if (self._limit is None and not self._qualify and not self._order) else self._wrap()
        return base._copy(distinct=True)

    def dropDuplicates(self, subset=None):
        if subset is None:
            return self.distinct()
        if isinstance(subset, str):
            subset = [subset]
        base = self._wrap()
        part = ", ".join(_qi(_clean_name(s)) for s in subset)
        return base._copy(qualify=(f"row_number() OVER (PARTITION BY {part}) = 1",))

    drop_duplicates = dropDuplicates

    def groupBy(self, *cols):
        return GroupedData(self, [_as_col(c) for c in _flatten(cols)])

    groupby = groupBy

    def agg(self, *exprs):
        return self.groupBy().agg(*exprs)

    def join(self, other, on=None, how=None):
        how_key = (how or "inner").lower().replace("_", "")
        kinds = {"inner": "INNER", "cross": "CROSS", "outer": "FULL OUTER", "full": "FULL OUTER",
                 "fullouter": "FULL OUTER", "left": "LEFT", "leftouter": "LEFT", "right": "RIGHT",
                 "rightouter": "RIGHT", "semi": "SEMI", "leftsemi": "SEMI", "anti": "ANTI", "leftanti": "ANTI"}
        if how_key not in kinds:
            raise PySparkValueError(f"Unsupported join type '{how}'. Use one of: inner, cross, outer, full, "
                                    "left, left_outer, right, right_outer, left_semi, left_anti.")
        kind = kinds[how_key]
        if isinstance(on, str):
            on = [on]
        if on is None or kind == "CROSS":
            lf, ls = self._as_from_item()
            rf, rs = other._as_from_item(avoid=ls)
            if on is None:
                return DataFrame(self.sparkSession, f"{lf} CROSS JOIN {rf}", ls | rs, _new_id())
        if isinstance(on, (list, tuple)) and on and all(isinstance(k, str) for k in on):
            lf, ls = self._as_from_item(single=True)
            rf, rs = other._as_from_item(avoid=ls, single=True)
            (la,), (ra,) = tuple(ls), tuple(rs)
            keys = [_clean_name(k) for k in on]
            using = ", ".join(_qi(k) for k in keys)
            from_ = f"{lf} {kind} JOIN {rf} USING ({using})"
            if kind in ("SEMI", "ANTI"):
                return DataFrame(self.sparkSession, from_, ls | rs, _new_id())
            keyset = {k.lower() for k in keys}
            key_items = []
            for k in keys:
                qk = _qi(k)
                if kind == "FULL OUTER":
                    key_items.append(f"coalesce({_qi(la)}.{qk}, {_qi(ra)}.{qk}) AS {qk}")
                elif kind == "RIGHT":
                    key_items.append(f"{_qi(ra)}.{qk} AS {qk}")
                else:
                    key_items.append(f"{_qi(la)}.{qk} AS {qk}")
            rest = [f"{_qi(la)}.{_qi(c)}" for c in self.columns if c.lower() not in keyset]
            rest += [f"{_qi(ra)}.{_qi(c)}" for c in other.columns if c.lower() not in keyset]
            return DataFrame(self.sparkSession, from_, ls | rs, _new_id(), proj=key_items + rest)
        conds = on if isinstance(on, (list, tuple)) else [on]
        conds = [_cond(c) for c in conds]
        cond_sql = " AND ".join(c._sql for c in conds)
        lf, ls = self._as_from_item()
        rf, rs = other._as_from_item(avoid=ls, single=True)
        if kind == "CROSS":
            return DataFrame(self.sparkSession, f"{lf} CROSS JOIN {rf}", ls | rs, _new_id(), where=(cond_sql,))
        return DataFrame(self.sparkSession, f"{lf} {kind} JOIN {rf} ON {cond_sql}", ls | rs, _new_id())

    def crossJoin(self, other):
        return self.join(other, how="cross")

    def _setop(self, other, op):
        a = _new_id()
        return DataFrame(self.sparkSession, f"(({self._sql()}) {op} ({other._sql()})) AS {_qi(a)}", {a}, a)

    def union(self, other):
        if len(self.columns) != len(other.columns):
            raise AnalysisException(
                f"[NUM_COLUMNS_MISMATCH] UNION can only be performed on inputs with the same number of columns, "
                f"but the first input has {len(self.columns)} columns and the second input has {len(other.columns)} columns.")
        return self._setop(other, "UNION ALL")

    unionAll = union

    def unionByName(self, other, allowMissingColumns=False):
        if not allowMissingColumns:
            a = {c.lower() for c in self.columns}
            b = {c.lower() for c in other.columns}
            if a != b:
                raise AnalysisException("[UNION_BY_NAME] Both DataFrames need the same column names "
                                        "(or pass allowMissingColumns=True).")
        return self._setop(other, "UNION ALL BY NAME")

    def intersect(self, other): return self._setop(other, "INTERSECT")
    def intersectAll(self, other): return self._setop(other, "INTERSECT ALL")
    def subtract(self, other): return self._setop(other, "EXCEPT")
    def exceptAll(self, other): return self._setop(other, "EXCEPT ALL")

    def fillna(self, value, subset=None):
        if isinstance(subset, str):
            subset = [subset]
        sub = None if subset is None else {s.lower() for s in subset}
        proj = []
        for n, t in self._schema_pairs():
            dt = _from_duck_type(t)
            v = None
            if isinstance(value, dict):
                for k, x in value.items():
                    if k.lower() == n.lower():
                        v = x
            elif sub is None or n.lower() in sub:
                numeric = isinstance(dt, (IntegerType, LongType, ShortType, ByteType, DoubleType, FloatType, DecimalType))
                if isinstance(value, bool):
                    v = value if isinstance(dt, BooleanType) else None
                elif isinstance(value, (int, float)):
                    v = value if numeric else None
                elif isinstance(value, str):
                    v = value if isinstance(dt, StringType) else None
            if v is None:
                proj.append(_qi(n))
            else:
                proj.append(f"CAST(coalesce({_qi(n)}, {_lit_sql(v)}) AS {t}) AS {_qi(n)}")
        base = self if self._projectable() else self._wrap()
        return base._copy(proj=proj)

    def dropna(self, how="any", thresh=None, subset=None):
        if isinstance(subset, str):
            subset = [subset]
        cols = subset or self.columns
        notnull = [f"({_qi(c)} IS NOT NULL)" for c in cols]
        if thresh is not None:
            cond = "(" + " + ".join(f"CAST({x} AS INTEGER)" for x in notnull) + f") >= {int(thresh)}"
        elif how == "all":
            cond = " OR ".join(notnull)
        else:
            cond = " AND ".join(notnull)
        return self.filter(Column(f"({cond})"))

    @property
    def na(self):
        return DataFrameNaFunctions(self)

    def transform(self, func, *args, **kwargs):
        return func(self, *args, **kwargs)

    def cache(self):
        return self

    def persist(self, storageLevel=None):
        return self

    def unpersist(self, blocking=False):
        return self

    def checkpoint(self, eager=True):
        return self

    localCheckpoint = checkpoint

    def repartition(self, numPartitions=None, *cols):
        return self

    def coalesce(self, numPartitions):
        return self

    def hint(self, name, *parameters):
        return self

    @property
    def rdd(self):
        raise NotAvailableInTrainer("RDDs aren't available in this trainer. Use the DataFrame API "
                                    "(it's also what Databricks recommends).")

    @property
    def write(self):
        return DataFrameWriter(self)

    @property
    def writeStream(self):
        raise NotAvailableInTrainer("Structured Streaming needs a Databricks cluster. See the Production lessons.")

    def withWatermark(self, eventTime, delayThreshold):
        raise NotAvailableInTrainer("Watermarks need Structured Streaming, which needs a Databricks cluster.")

    def createOrReplaceTempView(self, name):
        _run(f"CREATE OR REPLACE TEMP VIEW {_table_ident(name)} AS {self._sql()}")

    def createTempView(self, name):
        if self.sparkSession.catalog.tableExists(name):
            raise AnalysisException(f"[TEMP_TABLE_OR_VIEW_ALREADY_EXISTS] Cannot create the temporary view `{name}` because it already exists.")
        self.createOrReplaceTempView(name)

    createOrReplaceGlobalTempView = createOrReplaceTempView
    createGlobalTempView = createTempView

    # -- actions
    def _fetch(self, limit=None):
        df = self if limit is None else self.limit(limit)
        res = _run(df._sql())
        return res

    def collect(self):
        return _to_rows(self._fetch())

    def take(self, num):
        return _to_rows(self._fetch(num))

    def head(self, n=None):
        if n is None:
            rows = self.take(1)
            return rows[0] if rows else None
        return self.take(n)

    def first(self):
        return self.head()

    def tail(self, num):
        return self.collect()[-num:] if num else []

    def isEmpty(self):
        return len(self.take(1)) == 0

    def count(self):
        res = _run(f"SELECT count(*) FROM ({self._sql()}) AS __c")
        return int(res["rows"][0][0])

    def toPandas(self):
        raise NotAvailableInTrainer("pandas isn't loaded in this trainer. Use collect(), show() or display().")

    def toLocalIterator(self, prefetchPartitions=False):
        return iter(self.collect())

    def foreach(self, f):
        for r in self.collect():
            f(r)

    def show(self, n=20, truncate=True, vertical=False):
        rows = self.take(n + 1)
        more = len(rows) > n
        rows = rows[:n]
        print(_show_table(self.columns, rows, truncate, vertical, more, n))

    def describe(self, *cols):
        cols = _flatten(cols) or [c for c, t in self._schema_pairs()
                                  if isinstance(_from_duck_type(t), (StringType, IntegerType, LongType, ShortType,
                                                                     DoubleType, FloatType, DecimalType))]
        types = dict(self._schema_pairs())
        q = f"({self._sql()})"
        parts = []
        for stat in ("count", "mean", "stddev", "min", "max"):
            items = [f"'{stat}' AS summary"]
            for c in cols:
                numeric = not isinstance(_from_duck_type(types[c]), StringType)
                qc = _qi(c)
                expr_ = {"count": f"count({qc})",
                         "mean": f"avg({qc})" if numeric else "NULL",
                         "stddev": f"stddev_samp({qc})" if numeric else "NULL",
                         "min": f"min({qc})", "max": f"max({qc})"}[stat]
                items.append(f"CAST({expr_} AS VARCHAR) AS {qc}")
            parts.append(f"SELECT {', '.join(items)} FROM {q} AS __d")
        a = _new_id()
        return DataFrame(self.sparkSession, f"({' UNION ALL '.join(parts)}) AS {_qi(a)}", {a}, a)

    summary = describe

    def explain(self, extended=None, mode=None):
        res = _run("EXPLAIN " + self._sql())
        plan = "\n".join(r[1] for r in res["rows"] if r[0] == "physical_plan") or str(res["rows"])
        print("== Physical Plan ==\n(This trainer runs on DuckDB, so this is DuckDB's plan, not Spark's.)\n" + plan)


class DataFrameNaFunctions:
    def __init__(self, df):
        self._df = df

    def fill(self, value, subset=None):
        return self._df.fillna(value, subset)

    def drop(self, how="any", thresh=None, subset=None):
        return self._df.dropna(how, thresh, subset)


class GroupedData:
    def __init__(self, df, keys, pivot=None):
        self._df, self._keys, self._pivot = df, keys, pivot

    def agg(self, *exprs):
        if len(exprs) == 1 and isinstance(exprs[0], dict):
            exprs = [_dict_agg(fn, c) for c, fn in exprs[0].items()]
        exprs = [e for e in exprs]
        for e in exprs:
            if not isinstance(e, Column):
                raise PySparkTypeError("agg() expects Column expressions such as F.sum('amount'), or a dict.")
        df = self._df
        base = df if (df._projectable() and not df._order) else df._wrap()
        key_items = [_sel_item(k) for k in self._keys]
        if self._pivot is not None:
            agg_items = self._pivot_items(base, exprs)
        else:
            agg_items = [_sel_item(e) for e in exprs]
        group = [k._sql for k in self._keys]
        return base._copy(proj=key_items + agg_items, group=group, id_=_new_id())

    def _pivot_items(self, base, exprs):
        pcol, values = self._pivot
        if values is None:
            res = _run(f"SELECT DISTINCT {_resolve(pcol._sql, base._scope)} AS v FROM {_resolve(base._from, base._scope)}"
                       + ("" if not base._where else " WHERE " + " AND ".join("(" + _resolve(w, base._scope) + ")" for w in base._where))
                       + " ORDER BY 1")
            values = [r[0] for r in res["rows"] if r[0] is not None]
        items = []
        for v in values:
            for e in exprs:
                if e._agg is None:
                    raise AnalysisException("pivot() needs aggregate functions such as F.sum('amount').")
                template, arg = e._agg
                sql = template(f"CASE WHEN {pcol._sql} = {_lit_sql(v)} THEN {arg} END")
                if sql.startswith("count("):
                    sql = f"nullif({sql}, 0)"  # Spark leaves missing pivot cells NULL, even for count
                name = str(v) if len(exprs) == 1 else f"{v}_{e._name}"
                items.append(f"{sql} AS {_qi(name)}")
        return items

    def pivot(self, pivot_col, values=None):
        return GroupedData(self._df, self._keys, (_as_col(pivot_col), values))

    def count(self):
        return self.agg(f_count("*").alias("count"))

    def _numeric(self, fn, cols):
        if not cols:
            keys = {k._name.lower() for k in self._keys}
            cols = [n for n, t in self._df._schema_pairs()
                    if isinstance(_from_duck_type(t), (IntegerType, LongType, ShortType, ByteType, DoubleType, FloatType, DecimalType))
                    and n.lower() not in keys]
        return self.agg(*[fn(c) for c in cols])

    def sum(self, *cols): return self._numeric(f_sum, cols)
    def avg(self, *cols): return self._numeric(f_avg, cols)
    mean = avg
    def min(self, *cols): return self._numeric(f_min, cols)
    def max(self, *cols): return self._numeric(f_max, cols)


def _dict_agg(fn, c):
    fn = fn.lower()
    table = {"sum": f_sum, "avg": f_avg, "mean": f_avg, "min": f_min, "max": f_max, "count": f_count,
             "first": first, "last": last, "collect_list": collect_list, "collect_set": collect_set,
             "stddev": stddev, "variance": variance}
    if fn not in table:
        raise PySparkValueError(f"Unsupported aggregate function in dict: {fn}")
    out = table[fn](c)
    return out.alias(f"{'avg' if fn == 'mean' else fn}({c})")


class DataFrameWriter:
    def __init__(self, df):
        self._df, self._mode = df, "errorifexists"

    def mode(self, saveMode):
        self._mode = (saveMode or "errorifexists").lower()
        return self

    def format(self, source): return self
    def option(self, key, value): return self
    def options(self, **options): return self
    def partitionBy(self, *cols): return self
    def bucketBy(self, numBuckets, col, *cols): return self
    def sortBy(self, col, *cols): return self
    def clusterBy(self, *cols): return self

    def saveAsTable(self, name, format=None, mode=None, partitionBy=None, **options):
        mode = (mode or self._mode).lower()
        t = _table_ident(name)
        exists = self._df.sparkSession.catalog.tableExists(name)
        sql = self._df._sql()
        if mode in ("error", "errorifexists", "default"):
            if exists:
                raise AnalysisException(f"[TABLE_OR_VIEW_ALREADY_EXISTS] Table `{name}` already exists. "
                                        "Use .mode(\"overwrite\") or .mode(\"append\").")
            _run(f"CREATE TABLE {t} AS {sql}")
        elif mode == "overwrite":
            _run(f"CREATE OR REPLACE TABLE {t} AS {sql}")
        elif mode == "append":
            _run(f"INSERT INTO {t} BY NAME {sql}" if exists else f"CREATE TABLE {t} AS {sql}")
        elif mode == "ignore":
            if not exists:
                _run(f"CREATE TABLE {t} AS {sql}")
        else:
            raise PySparkValueError(f"Unknown save mode: {mode}. Use append, overwrite, error or ignore.")

    def insertInto(self, tableName, overwrite=None):
        t = _table_ident(tableName)
        if overwrite or self._mode == "overwrite":
            _run(f"DELETE FROM {t}")
        _run(f"INSERT INTO {t} {self._df._sql()}")

    def _files(self, *a, **k):
        raise NotAvailableInTrainer(_FILES_MSG)

    save = csv = json = parquet = text = orc = _files


class DataFrameReader:
    def __init__(self, session):
        self._session = session

    def format(self, source): return self
    def option(self, key, value): return self
    def options(self, **options): return self
    def schema(self, schema): return self

    def table(self, tableName):
        return self._session.table(tableName)

    def _files(self, *a, **k):
        raise NotAvailableInTrainer(_FILES_MSG)

    load = csv = json = parquet = text = orc = _files


# --------------------------------------------------------------------------- results

def _to_value(v, kind):
    if v is None:
        return None
    if kind == "date":
        return datetime.date.fromisoformat(v)
    if kind == "timestamp":
        return datetime.datetime.fromisoformat(v)
    if kind == "float":
        return float(v)
    if kind == "int":
        return int(v)
    if kind == "struct" and isinstance(v, dict):
        return Row(**v)
    return v


def _to_rows(res):
    cols, kinds = res["columns"], res["kinds"]
    return [Row._make(cols, [_to_value(v, k) for v, k in zip(r, kinds)]) for r in res["rows"]]


def _java_double(v):
    if v != v:
        return "NaN"
    if v in (float("inf"), float("-inf")):
        return "Infinity" if v > 0 else "-Infinity"
    a = abs(v)
    if a != 0 and (a >= 1e7 or a < 1e-3):
        m, e = f"{v:.16E}".split("E")
        m = m.rstrip("0")
        if m.endswith("."):
            m += "0"
        return f"{m}E{int(e)}"
    return repr(float(v))


def _show_str(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return _java_double(v)
    if isinstance(v, datetime.datetime):
        s = v.isoformat(sep=" ")
        return s
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, Row):
        return "{" + ", ".join(_show_str(x) for x in v) + "}"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{_show_str(k)} -> {_show_str(x)}" for k, x in v.items()) + "}"
    if isinstance(v, list):
        return "[" + ", ".join(_show_str(x) for x in v) + "]"
    return str(v)


def _show_table(cols, rows, truncate, vertical, more, n):
    t = 20 if truncate is True else (int(truncate) if truncate else 0)

    def cut(s):
        if t and len(s) > t:
            return s[:t] if t < 4 else s[:t - 3] + "..."
        return s

    cells = [[cut(_show_str(v)) for v in r] for r in rows]
    heads = [cut(c) for c in cols]
    if vertical:
        w = max([len(h) for h in heads] + [0])
        out = []
        for i, r in enumerate(cells):
            out.append(f"-RECORD {i}" + "-" * 10)
            out += [f" {h.ljust(w)} | {v}" for h, v in zip(heads, r)]
        if not cells:
            out.append("(0 rows)")
        return "\n".join(out)
    widths = [max([3, len(h)] + [len(r[i]) for r in cells]) for i, h in enumerate(heads)]
    pad = (lambda s, w: s.rjust(w)) if t else (lambda s, w: s.ljust(w))
    sep = "+" + "+".join("-" * w for w in widths) + "+"
    lines = [sep, "|" + "|".join(pad(h, w) for h, w in zip(heads, widths)) + "|", sep]
    lines += ["|" + "|".join(pad(v, w) for v, w in zip(r, widths)) + "|" for r in cells]
    lines.append(sep)
    if more:
        lines.append(f"only showing top {n} row{'s' if n != 1 else ''}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- session

class _Conf:
    def __init__(self):
        self._d = {"spark.sql.shuffle.partitions": "200", "spark.sql.adaptive.enabled": "true",
                   "spark.sql.ansi.enabled": "false"}

    def set(self, key, value):
        self._d[key] = str(value)

    def get(self, key, default=None):
        return self._d.get(key, default)

    def unset(self, key):
        self._d.pop(key, None)


class _Catalog:
    def __init__(self, session):
        self._s = session

    def _names(self):
        res = _run("SELECT table_name, table_type FROM information_schema.tables ORDER BY 1")
        return res["rows"]

    def listTables(self, dbName=None):
        Table = Row("name", "catalog", "namespace", "description", "tableType", "isTemporary")
        return [Table(n, "main", ["default"], None, "VIEW" if "VIEW" in (t or "") else "MANAGED", "VIEW" in (t or ""))
                for n, t in self._names()]

    def tableExists(self, tableName, dbName=None):
        target = _clean_name(str(tableName).split(".")[-1]).lower()
        return any(n.lower() == target for n, _ in self._names())

    def dropTempView(self, viewName):
        _run(f"DROP VIEW IF EXISTS {_table_ident(viewName)}")
        return True

    dropGlobalTempView = dropTempView


class _SparkContext:
    defaultParallelism = 8
    appName = "databricks-trainer"

    def setLogLevel(self, level):
        pass


class _Builder:
    def appName(self, name): return self
    def master(self, master): return self
    def config(self, key=None, value=None, conf=None, **kw): return self
    def enableHiveSupport(self): return self

    def getOrCreate(self):
        return spark


class SparkSession:
    builder = _Builder()

    def __init__(self):
        self.conf = _Conf()
        self.catalog = _Catalog(self)
        self.sparkContext = _SparkContext()
        self.version = "3.5.0 (browser trainer on DuckDB)"

    @classmethod
    def getActiveSession(cls):
        return spark

    def newSession(self):
        return self

    def stop(self):
        pass

    @property
    def read(self):
        return DataFrameReader(self)

    @property
    def readStream(self):
        raise NotAvailableInTrainer("Structured Streaming needs a Databricks cluster. See the Production lessons.")

    def table(self, tableName):
        a = _new_id()
        return DataFrame(self, f"{_table_ident(tableName)} AS {_qi(a)}", {a}, a)

    def _empty_result(self):
        return self.createDataFrame([], "result STRING")

    def _sql_special(self, q):
        """Statements Databricks answers differently from DuckDB, or that need a cluster."""
        head = re.match(r"(?is)^\s*(\w+)(?:\s+(\w+))?", q)
        w1, w2 = (head.group(1).lower(), (head.group(2) or "").lower()) if head else ("", "")
        if w1 == "show" and w2 == "tables":
            res = _run("SELECT table_name, table_type, 'BASE TABLE' = table_type AS is_base "
                       "FROM information_schema.tables ORDER BY table_name")
            rows = [("default" if r[2] else "", r[0], not r[2]) for r in res["rows"]]
            return self.createDataFrame(rows, "namespace STRING, tableName STRING, isTemporary BOOLEAN")
        if w1 == "show" and w2 in ("databases", "schemas"):
            return self.createDataFrame([("default",)], "namespace STRING")
        if w1 == "show" and w2 == "catalogs":
            return self.createDataFrame([("main",)], "catalog STRING")
        if w1 in ("describe", "desc") and w2 not in ("history", "detail", "extended", "formatted"):
            m = re.match(r"(?is)^\s*desc(?:ribe)?\s+(?:table\s+)?(?:extended\s+|formatted\s+)?([\w.`]+)\s*$", q)
            if m:
                df = self.table(m.group(1))
                rows = [(n, _from_duck_type(t).simpleString(), None) for n, t in df._schema_pairs()]
                return self.createDataFrame(rows, "col_name STRING, data_type STRING, comment STRING")
        if w1 in ("describe", "desc") and w2 in ("history", "detail"):
            raise NotAvailableInTrainer("DESCRIBE HISTORY and DESCRIBE DETAIL need Delta tables on a Databricks cluster.")
        if w1 in ("optimize", "vacuum", "restore", "merge") or (w1 == "copy" and w2 == "into"):
            raise NotAvailableInTrainer(f"{w1.upper()} needs Delta Lake on a Databricks cluster. "
                                        "Practise it in the syntax exercises instead.")
        if w1 in ("grant", "revoke", "deny"):
            raise NotAvailableInTrainer("Unity Catalog privileges need a Databricks workspace. "
                                        "Practise GRANT and REVOKE in the Governance syntax exercises.")
        if w1 in ("use", "set", "refresh", "analyze", "cache", "uncache"):
            return self._empty_result()
        if w1 == "create" and re.match(r"(?is)^\s*create\s+(or\s+replace\s+)?(schema|database|catalog)\b", q):
            return self._empty_result()
        if w1 == "drop" and w2 in ("schema", "database", "catalog"):
            return self._empty_result()
        if re.match(r"(?is)^\s*create\s+(or\s+(refresh|replace)\s+)?(streaming\s+table|materialized\s+view|live\s+table)", q):
            raise NotAvailableInTrainer("Lakeflow Declarative Pipelines run as pipelines on Databricks, not in a notebook. "
                                        "See the Production lessons and syntax exercises.")
        return None

    def sql(self, sqlQuery, args=None, **kwargs):
        q = sqlQuery.strip().rstrip(";").strip()
        special = self._sql_special(q)
        if special is not None:
            return special
        params = args if isinstance(args, dict) else {}
        names = _sx_select_names(q)
        q = _spark_sql(q, params)
        if re.match(r"(?is)^\s*(\(|select\b|with\b|from\b|values\b|table\b)", q):
            a = _new_id()
            df = DataFrame(self, f"({q}) AS {_qi(a)}", {a}, a)
            if names and len(names) == len(df.columns) and [n.lower() for n in names] != [c.lower() for c in df.columns]:
                a2 = _new_id()
                cols = ", ".join(_qi(n) for n in names)
                df = DataFrame(self, f"({q}) AS {_qi(a2)}({cols})", {a2}, a2)
            return df
        res = _run(q)
        if res["columns"] and res["rows"] and not re.match(r"(?is)^\s*(insert|create|drop|alter|delete|update|truncate)\b", q):
            return self.createDataFrame([tuple(r) for r in res["rows"]], res["columns"])
        return self._empty_result()

    def range(self, start, end=None, step=1, numPartitions=None):
        if end is None:
            start, end = 0, start
        a = _new_id()
        return DataFrame(self, f"(SELECT range AS id FROM range({int(start)}, {int(end)}, {int(step)})) AS {_qi(a)}", {a}, a)

    def createDataFrame(self, data, schema=None, samplingRatio=None, verifySchema=True):
        if isinstance(data, DataFrame):
            return data
        rows = list(data)
        names, types_ = None, None
        if isinstance(schema, StructType):
            names, types_ = schema.fieldNames(), [f.dataType._duck() for f in schema.fields]
        elif isinstance(schema, DataType):
            names, types_ = ["value"], [schema._duck()]
        elif isinstance(schema, str):
            if re.fullmatch(r"\s*\w+\s*", schema) and schema.strip().lower() in _SPARK_TYPE_ALIASES:
                names, types_ = ["value"], [_parse_spark_type(schema)._duck()]
            else:
                st = _parse_ddl(schema)
                names, types_ = st.fieldNames(), [f.dataType._duck() for f in st.fields]
        elif isinstance(schema, (list, tuple)):
            names = [str(s) for s in schema]
        first_row = rows[0] if rows else None
        if rows and isinstance(first_row, Row) and first_row._fields:
            names = names or list(first_row._fields)
            tuples = [tuple(r) for r in rows]
        elif rows and isinstance(first_row, dict):
            names = names or list(first_row.keys())
            tuples = [tuple(r.get(n) for n in names) for r in rows]
        elif rows and not isinstance(first_row, (tuple, list)):
            tuples = [(x,) for x in rows]
            names = names or ["value"]
        else:
            tuples = [tuple(r) for r in rows]
        if not rows:
            if not types_:
                raise PySparkValueError("[CANNOT_INFER_EMPTY_SCHEMA] Can not infer schema from an empty dataset.")
            sql = "SELECT " + ", ".join(f"CAST(NULL AS {t}) AS {_qi(n)}" for n, t in zip(names, types_)) + " WHERE false"
        else:
            width = len(tuples[0])
            if names is None:
                names = [f"_{i + 1}" for i in range(width)]
            if any(len(t) != len(names) for t in tuples):
                raise PySparkValueError("[LENGTH_SHOULD_BE_THE_SAME] Each row needs one value per column.")
            values = ", ".join("(" + ", ".join(_lit_sql(v, data=True) for v in t) + ")" for t in tuples)
            sql = f"SELECT * FROM (VALUES {values}) AS __v({', '.join(_qi(n) for n in names)})"
            if types_:
                sql = ("SELECT " + ", ".join(f"CAST({_qi(n)} AS {t}) AS {_qi(n)}" for n, t in zip(names, types_))
                       + f" FROM ({sql}) AS __v2")
        a = _new_id()
        return DataFrame(self, f"({sql}) AS {_qi(a)}", {a}, a)


spark = SparkSession()


class _DeltaTable:
    @classmethod
    def _unavailable(cls, *a, **k):
        raise NotAvailableInTrainer("Delta Lake's Python API (DeltaTable) needs a Databricks cluster. "
                                    "Practise it in the Delta pattern exercises.")

    forName = forPath = isDeltaTable = createIfNotExists = create = _unavailable


class StorageLevel:
    MEMORY_ONLY = "MEMORY_ONLY"
    MEMORY_AND_DISK = "MEMORY_AND_DISK"
    DISK_ONLY = "DISK_ONLY"
    MEMORY_AND_DISK_DESER = "MEMORY_AND_DISK_DESER"
    OFF_HEAP = "OFF_HEAP"


# --------------------------------------------------------------------------- display and host API

def display(obj=None, *args, **kwargs):
    """Databricks notebook display(): renders a DataFrame as a table (first 1,000 rows)."""
    if isinstance(obj, DataFrame):
        rows = obj.take(1000)
        payload = {"columns": obj.columns, "rows": [[None if v is None else _show_str(v) for v in r] for r in rows]}
        if _host["display"] is not None:
            _host["display"](json.dumps(payload))
        else:
            print(_show_table(obj.columns, rows, False, False, False, 1000))
    else:
        print(obj)


def _install_modules():
    M = _pytypes.ModuleType
    pyspark = M("pyspark")
    sql = M("pyspark.sql")
    functions = M("pyspark.sql.functions")
    window = M("pyspark.sql.window")
    types_mod = M("pyspark.sql.types")
    utils = M("pyspark.sql.utils")
    errors = M("pyspark.errors")
    delta = M("delta")
    delta_tables = M("delta.tables")
    dlt = M("dlt")

    functions.__dict__.update(_F)
    window.Window, window.WindowSpec = Window, WindowSpec
    for name in ("DataType", "StringType", "IntegerType", "LongType", "ShortType", "ByteType", "DoubleType",
                 "FloatType", "BooleanType", "DateType", "TimestampType", "NullType", "DecimalType", "ArrayType",
                 "MapType", "StructField", "StructType", "Row"):
        setattr(types_mod, name, globals()[name])
    for mod in (utils, errors):
        mod.AnalysisException = AnalysisException
        mod.PySparkTypeError = PySparkTypeError
        mod.PySparkValueError = PySparkValueError
    for name, obj in dict(SparkSession=SparkSession, DataFrame=DataFrame, Column=Column, Row=Row, Window=Window,
                          WindowSpec=WindowSpec, GroupedData=GroupedData, DataFrameWriter=DataFrameWriter,
                          DataFrameReader=DataFrameReader, functions=functions, types=types_mod,
                          window=window, utils=utils).items():
        setattr(sql, name, obj)
    pyspark.sql, pyspark.errors, pyspark.StorageLevel = sql, errors, StorageLevel
    pyspark.__version__ = "3.5.0"
    delta.tables, delta_tables.DeltaTable = delta_tables, _DeltaTable

    def _dlt_unavailable(*a, **k):
        raise NotAvailableInTrainer("Lakeflow Declarative Pipelines (dlt) run as pipelines on Databricks, not in a notebook. "
                                    "See the Production lessons and pattern exercises.")
    for n in ("table", "view", "expect", "expect_or_drop", "expect_or_fail", "read", "read_stream"):
        setattr(dlt, n, _dlt_unavailable)

    sys.modules.update({
        "pyspark": pyspark, "pyspark.sql": sql, "pyspark.sql.functions": functions,
        "pyspark.sql.window": window, "pyspark.sql.types": types_mod, "pyspark.sql.utils": utils,
        "pyspark.errors": errors, "delta": delta, "delta.tables": delta_tables, "dlt": dlt,
    })


_install_modules()


def setup(query_json, display_hook=None):
    _host["query"], _host["display"] = query_json, display_hook
    _run("SET default_null_order = 'nulls_first_on_asc_last_on_desc'")


def new_namespace():
    return {"__name__": "__main__", "spark": spark, "display": display}


CELL_TIMEOUT = 30  # seconds a cell may run before it is stopped


class CellTimeout(BaseException):
    """Raised inside user code that runs too long. A BaseException, so `except Exception` can't swallow it."""


def run_cell(code, ns, timeout=None):
    """Run user code. Returns None on success, or a short traceback string limited to the user's code."""
    limit = CELL_TIMEOUT if timeout is None else timeout
    deadline = time.monotonic() + limit

    def local(frame, event, arg):
        if time.monotonic() > deadline:
            raise CellTimeout(f"The cell was stopped after {limit} seconds. Check for an infinite loop, "
                              "or limit the data (for example .limit(1000)) before processing it.")
        return local

    def tracer(frame, event, arg):
        return local if frame.f_code.co_filename == "<cell>" else None

    try:
        sys.settrace(tracer)
        try:
            exec(compile(code, "<cell>", "exec"), ns)
        finally:
            sys.settrace(None)
        return None
    except SyntaxError as e:
        line = (e.text or "").rstrip()
        return f"SyntaxError: {e.msg} (line {e.lineno})" + (f"\n    {line.strip()}" if line else "")
    except BaseException as e:  # noqa: BLE001 - we report every error to the learner
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == "<cell>"]
        lines = code.splitlines()
        out = []
        for f in frames[-3:]:
            src = lines[f.lineno - 1].strip() if 0 < f.lineno <= len(lines) else ""
            out.append(f"  line {f.lineno}: {src}")
        msg = str(e)
        out.append(f"{type(e).__name__}: {msg}" if msg else type(e).__name__)
        return "\n".join(out)


def _norm(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        r = round(v, 4)
        return str(int(r)) if r == int(r) else repr(r)
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, Row):
        return json.dumps([_norm(x) for x in v])
    if isinstance(v, list):
        return json.dumps([_norm(x) for x in v])
    if isinstance(v, dict):
        return json.dumps({str(k): _norm(x) for k, x in v.items()})
    return str(v)


def result_json(ns, name="result"):
    """The learner's `result` DataFrame as {columns, rows (normalized), display}."""
    if name not in ns:
        return json.dumps({"error": f"Assign your final DataFrame to a variable called `{name}`."})
    v = ns[name]
    if not isinstance(v, DataFrame):
        return json.dumps({"error": f"`{name}` should be a DataFrame, but it's a {type(v).__name__}."})
    try:
        rows = v.collect()
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": f"{type(e).__name__}: {e}"})
    return json.dumps({
        "columns": v.columns,
        "rows": [[_norm(x) for x in r] for r in rows],
        "display": [[None if x is None else _show_str(x) for x in r] for r in rows],
    })
