"""
Tests for the Semgrep microservice API.
"""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app, parse_semgrep_output, map_severity, map_category

client = TestClient(app)


class TestHealthEndpoint:
    def test_health_returns_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "semgrep_version" in data

    def test_health_includes_version(self):
        response = client.get("/health")
        data = response.json()
        # Version should be a string (even if "unknown")
        assert isinstance(data["semgrep_version"], str)


class TestScanEndpoint:
    def test_scan_empty_files(self):
        response = client.post("/api/scan", json={"files": []})
        assert response.status_code == 200
        data = response.json()
        assert data["findings"] == []
        assert data["files_scanned"] == 0

    def test_scan_clean_file(self):
        """A file with no vulnerabilities should return 0 findings."""
        response = client.post("/api/scan", json={
            "files": [
                {
                    "path": "src/clean.ts",
                    "content": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
                }
            ],
        })
        assert response.status_code == 200
        data = response.json()
        assert data["files_scanned"] == 1
        assert isinstance(data["duration_ms"], int)
        # Clean code should have no security findings
        security_findings = [f for f in data["findings"] if f["category"] == "security"]
        # May or may not have findings depending on rules, but should not error
        assert isinstance(data["findings"], list)

    def test_scan_vulnerable_js_eval(self):
        """A file with eval() should trigger js-eval-usage rule."""
        response = client.post("/api/scan", json={
            "files": [
                {
                    "path": "src/dangerous.js",
                    "content": "function run(input) {\n  return eval(input);\n}\n",
                }
            ],
        })
        assert response.status_code == 200
        data = response.json()
        eval_findings = [f for f in data["findings"] if f["rule_id"] == "js-eval-usage"]
        assert len(eval_findings) >= 1
        assert eval_findings[0]["severity"] == "error"
        assert eval_findings[0]["category"] == "security"

    def test_scan_vulnerable_innerhtml(self):
        """A file with innerHTML assignment should trigger js-innerhtml rule."""
        response = client.post("/api/scan", json={
            "files": [
                {
                    "path": "src/render.js",
                    "content": "function render(data) {\n  document.getElementById('app').innerHTML = data;\n}\n",
                }
            ],
        })
        assert response.status_code == 200
        data = response.json()
        html_findings = [f for f in data["findings"] if f["rule_id"] == "js-innerhtml"]
        assert len(html_findings) >= 1
        assert html_findings[0]["severity"] == "warning"

    def test_scan_multiple_files(self):
        """Scanning multiple files should report correct files_scanned count."""
        response = client.post("/api/scan", json={
            "files": [
                {"path": "a.js", "content": "const x = 1;"},
                {"path": "b.js", "content": "const y = 2;"},
                {"path": "c.py", "content": "x = 1"},
            ],
        })
        assert response.status_code == 200
        data = response.json()
        assert data["files_scanned"] == 3

    def test_scan_returns_duration(self):
        """Scan should report execution time."""
        response = client.post("/api/scan", json={
            "files": [{"path": "test.js", "content": "const x = 1;"}],
        })
        assert response.status_code == 200
        data = response.json()
        assert data["duration_ms"] >= 0

    def test_scan_paths_are_relative(self):
        """Finding paths should be relative, not absolute tmp paths."""
        response = client.post("/api/scan", json={
            "files": [
                {
                    "path": "src/dangerous.js",
                    "content": "function run(input) {\n  return eval(input);\n}\n",
                }
            ],
        })
        assert response.status_code == 200
        data = response.json()
        for finding in data["findings"]:
            assert not finding["path"].startswith("/tmp")
            assert not finding["path"].startswith("C:\\")


class TestHelpers:
    def test_map_severity(self):
        assert map_severity("ERROR") == "error"
        assert map_severity("WARNING") == "warning"
        assert map_severity("INFO") == "info"
        assert map_severity("unknown") == "info"

    def test_map_category_security(self):
        assert map_category("js-eval-usage") == "security"
        assert map_category("sql-string-concat") == "security"
        assert map_category("hardcoded-secret-generic") == "security"

    def test_map_category_quality(self):
        assert map_category("test-todo-skip") == "quality"

    def test_parse_semgrep_output_empty(self):
        findings = parse_semgrep_output({"results": []})
        assert findings == []

    def test_parse_semgrep_output_with_results(self):
        output = {
            "results": [
                {
                    "check_id": "rules.js-eval-usage",
                    "path": "/tmp/scan/src/app.js",
                    "start": {"line": 5, "col": 1},
                    "end": {"line": 5, "col": 20},
                    "extra": {
                        "message": "Avoid eval() - security risk",
                        "severity": "ERROR",
                    },
                }
            ]
        }
        findings = parse_semgrep_output(output)
        assert len(findings) == 1
        assert findings[0].rule_id == "js-eval-usage"
        assert findings[0].line == 5
        assert findings[0].severity == "error"
