"""Bundle the trainer into a single HTML page (CSS and JS inlined) for hosts that
wrap the page in their own document skeleton, such as a claude.ai Artifact.

Usage: python3 tools/build_artifact.py OUT_DIR
Writes OUT_DIR/index.html. Put the gzipped DuckDB .wasm in OUT_DIR/duckdb/ and the Pyodide
runtime files in OUT_DIR/pyodide/ (see README), and publish them alongside the page.
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

html = (root / "index.html").read_text()
css = (root / "css/styles.css").read_text()
body = re.search(r"<body>(.*?)\s*<script", html, re.S).group(1).strip()
title = re.search(r"<title>.*?</title>", html).group(0)
fonts = re.search(r'<link rel="stylesheet" href="https://fonts[^>]+>', html).group(0)
scripts = "\n".join(
    f"<script>\n{(root / src).read_text()}\n</script>"
    for src in re.findall(r'<script src="([^"]+)"></script>', html)
)

shim = json.dumps((root / "py/pyspark_shim.py").read_text()).replace("</", "<\\/")

page = f"""{title}
<meta name="claude:viewport-fit-sides" content="cover">
{fonts}
<style>
{css}
</style>
{body}
<script>window.TRAINER_DUCKDB_LOCAL = "duckdb/"; window.TRAINER_PYODIDE_LOCAL = "pyodide/";</script>
{scripts}
<script>TRAINER.pysparkShimSource = {shim};</script>
"""
(out / "index.html").write_text(page)
print("wrote", out / "index.html", len(page), "bytes")
