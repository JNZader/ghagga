# Delta for Dashboard UI

> **Change**: `blast-radius-diagram`
> **Base spec**: `openspec/specs/dashboard-ui/spec.md`

## MODIFIED Requirements

### Requirement: Review History

The system MUST display a browsable, filterable list of past reviews.

The review detail view MUST render the blast-radius diagram from the same single source the review comment uses — the `blastRadiusDiagram` key of the review DTO (projected from the persisted metadata) — whenever that key is present. Rationale: the dashboard deploys as a static SPA on GitHub Pages, so the mermaid renderer MUST be lazy-loaded via dynamic import on the detail path only when a review actually has diagram data; a static import would ship the renderer to every visitor and regress the Pages bundle (see Requirement: Deployment on GitHub Pages).

When diagram data is absent, the detail view MUST NOT render a diagram placeholder and MUST NOT fetch the mermaid chunk — the main bundle size and the no-diagram path MUST be byte-identical in cost to before this change. When mermaid rendering fails (parse error, chunk load failure, runtime exception), the detail view MUST fall back to displaying the raw mermaid source in a read-only code block rather than an error state or a blank area.

#### Scenario: View review list

- GIVEN a logged-in user with 2 repositories that have reviews
- WHEN the user navigates to the Reviews page
- THEN the system MUST display a table with columns: status, repository, PR number, date, mode
- AND the table MUST support filtering by repository and status
- AND the table MUST support text search
- AND results MUST be paginated

#### Scenario: View review detail

- GIVEN a review list with entries
- WHEN the user clicks on a review row
- THEN a detail view MUST show: full summary, all findings with severity/file/line, static analysis results, and the review mode used
- AND when the review's DTO carries `blastRadiusDiagram`, the detail view MUST additionally render the blast-radius mermaid diagram from that data

#### Scenario: Diagram renders when present

- GIVEN a review whose DTO carries `blastRadiusDiagram` with 8 nodes and 7 edges
- WHEN the user opens that review's detail view
- THEN the mermaid chunk MUST be fetched and the diagram MUST render with all 8 nodes and 7 edges visible
- AND the legend MUST display the same honesty flags the data carries (`graphStale`, `exceededCap`, "+N more" truncation count)

#### Scenario: No render and no bundle cost when absent

- GIVEN a review whose DTO has no `blastRadiusDiagram` key
- WHEN the user opens that review's detail view
- THEN no diagram area MUST be rendered (no placeholder, no error)
- AND the mermaid chunk MUST NOT be requested over the network
- AND the main bundle MUST NOT include the mermaid package (lazy dynamic import only; static import of mermaid anywhere in the entry graph is a spec violation)

#### Scenario: Render failure falls back to a code block

- GIVEN a review whose DTO carries `blastRadiusDiagram` and a mermaid runtime that throws while parsing the source (malformed or version-drifted syntax)
- WHEN the user opens that review's detail view
- THEN the detail view MUST display the raw mermaid source in a read-only code block instead of the rendered diagram
- AND no unhandled error, blank modal, or crash of the detail view MUST occur
