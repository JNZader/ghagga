# OpenHands Integration Research

## Status: ON HOLD — Waiting for V1

The OpenHands Resolver (V0) is tagged as "Legacy V0" with deprecation scheduled for April 2026. V1 is being built on the Software Agent SDK (https://github.com/OpenHands/software-agent-sdk). We will wait for V1 stabilization before implementing.

## What is OpenHands

- MIT-licensed open platform for AI coding agents (formerly OpenDevin)
- 25k+ GitHub stars, active community
- Can clone a repo, read code, make edits, run tests, and open PRs — all autonomously
- Uses LiteLLM under the hood (supports any LLM provider)

## GitHub Action (openhands-resolver)

### How it works

- NOT a marketplace action — it's a reusable workflow: `OpenHands/OpenHands/.github/workflows/openhands-resolver.yml@main`
- Triggers:
  - `fix-me` label on issue/PR
  - `@openhands-agent` mention in issue comment, PR comment, or PR review
  - `@openhands-agent-exp` for bleeding edge
- Only OWNER/COLLABORATOR/MEMBER can trigger via comments (security)
- Flow: checks out repo → installs openhands-ai → runs resolver → agent clones repo in Docker sandbox → applies fixes → opens draft PR
- Custom repo instructions via `.openhands/microagents/repo.md`

### Configuration

Inputs:
- `macro`: trigger keyword (default: `@openhands-agent`)
- `max_iterations`: max agent think-act loops (default: 50)
- `LLM_MODEL`: provider/model format via LiteLLM (default: `anthropic/claude-sonnet-4-20250514`)
- `LLM_BASE_URL`: custom API endpoint
- `target_branch`: branch for PRs (default: main)
- `pr_type`: `draft` or `ready`
- `runner`: GitHub Actions runner (default: ubuntu-latest)

Secrets:
- `LLM_API_KEY`: required
- `PAT_TOKEN`: recommended over GITHUB_TOKEN for PR creation
- `LLM_BASE_URL`: optional, for custom endpoints

### Example workflow YAML

```yaml
name: OpenHands Auto-Fix
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  call-openhands-resolver:
    uses: OpenHands/OpenHands/.github/workflows/openhands-resolver.yml@main
    with:
      macro: '@openhands-agent'
      max_iterations: 30
      LLM_MODEL: 'deepseek/deepseek-chat'
      pr_type: 'draft'
    secrets:
      PAT_TOKEN: ${{ secrets.PAT_TOKEN }}
      PAT_USERNAME: ${{ secrets.PAT_USERNAME }}
      LLM_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

## Self-Hosted Option

### Requirements
- Docker (socket passthrough, NOT Docker-in-Docker)
- 4GB RAM minimum, 8GB recommended
- 2+ CPU cores
- ~20GB disk for Docker images
- LLM API key (cannot run local models on small servers)
- Port 3000 for web UI
- GitHub PAT for repo access

### Our Hetzner CX33 (2 vCPU, 4GB RAM, 40GB disk)
- Technically meets minimum requirements
- Only supports 1 concurrent task
- RAM will be tight (main container + sandbox = ~2-3GB)
- Recommendation: upgrade to 8GB for comfortable operation, or use the GitHub Action instead

## LLM Provider Options

### Recommended: DeepSeek
- ~$0.01-0.05 per fix
- No practical rate limits
- No output token cap
- Strong coding model
- Config: `LLM_MODEL: 'deepseek/deepseek-chat'`

### GitHub Models: NOT viable
- Endpoint: `https://models.github.ai/inference`
- Free tier limits are too restrictive:
  - High models (GPT-4o): 50 requests/day, 4K output tokens/request
  - Low models (GPT-4o-mini): 150 requests/day, 4K output tokens/request
- OpenHands uses 30-50+ iterations per issue, each with multiple LLM calls
- 4K output token cap truncates generated code
- Verdict: incompatible with agent-style workloads

### Other free/cheap options
- Groq free tier (Llama 3.3 70B): better limits than GitHub Models but still constrained
- OpenRouter: some free models (Devstral), pay-per-token for others
- Gemini free tier: 15 RPM, usable for simple fixes

## Integration Architecture with ghagga

### Concept
ghagga detects issues → formats findings as structured prompt → triggers OpenHands via PR comment → OpenHands fixes and opens draft PR

### Trigger pattern
After ghagga posts review findings, it posts a follow-up comment:

```
@openhands-agent Please fix the following code review findings:

- **src/auth.ts:23** - SQL injection. Use parameterized queries.
- **src/utils.ts:12** - Unused import. Remove it.

After fixing, run `npm test` to verify.
```

### Proposed command set

| Command | What ghagga triggers | OpenHands action |
|---------|---------------------|-----------------|
| `/ghagga fix` | Post findings as fix prompt | Fix code issues from review |
| `/ghagga docs` | Post code-doc validation results | Update outdated documentation |
| `/ghagga tests` | Post uncovered functions list | Generate missing unit tests |
| `/ghagga patch` | Post CVE exploitability findings | Update vulnerable dependencies |
| `/ghagga refactor` | Post duplication/complexity findings | Extract functions, simplify code |
| `/ghagga changelog` | Post commit summary | Generate/update CHANGELOG |
| `/ghagga types` | Post untyped function list | Add missing type annotations |
| `/ghagga api-docs` | Post API endpoint changes | Update OpenAPI spec |

### Key insight
Each command is just a different prompt template. ghagga already has all the data (findings, files, lines, suggestions). The integration is a formatting layer — convert ReviewFinding[] to natural language prompts per command type.

## Alternatives Considered

### Google Jules
- API is alpha with unknown pricing
- Requires manual repo pre-registration per repo
- 15 tasks/day free tier
- Verdict: too unstable and friction-heavy

### GitHub Copilot Coding Agent
- Requires paid Copilot plan ($10+/mo)
- REST API available (March 2026)
- No free tier
- Verdict: cost prohibitive for open source

### Devin (Cognition)
- API only on Teams plan ($500/mo)
- No free tier
- Verdict: way too expensive

### Aider (DIY)
- Open source, bring your own LLM key
- No native PR creation (needs shell glue)
- Python API with headless mode
- Verdict: viable fallback if OpenHands V1 doesn't materialize

### Open-SWE (LangChain)
- Open source, LangGraph ecosystem
- Full PR automation
- Requires sandbox infrastructure (Modal, Daytona)
- Verdict: strong alternative, more setup required

## Risks

1. **V0 deprecation**: Current resolver is Legacy V0, scheduled for removal April 2026. Must wait for V1.
2. **LLM quality**: Agent coding quality depends on the model. Cheap models may produce bad fixes.
3. **Loop risk**: OpenHands PR → ghagga reviews it → triggers more OpenHands. Need bot detection / skip rule.
4. **Minutes consumption**: 5-15 min per fix on GitHub Actions. Heavy usage could hit free tier limits (2000 min/month private repos).
5. **Comment auth**: ghagga's bot user needs COLLABORATOR access on the repo to trigger OpenHands via comments.

## Next Steps

1. Monitor OpenHands V1 / Software Agent SDK for resolver replacement
2. When V1 resolver is available:
   - Start SDD: `/sdd-new openhands-auto-remediation`
   - Implement `/ghagga fix` as first command
   - Add remaining commands incrementally
3. Consider Aider as interim solution if V1 takes too long

## References

- OpenHands repo: https://github.com/OpenHands/OpenHands
- Software Agent SDK (V1): https://github.com/OpenHands/software-agent-sdk
- OpenHands docs: https://docs.openhands.dev
- OpenHands resolver docs: https://docs.openhands.dev/usage/how-to/github-action
- GitHub Models: https://docs.github.com/en/github-models
- DeepSeek API: https://platform.deepseek.com
- Open-SWE: https://github.com/langchain-ai/open-swe
