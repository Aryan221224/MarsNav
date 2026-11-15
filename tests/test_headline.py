"""Headline numbers, checked a second way: the intervals in validation/results/headline.json against scipy, and the
test counts quoted in the README and the submission against the test suites themselves (Node tests counted in the
files, pytest by its own collection). Run: python -m pytest tests -q"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import pytest
from scipy import stats

ROOT = Path(__file__).resolve().parent.parent
H = json.loads((ROOT / "validation" / "results" / "headline.json").read_text())


def wilson(k, n, z=stats.norm.ppf(0.975)):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def clopper_pearson(k, n, alpha=0.05):
    lo = 0.0 if k == 0 else stats.beta.ppf(alpha / 2, k, n - k + 1)
    hi = 1.0 if k == n else stats.beta.ppf(1 - alpha / 2, k + 1, n - k)
    return lo, hi


@pytest.mark.parametrize("key", ["slope", "false_nogo", "detour"])
def test_wilson_intervals_match_scipy(key):
    h = H[key]
    lo, hi = wilson(h["k"], h["n"])
    assert h["ci95_pct"] == [round(100 * lo, 1), round(100 * hi, 1)]


def test_closed_loop_exact_intervals_and_sign_test_match_scipy():
    c = H["closed_loop"]
    for k, field in ((c["closed_dips"], "closed_ci95_pct"), (c["open_dips"], "open_ci95_pct")):
        lo, hi = clopper_pearson(k, c["runs"])
        assert c[field] == [round(100 * lo, 1), round(100 * hi, 1)]
    p = stats.binomtest(c["open_dips"] - c["closed_dips"], c["open_dips"] - c["closed_dips"], 0.5).pvalue
    assert abs(c["sign_test_p"] - p) < 1e-15


def count_node_tests():
    return sum(len(re.findall(r"^\s*test\(", f.read_text(), re.M)) for f in (ROOT / "tests").glob("*.test.mjs"))


def count_pytest_tests():
    out = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", str(ROOT / "tests")],
                         capture_output=True, text=True, cwd=ROOT, timeout=300).stdout
    m = re.search(r"(\d+) tests? collected", out)
    assert m, out[-500:]
    return int(m.group(1))


def test_documented_test_counts_match_the_suites():
    node, py = count_node_tests(), count_pytest_tests()
    docs = {
        "README.md": ROOT / "README.md",
        "PROJECT_SUBMISSION.md": ROOT / "submission" / "PROJECT_SUBMISSION.md",
        "project_details.html": ROOT / "submission" / "project_details.html",
        "judging_criteria_map.md": ROOT / "submission" / "judging_criteria_map.md",
    }
    for name, path in docs.items():
        t = path.read_text()
        assert f"{node + py} automated tests" in t, f"{name}: total should be {node + py}"
        assert f"{node} engine" in t, f"{name}: Node count should be {node}"
        assert f"{py} pipeline" in t, f"{name}: pytest count should be {py}"
    # the README's test badge too
    assert f"tests-{node + py}%20passing" in docs["README.md"].read_text(), f"README badge should say {node + py}"
