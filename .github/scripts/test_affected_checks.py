"""Guard focused CI selection and event-baseline handling without network access."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from affected_checks import (
    NODE_TESTS,
    ROOT,
    changed_paths,
    existing_node_tests,
    select_checks,
    select_containers,
    select_contracts,
    select_frontend,
    select_go,
    select_go_packages,
)


class SelectionTests(unittest.TestCase):
    def test_documents_do_not_run_application_suites(self):
        self.assertEqual(select_checks(["README.md", "solver/README.md"]), ([], False))
        self.assertFalse(select_go(["README.md", "solver/README.md"]))

    def test_every_go_source_and_test_selects_its_package(self):
        for source in ROOT.glob("*.go"):
            with self.subTest(source=source.name):
                self.assertIn(".", select_go_packages([source.name]))
        for source in (ROOT / "cmd/cerium").rglob("*.go"):
            with self.subTest(source=source.name):
                self.assertEqual(select_go_packages([source.relative_to(ROOT).as_posix()]), ["./cmd/cerium"])
        self.assertEqual(select_go_packages(["future.go"]), [".", "./cmd/cerium"])
        self.assertEqual(select_go_packages(["new_probe_test.go"]), ["."])
        self.assertFalse(select_go(["web/src/Catalog.tsx"]))

    def test_shared_go_inputs_select_only_actual_dependent_packages(self):
        for path in ["go.mod", "go.sum", "Dockerfile", ".dockerignore", "compose.yaml", ".github/workflows/ci.yml", "contracts/wire.schema.json"]:
            with self.subTest(path=path):
                self.assertEqual(select_go_packages([path]), [".", "./cmd/cerium"])

    def test_changed_owners_include_deleted_paths(self):
        tests, solver = select_checks(
            ["web/server/backup.mjs", "web/src/group-preview.ts", "solver/Dockerfile"]
        )
        self.assertTrue(set(NODE_TESTS).issubset(tests))
        self.assertIn("web/test/group-preview.test.mjs", tests)
        self.assertTrue(solver)
        self.assertEqual(select_checks(["web/test/icons.test.mjs"]), (["web/test/icons.test.mjs"], False))

    def test_ci_changes_validate_every_declared_job(self):
        tests, solver = select_checks([".github/workflows/ci.yml"])
        self.assertEqual(tests, existing_node_tests())
        self.assertTrue(solver)
        self.assertTrue(select_frontend([".github/workflows/ci.yml"]))
        self.assertTrue(select_contracts([".github/workflows/ci.yml"]))

    def test_icon_tls_fixture_selects_its_owning_transport_tests(self):
        self.assertEqual(select_checks(["web/test/fixtures/icon-tls.mjs"]), (["web/test/icon-transport.test.mjs"], False))

    def test_frontend_unit_modules_and_data_select_transitive_owners(self):
        for source, expected in [
            ("web/src/groups.ts", "web/test/groups.test.mjs"),
            ("web/src/model-pricing.ts", "web/test/model-pricing.test.mjs"),
            ("web/src/data/model-prices.json", "web/test/model-pricing.test.mjs"),
            ("web/src/model-display.ts", "web/test/model-display.test.mjs"),
            ("web/src/group-preview.ts", "web/test/group-preview.test.mjs"),
        ]:
            with self.subTest(source=source):
                self.assertIn(expected, select_checks([source])[0])
                self.assertTrue(select_frontend([source]))
        for source in ["web/src/Admin.tsx", "web/src/Catalog.tsx", "web/src/styles.css", "web/public/assets/theme-init.v1.js", "web/vite.config.ts", "web/Dockerfile"]:
            self.assertTrue(select_frontend([source]))
        self.assertIn("web/test/groups.test.mjs", select_checks(["web/src/Catalog.tsx"])[0])
        self.assertIn("web/test/model-pricing.test.mjs", select_checks(["web/src/ModelPrice.tsx"])[0])

    def test_new_helpers_and_regressions_are_discovered_without_mapping_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "web/test").mkdir(parents=True)
            (root / "web/src").mkdir(parents=True)
            (root / "web/test/new.test.mjs").write_text('import { value } from "../src/helper.ts";', encoding="utf-8")
            (root / "web/src/helper.ts").write_text('export { value } from "./deleted.ts";', encoding="utf-8")
            (root / "web/test/unrelated.test.mjs").write_text('import "../src/other.ts";', encoding="utf-8")
            for changed in ["web/src/helper.ts", "web/src/deleted.ts", "web/test/new.test.mjs"]:
                self.assertEqual(select_checks([changed], root), (["web/test/new.test.mjs"], False))
            self.assertEqual(select_checks(["web/test/deleted.test.mjs"], root), ([], False))

    def test_container_paths_select_component_validation(self):
        self.assertEqual(select_containers(["Dockerfile"]), ["sync"])
        self.assertEqual(select_containers(["web/.dockerignore"]), ["web"])
        self.assertEqual(select_containers(["solver/requirements.lock"]), ["solver"])
        self.assertEqual(select_containers(["compose.yaml"]), ["solver", "sync", "web"])
        self.assertTrue(select_checks(["web/Dockerfile"])[0])
        self.assertTrue(select_checks(["compose.yaml"])[1])

    def test_dotted_extensionless_helpers_keep_their_owning_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "web/test").mkdir(parents=True)
            (root / "web/src").mkdir(parents=True)
            (root / "web/test/generated.test.mjs").write_text('import "../src/contracts.generated";', encoding="utf-8")
            (root / "web/src/contracts.generated.ts").write_text('export const version = 1;', encoding="utf-8")
            self.assertEqual(select_checks(["web/src/contracts.generated.ts"], root), (["web/test/generated.test.mjs"], False))

    def test_pull_request_uses_target_merge_base(self):
        git = Mock(side_effect=["merge-base\n", "web/server/store.mjs\0"])
        paths = changed_paths(
            "pull_request", {"pull_request": {"base": {"sha": "base"}, "head": {"sha": "head"}}}, git
        )
        self.assertEqual(paths, ["web/server/store.mjs"])
        git.assert_any_call("merge-base", "base", "head")
        git.assert_any_call("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "merge-base", "head")

    def test_push_and_queue_use_their_exact_baselines(self):
        for name, event in (
            ("push", {"before": "before", "after": "head"}),
            ("merge_group", {"merge_group": {"base_sha": "before", "head_sha": "head"}}),
        ):
            git = Mock(return_value="solver/runner.py\0")
            self.assertEqual(changed_paths(name, event, git), ["solver/runner.py"])
            git.assert_called_once_with("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "before", "head")

    def test_rename_keeps_both_the_old_and_new_owners(self):
        git = Mock(return_value="web/src/groups.ts\0web/server/groups.mjs\0web/test/removed.test.mjs\0")
        paths = changed_paths("push", {"before": "base", "after": "head"}, git)
        self.assertIn("web/src/groups.ts", paths)
        self.assertIn("web/server/groups.mjs", paths)
        self.assertIn("web/test/groups.test.mjs", select_checks(paths)[0])
        self.assertNotIn("web/test/removed.test.mjs", select_checks(paths)[0])

    def test_new_branch_uses_main_or_the_initial_snapshot(self):
        event = {"before": "0" * 40, "after": "head", "repository": {"default_branch": "main"}}
        git = Mock(side_effect=["base\n", "web/server/store.mjs\0"])
        self.assertEqual(changed_paths("push", event, git), ["web/server/store.mjs"])
        git.assert_any_call("merge-base", "refs/remotes/origin/main", "head")
        git = Mock(side_effect=[subprocess.CalledProcessError(1, "git"), "solver/Dockerfile\0"])
        self.assertEqual(changed_paths("push", event, git), ["solver/Dockerfile"])
        git.assert_any_call("ls-tree", "-r", "--name-only", "-z", "head")

    def test_invalid_baselines_and_unknown_events_cannot_pass(self):
        git = Mock(side_effect=subprocess.CalledProcessError(128, "git"))
        with self.assertRaises(subprocess.CalledProcessError):
            changed_paths("push", {"before": "missing", "after": "head"}, git)
        with self.assertRaises(ValueError):
            changed_paths("workflow_dispatch", {}, git)


if __name__ == "__main__":
    unittest.main()
