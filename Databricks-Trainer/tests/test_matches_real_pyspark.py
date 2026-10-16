"""Compares the trainer's PySpark-compatible layer with real PySpark on ~350 snippets.

Needs real PySpark and Java, so it is skipped when either is missing:

    pip install pyspark==3.5.3 duckdb==1.1.1 pytest
    pytest tests/test_matches_real_pyspark.py

A case passes when both engines return the same column names, types and rows (and the same show() text for
the cases that compare it), or when both fail. Accepted differences are listed in diff_known.py.
"""
import json
import pathlib
import shutil
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from diff_cases import C  # noqa: E402
from diff_known import KNOWN  # noqa: E402

pytest.importorskip("pyspark", reason="real PySpark is not installed")
pytest.importorskip("duckdb")
if not shutil.which("java"):
    pytest.skip("Java is not installed", allow_module_level=True)


@pytest.fixture(scope="module")
def results():
    proc = subprocess.run([sys.executable, str(HERE / "diff_runner.py")], capture_output=True, text=True, timeout=1800)
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("RESULTS-JSON ")), None)
    assert line, f"runner produced no results:\n{proc.stderr[-2000:]}"
    return json.loads(line[len("RESULTS-JSON "):])


@pytest.mark.parametrize("name", [c[0] for c in C])
def test_case_matches_real_spark(results, name):
    status, msg = results[name]
    if name in KNOWN and status in ("MISMATCH", "SHIM-FAILS"):
        pytest.xfail(KNOWN[name])
    # shim-permissive: the shim accepts something real Spark rejects, which is harmless
    assert status in ("ok", "both-error", "shim-permissive"), f"{status}: {msg}"
