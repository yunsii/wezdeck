#!/usr/bin/env python3
"""Validate a `ticket api` JSON response (stdin) against schema/<cmd>.schema.json.

Usage: ticket api <cmd> … | python3 lib/validate_api.py <cmd>
Exit 0 valid · 1 invalid · 2 validator unavailable (jsonschema not installed).
"""
import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("jsonschema not installed", file=sys.stderr)
    sys.exit(2)

schema_dir = Path(__file__).resolve().parent.parent / "schema"
docs = {}
for p in schema_dir.glob("*.schema.json"):
    doc = json.loads(p.read_text(encoding="utf-8"))
    docs[p.name] = doc
    docs[doc["$id"]] = doc
cmd = sys.argv[1]
schema = docs[f"{cmd}.schema.json"]
data = json.load(sys.stdin)
try:
    validator = jsonschema.Draft202012Validator(schema)
    validator.validate(data)
except jsonschema.ValidationError as exc:
    print(f"{cmd}: {exc.message} at {list(exc.absolute_path)}", file=sys.stderr)
    sys.exit(1)
