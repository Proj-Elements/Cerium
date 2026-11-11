"""Select owning component checks from an event's complete changed-path set."""

import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
NODE_TESTS = (
    "web/test/admin-data.test.mjs",
    "web/test/changes.test.mjs",
    "web/test/favicon-state.test.mjs",
    "web/test/icon-cache.test.mjs",
    "web/test/icon-transport.test.mjs",
    "web/test/icons.test.mjs",
    "web/test/payment-presets.test.mjs",
    "web/test/server.test.mjs",
    "web/test/store-read.test.mjs",
    "web/test/validation.test.mjs",
)
IMPORT = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(|\bimport\s*|\bnew\s+URL\s*\()[\"'](\.[^\"']+)[\"']"
)


def source_dependencies(source, root):
    """Resolve local import edges, including removed inputs of surviving owners."""
    dependencies = set()
    try:
        text = (root / source).read_text(encoding="utf-8")
    except (FileNotFoundError, UnicodeDecodeError):
        return dependencies
    for imported in IMPORT.findall(text):
        candidate = (root / source).parent / imported
        if candidate.suffix:
            choices = [candidate]
        else:
            choices = [candidate.with_suffix(suffix) for suffix in (".ts", ".tsx", ".mjs", ".js", ".json")]
            choices.extend(candidate / ("index" + suffix) for suffix in (".ts", ".tsx", ".mjs", ".js"))
        for choice in choices:
            try:
                relative = choice.resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            dependencies.add(relative)
    return dependencies


def existing_node_tests(root=ROOT):
    return sorted(path.relative_to(root).as_posix() for path in (root / "web/test").glob("*.test.mjs"))


def owning_node_tests(paths, root=ROOT):
    """Find surviving unit modules that transitively import any changed source."""
    changed = set(paths)
    tests = set()
    for test in existing_node_tests(root):
        pending = [test]
        visited = set()
        while pending:
            source = pending.pop()
            if source in visited:
                continue
            visited.add(source)
            if source in changed:
                tests.add(test)
                break
            pending.extend(source_dependencies(source, root) - visited)
    return tests


def select_checks(paths, root=ROOT):
    """Return owning Node unit files and whether the Solver image is affected."""
    inputs = set(paths)
    pending = [path for path in paths if path.startswith("web/src/") and path.endswith(".tsx")]
    visited = set()
    while pending:
        source = pending.pop()
        if source in visited:
            continue
        visited.add(source)
        dependencies = source_dependencies(source, root)
        inputs.update(dependencies)
        pending.extend(dependencies - visited)
    tests = owning_node_tests(inputs, root)
    solver = False
    all_tests = set(existing_node_tests(root))
    for path in paths:
        if path.startswith(".github/"):
            tests.update(all_tests)
            solver = True
        elif path.startswith("solver/") and not path.endswith(".md"):
            solver = True
        elif path in ("web/package.json", "web/package-lock.json", "compose.yaml", "web/Dockerfile", "web/.dockerignore"):
            tests.update(all_tests)
            solver = solver or path == "compose.yaml"
        elif path.startswith("web/server/"):
            tests.update(test for test in NODE_TESTS if (root / test).is_file())
        elif path.startswith("web/test/") and path.endswith(".test.mjs") and (root / path).is_file():
            tests.add(path)
        elif path in ("web/test/fixture-server.mjs", "web/test/admin-data-fixture.mjs"):
            tests.update(test for test in NODE_TESTS if (root / test).is_file())
    return sorted(tests), solver


def select_go_packages(paths):
    """Use Go packages as ownership units so new regressions are never filtered out."""
    packages = set()
    for path in paths:
        if path.endswith(".go") and "/" not in path:
            packages.add(".")
            if not path.endswith("_test.go"):
                packages.add("./cmd/cerium")
        elif path.startswith("cmd/cerium/"):
            packages.add("./cmd/cerium")
        elif path in ("go.mod", "go.sum", "Dockerfile", ".dockerignore", "compose.yaml") or path.startswith(".github/"):
            packages.update((".", "./cmd/cerium"))
        elif path.startswith("contracts/") or path in ("web/test/fixture-server.mjs", "web/test/admin-data-fixture.mjs"):
            packages.update((".", "./cmd/cerium"))
    return sorted(packages)


def select_go(paths):
    return bool(select_go_packages(paths))


def select_frontend(paths):
    return any(
        path.startswith(("web/src/", "web/public/", "web/build-tools/", "web/scripts/", "web/test/browser/", "web/test/admin-browser/", ".github/"))
        or path in ("web/index.html", "web/vite.config.ts", "web/tsconfig.json", "web/package.json", "web/package-lock.json", "web/Dockerfile", "web/.dockerignore", "web/scripts/precompress.mjs")
        for path in paths
    )


def select_contracts(paths):
    return any(
        path.startswith(("contracts/", ".github/"))
        or path in ("types.go", "bridge.go", "web/src/types.ts", "web/src/contracts.generated.ts", "web/server/contracts.generated.mjs", "web/server/validation.mjs")
        for path in paths
    )


def select_containers(paths):
    containers = set()
    for path in paths:
        if path in ("Dockerfile", ".dockerignore"):
            containers.add("sync")
        elif path in ("web/Dockerfile", "web/.dockerignore", "web/scripts/install-premium.mjs") or path.startswith("web/build-tools/"):
            containers.add("web")
        elif path.startswith("solver/") and not path.endswith(".md"):
            containers.add("solver")
        elif path == "compose.yaml":
            containers.update(("sync", "web", "solver"))
    return sorted(containers)


def changed_paths(event_name, event, git):
    """Include both rename sides and deletions; invalid historical baselines fail."""
    if event_name == "pull_request":
        pull = event["pull_request"]
        head = pull["head"]["sha"]
        base = git("merge-base", pull["base"]["sha"], head).strip()
    elif event_name == "merge_group":
        base = event["merge_group"]["base_sha"]
        head = event["merge_group"]["head_sha"]
    elif event_name == "push":
        base, head = event["before"], event["after"]
        if base == "0" * 40:
            target = "refs/remotes/origin/" + event["repository"]["default_branch"]
            try:
                base = git("merge-base", target, head).strip()
            except subprocess.CalledProcessError:
                base = head
            if base == head:
                return git("ls-tree", "-r", "--name-only", "-z", head).split("\0")[:-1]
    else:
        raise ValueError("Unsupported CI event: " + event_name)
    return git("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head).split("\0")[:-1]


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())

    def git(*args):
        return subprocess.check_output(["git", *args], text=True)

    paths = changed_paths(os.environ["GITHUB_EVENT_NAME"], event, git)
    tests, solver = select_checks(paths)
    go_packages = select_go_packages(paths)
    selection = {
        "node_tests": tests,
        "go": bool(go_packages),
        "go_packages": go_packages,
        "solver": solver,
        "frontend": select_frontend(paths),
        "contracts": select_contracts(paths),
        "containers": select_containers(paths),
    }
    print(json.dumps({"changed_files": paths, **selection}))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for name, value in selection.items():
            output.write(name + "=" + json.dumps(value, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
