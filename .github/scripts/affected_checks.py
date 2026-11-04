"""Select the existing API/data and Solver regressions affected by a GitHub event."""

import json
import os
import subprocess
from pathlib import Path


NODE_TESTS = (
    "web/test/admin-data.test.mjs",
    "web/test/changes.test.mjs",
    "web/test/favicon-state.test.mjs",
    "web/test/icons.test.mjs",
    "web/test/server.test.mjs",
    "web/test/store-read.test.mjs",
    "web/test/validation.test.mjs",
)


def select_checks(paths):
    """Return owning Node test files and whether the Solver image needs testing."""
    tests = set()
    solver = False
    for path in paths:
        if path.startswith(".github/"):
            tests.update(NODE_TESTS)
            tests.add("web/test/group-preview.test.mjs")
            solver = True
        elif path.startswith("solver/") and not path.endswith(".md"):
            solver = True
        elif path.startswith("web/server/") or path in (
            "web/package.json",
            "web/package-lock.json",
        ):
            tests.update(NODE_TESTS)
        elif path.startswith("web/test/") and path.endswith(".test.mjs"):
            tests.add(path)
        elif path == "web/src/group-preview.ts":
            tests.add("web/test/group-preview.test.mjs")
    return sorted(tests), solver


def changed_paths(event_name, event, git):
    """Resolve an event's real diff; a new default branch checks its whole snapshot."""
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
    # Missing history must fail rather than turn into an empty, passing selection.
    return git("diff", "--no-ext-diff", "--name-only", "-z", base, head).split("\0")[:-1]


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())

    def git(*args):
        return subprocess.check_output(["git", *args], text=True)

    paths = changed_paths(os.environ["GITHUB_EVENT_NAME"], event, git)
    tests, solver = select_checks(paths)
    print(json.dumps({"changed_files": paths, "node_tests": tests, "solver": solver}))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("node_tests=" + json.dumps(tests) + "\n")
        output.write("solver=" + str(solver).lower() + "\n")


if __name__ == "__main__":
    main()
