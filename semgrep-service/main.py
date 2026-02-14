"""
Semgrep Security Scanner Microservice

Provides an HTTP API for running Semgrep static analysis on code files.
Designed to be called by ghagga for security checks on PR file contents.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Ghagga Semgrep Service", version="1.0.0")

RULES_PATH = Path(__file__).parent / "rules.yml"


class FileInput(BaseModel):
    path: str
    content: str


class ScanRequest(BaseModel):
    files: list[FileInput]
    rules_config: str = "custom"  # "custom" uses local rules.yml, "auto" uses semgrep registry


class Finding(BaseModel):
    rule_id: str
    path: str
    line: int
    message: str
    severity: str
    category: str


class ScanResponse(BaseModel):
    findings: list[Finding]
    duration_ms: int
    files_scanned: int


class HealthResponse(BaseModel):
    status: str
    semgrep_version: str


def get_semgrep_version() -> str:
    try:
        result = subprocess.run(
            ["semgrep", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def map_severity(semgrep_severity: str) -> str:
    mapping = {
        "ERROR": "error",
        "WARNING": "warning",
        "INFO": "info",
    }
    return mapping.get(semgrep_severity.upper(), "info")


def map_category(rule_id: str) -> str:
    security_rules = {
        "hardcoded-secret-generic", "sql-string-concat", "weak-crypto-md5",
        "weak-crypto-sha1", "js-eval-usage", "js-innerhtml", "python-exec",
        "python-subprocess-shell", "go-sql-format", "rust-unsafe-block",
        "path-traversal-python", "path-traversal-go", "path-traversal-node",
        "command-injection-go", "command-injection-node",
        "ssrf-python", "ssrf-node",
        "insecure-deserialize-python", "insecure-deserialize-java",
        "java-unsafe-reflection", "log-injection",
    }
    if rule_id in security_rules:
        return "security"
    if rule_id == "test-todo-skip":
        return "quality"
    return "security"


def parse_semgrep_output(output: dict[str, Any]) -> list[Finding]:
    findings: list[Finding] = []
    for result in output.get("results", []):
        check_id = result.get("check_id", "unknown")
        # Strip path prefix if present (e.g., "rules.hardcoded-secret-generic")
        if "." in check_id:
            check_id = check_id.rsplit(".", 1)[-1]

        findings.append(Finding(
            rule_id=check_id,
            path=result.get("path", ""),
            line=result.get("start", {}).get("line", 0),
            message=result.get("extra", {}).get("message", ""),
            severity=map_severity(result.get("extra", {}).get("severity", "INFO")),
            category=map_category(check_id),
        ))

    return findings


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        semgrep_version=get_semgrep_version(),
    )


@app.post("/api/scan", response_model=ScanResponse)
async def scan(request: ScanRequest):
    if not request.files:
        return ScanResponse(findings=[], duration_ms=0, files_scanned=0)

    tmpdir = tempfile.mkdtemp(prefix="semgrep-scan-")
    start_time = time.time()

    try:
        # Write files to temporary directory
        for file_input in request.files:
            file_path = Path(tmpdir) / file_input.path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(file_input.content, encoding="utf-8")

        # Determine rules config
        if request.rules_config == "auto":
            config_arg = "auto"
        else:
            if not RULES_PATH.exists():
                raise HTTPException(status_code=500, detail="rules.yml not found")
            config_arg = str(RULES_PATH)

        # Run semgrep
        cmd = [
            "semgrep",
            "--config", config_arg,
            "--json",
            "--no-git-ignore",
            "--quiet",
            tmpdir,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )

        # Semgrep exits with code 1 when findings are present, which is expected
        if result.returncode not in (0, 1):
            raise HTTPException(
                status_code=500,
                detail=f"Semgrep error: {result.stderr[:500]}",
            )

        # Parse output
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to parse Semgrep output: {result.stdout[:200]}",
            )

        findings = parse_semgrep_output(output)

        # Normalize paths (remove tmpdir prefix)
        for finding in findings:
            if finding.path.startswith(tmpdir):
                finding.path = finding.path[len(tmpdir):].lstrip("/").lstrip("\\")

        duration_ms = int((time.time() - start_time) * 1000)

        return ScanResponse(
            findings=findings,
            duration_ms=duration_ms,
            files_scanned=len(request.files),
        )

    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Semgrep scan timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
