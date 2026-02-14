# Semgrep Security Scanner Service

Microservice that wraps Semgrep for security scanning, designed to be called by ghagga during code reviews.

## Endpoints

### `GET /health`

Health check endpoint.

```json
{
  "status": "ok",
  "semgrep_version": "1.90.0"
}
```

### `POST /api/scan`

Scan files for security issues.

**Request:**
```json
{
  "files": [
    { "path": "src/app.ts", "content": "const secret = 'abc123';" }
  ],
  "rules_config": "custom"
}
```

**Response:**
```json
{
  "findings": [
    {
      "rule_id": "hardcoded-secret-generic",
      "path": "src/app.ts",
      "line": 1,
      "message": "Possible hardcoded secret. Use environment variables.",
      "severity": "error",
      "category": "security"
    }
  ],
  "duration_ms": 1200,
  "files_scanned": 1
}
```

## Rules

The service uses `rules.yml` with 22 Semgrep rules covering:

- **Secrets:** hardcoded credentials
- **SQL Injection:** string concatenation in queries
- **XSS:** innerHTML, eval usage
- **Path Traversal:** unsanitized file paths
- **Command Injection:** shell command execution
- **SSRF:** unvalidated URL fetching
- **Insecure Deserialization:** pickle, yaml.load, ObjectInputStream
- **Weak Crypto:** MD5, SHA-1

Languages: Java, Kotlin, JavaScript, TypeScript, Python, Go, Rust.

## Deploy

### Railway

```bash
cd semgrep-service
railway login
railway init
railway up
```

### Fly.io

```bash
fly launch --name ghagga-semgrep
fly deploy
```

### Docker (local development)

```bash
docker build -t ghagga-semgrep .
docker run -p 8080:8080 ghagga-semgrep
```

## Adding Custom Rules

Edit `rules.yml` following the [Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/overview/).

## Tests

```bash
pip install pytest httpx
pytest test_main.py -v
```
