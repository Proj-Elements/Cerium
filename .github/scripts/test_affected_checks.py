"""Guard focused CI selection and event-baseline handling without network access."""

import subprocess
import unittest
from unittest.mock import Mock

from affected_checks import NODE_TESTS, changed_paths, select_checks


class SelectionTests(unittest.TestCase):
    def test_documents_do_not_run_application_suites(self):
        self.assertEqual(select_checks(["README.md", "solver/README.md"]), ([], False))

    def test_changed_owners_include_deleted_paths(self):
        tests, solver = select_checks(
            ["web/server/backup.mjs", "web/src/group-preview.ts", "solver/Dockerfile"]
        )
        self.assertEqual(tests, sorted((*NODE_TESTS, "web/test/group-preview.test.mjs")))
        self.assertTrue(solver)
        self.assertEqual(select_checks(["web/test/icons.test.mjs"]), (["web/test/icons.test.mjs"], False))

    def test_ci_changes_validate_every_declared_job(self):
        tests, solver = select_checks([".github/workflows/ci.yml"])
        self.assertEqual(len(tests), 8)
        self.assertTrue(solver)

    def test_pull_request_uses_target_merge_base(self):
        git = Mock(side_effect=["merge-base\n", "web/server/store.mjs\0"])
        paths = changed_paths(
            "pull_request", {"pull_request": {"base": {"sha": "base"}, "head": {"sha": "head"}}}, git
        )
        self.assertEqual(paths, ["web/server/store.mjs"])
        git.assert_any_call("merge-base", "base", "head")
        git.assert_any_call("diff", "--no-ext-diff", "--name-only", "-z", "merge-base", "head")

    def test_push_and_queue_use_their_exact_baselines(self):
        for name, event in (
            ("push", {"before": "before", "after": "head"}),
            ("merge_group", {"merge_group": {"base_sha": "before", "head_sha": "head"}}),
        ):
            git = Mock(return_value="solver/runner.py\0")
            self.assertEqual(changed_paths(name, event, git), ["solver/runner.py"])
            git.assert_called_once_with("diff", "--no-ext-diff", "--name-only", "-z", "before", "head")

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
