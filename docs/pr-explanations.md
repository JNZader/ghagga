# PR explanations

`/ghagga explain` answers one question about the current pull-request revision. It is a read-only Q&A path for the GitHub App. It is not a seventh review mode, it does not create review findings, and it does not approve or request changes.

GitLab merge-request review still uses the existing forge adapter. That adapter does not expose the explanation snapshot or reply seam, so the same command is not accepted on GitLab.

## Enable it

Explanations stay **off** until a maintainer opts in. There is no new server secret.
1. Install the GitHub App and configure a provider chain (`gateway` or `cli-bridge`) in the dashboard. The explanation worker uses that same chain. It does not fall back to a review run when the provider is missing.
2. Turn on **PR explanations**:
   - **Global Settings** — inherited by repositories that use global settings.
   - **Repository Settings → custom** — overrides the installation for that repository.
3. Apply the existing database migrations through `0005_explanation_publication_patch` if this environment has not migrated yet. The flag itself lives in the settings JSON and defaults to false when it is absent.
4. Run the server process that starts the explanation worker (`createExplanationWorker` in `apps/server/src/index.ts`). Redis must be available, the same way it is for reviews. `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` are the credentials already required for the App.

The dashboard writes `explanationsEnabled` through `PUT /api/settings` or `PUT /api/installation-settings`. A non-boolean value on the repository route is rejected. Omitting the field leaves the stored value unchanged.

## Ask a question

Comment on the pull request as an `OWNER`, `MEMBER`, or `COLLABORATOR`:

```
/ghagga explain Why did this function start returning early?
```

| Rule                                                                       | What happens                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The command starts a line and is not inside a triple-backtick fence        | The question is the rest of that line                                  |
| Empty question, a bot, or any other association (`CONTRIBUTOR`, `NONE`, …) | No model call and no reply                                             |
| `explanationsEnabled` is false at admission, execution, or publication     | The command stops. No review is started instead                        |
| The pull-request head changes before the answer is published               | The invocation is stale. The old answer is not posted                  |
| The same comment is delivered again                                        | One invocation key is reused. A finished answer is not generated twice |

GHAGGA reacts with 👀 after the job is queued, then posts two issue comments on that pull request:
- a progress comment, for example `Explanation completed with outcome ANSWERED.`
- the answer comment, containing the explanation itself

Neither comment replaces a review comment. `DISABLED`, `UNAUTHORIZED`, and `STALE` are not posted.

The question text is data. Instructions inside the question do not turn the answer into findings or a verdict.

## What you still need in production

The code path is complete for a GitHub pull-request comment. A hosted deploy still needs:
- the explanation migrations applied,
- the App's existing `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY`,
- a provider chain with a usable key,
- Redis for the `explanation` queue,
- the **PR explanations** toggle on for that repository or its installation.

No additional secret is required beyond those.
