"""Generate the runtime DTOs and validators from the shared wire schema."""

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "contracts/wire.schema.json").read_text())
DEFINITIONS = SCHEMA["$defs"]
TS_NAMES = {"ModelPrice": "Price"}


def type_name(name, language):
    return DEFINITIONS[name].get("x-goName", name) if language == "go" else TS_NAMES.get(name, name)


def field_type(field, language):
    override = field.get("x-goType" if language == "go" else "x-tsType")
    if override:
        return override
    if "$ref" in field:
        name = type_name(field["$ref"].split("/")[-1], language)
        return ("*" if language == "go" and field.get("x-goPointer") else "") + name
    kind = field["type"]
    kinds = kind if isinstance(kind, list) else [kind]
    if language == "ts":
        if "enum" in field:
            return " | ".join(json.dumps(value) for value in field["enum"])
        types = {"string": "string", "number": "number", "integer": "number", "boolean": "boolean", "null": "null"}
        return " | ".join("(" + field_type(field["items"], language) + ")[]" if item == "array" else types[item] for item in kinds)
    actual = next(item for item in kinds if item != "null")
    if actual == "array":
        return "[]" + field_type(field["items"], language)
    primitive = {"string": "string", "number": "float64", "integer": "int64", "boolean": "bool"}[actual]
    return ("*" if "null" in kinds else "") + primitive


def generate_go():
    lines = ["package contracts", '', 'import "time"', '']
    for name, definition in DEFINITIONS.items():
        if definition.get("x-validateOnly"):
            continue
        lines.append("type " + type_name(name, "go") + " struct {")
        for key, field in definition["properties"].items():
            go_name = field.get("x-goName", "".join(word.title() for word in key.split("_")))
            optional = key not in definition.get("required", []) and field.get("x-goOmitEmpty", True)
            tag = key + (",omitempty" if optional else "")
            lines.append(f'\t{go_name} {field_type(field, "go")} `json:"{tag}"`')
        lines.append("}\n")
    lines.append("const wireSchema = `" + json.dumps(SCHEMA, separators=(",", ":"), ensure_ascii=False) + "`\n")
    for name, definition in DEFINITIONS.items():
        if definition.get("x-validateOnly"):
            continue
        go_name = type_name(name, "go")
        lines.extend([f"func Validate{go_name}(value *{go_name}) error {{", f'\treturn Validate("{name}", value)', "}\n"])
    source = "\n".join(lines).encode()
    return subprocess.check_output(["gofmt"], input=source).decode()


def generate_ts():
    lines = []
    for name, definition in DEFINITIONS.items():
        if definition.get("x-validateOnly"):
            continue
        lines.append("export type " + type_name(name, "ts") + " = {")
        for key, field in definition["properties"].items():
            optional = key not in definition.get("required", []) and not field.get("x-tsRequired")
            lines.append(f"  {key}{'?' if optional else ''}: {field_type(field, 'ts')};")
        lines.append("};\n")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    outputs = {
        ROOT / "contracts/types.generated.go": generate_go(),
        ROOT / "web/src/contracts.generated.ts": generate_ts(),
        ROOT / "web/server/contracts.generated.mjs": "export const wireSchema = " + json.dumps(SCHEMA, ensure_ascii=False, indent=2) + ";\n\n" + (ROOT / "contracts/validator.mjs.in").read_text(),
    }
    stale = []
    for target, content in outputs.items():
        if arguments.check:
            if not target.exists() or target.read_text() != content:
                stale.append(str(target.relative_to(ROOT)))
        else:
            target.write_text(content)
    if stale:
        parser.exit(1, "Generated contract files are stale: " + ", ".join(stale) + "\nRun python3 contracts/generate.py\n")


if __name__ == "__main__":
    main()
