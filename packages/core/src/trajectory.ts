/**
 * Trajectory recording — captures every step of the review pipeline
 * as a structured JSON event for debugging and explainability.
 *
 * After a review, consumers can inspect the trajectory to understand:
 * - Which agents ran and in what order
 * - What each agent received as input and produced as output
 * - Token usage per step
 * - Total cost breakdown
 */

// ── Types ──

export type TrajectoryEventType =
	| "pipeline_start"
	| "pipeline_end"
	| "agent_start"
	| "agent_end"
	| "tool_start"
	| "tool_end"
	| "llm_call"
	| "error";

export interface TrajectoryEvent {
	type: TrajectoryEventType;
	timestamp: string;
	step: string; // e.g. "scope-analysis", "security-review", "semgrep"
	durationMs?: number;
	tokensUsed?: number;
	model?: string;
	input?: string; // truncated prompt or input summary
	output?: string; // truncated response or output summary
	error?: string;
	metadata?: Record<string, unknown>;
}

export interface Trajectory {
	reviewId: string;
	project: string;
	startedAt: string;
	completedAt: string | null;
	events: TrajectoryEvent[];
	totalTokens: number;
	totalDurationMs: number;
	estimatedCostUSD: number;
}

// ── Recorder ──

export class TrajectoryRecorder {
	private events: TrajectoryEvent[] = [];
	private startTime: number;
	private reviewId: string;
	private project: string;

	constructor(reviewId: string, project: string) {
		this.reviewId = reviewId;
		this.project = project;
		this.startTime = Date.now();
		this.record("pipeline_start", "pipeline", {});
	}

	record(
		type: TrajectoryEventType,
		step: string,
		data: Partial<Omit<TrajectoryEvent, "type" | "timestamp" | "step">>,
	): void {
		this.events.push({
			type,
			timestamp: new Date().toISOString(),
			step,
			...data,
		});
	}

	recordAgentStart(agent: string, model?: string): void {
		this.record("agent_start", agent, { model });
	}

	recordAgentEnd(
		agent: string,
		opts: { tokensUsed?: number; durationMs?: number; output?: string },
	): void {
		this.record("agent_end", agent, opts);
	}

	recordToolStart(tool: string): void {
		this.record("tool_start", tool, {});
	}

	recordToolEnd(
		tool: string,
		opts: { durationMs?: number; output?: string },
	): void {
		this.record("tool_end", tool, opts);
	}

	recordLLMCall(
		model: string,
		opts: { tokensUsed?: number; durationMs?: number },
	): void {
		this.record("llm_call", model, { model, ...opts });
	}

	recordError(step: string, error: string): void {
		this.record("error", step, { error });
	}

	// ── Finalization ──

	finalize(): Trajectory {
		this.record("pipeline_end", "pipeline", {});

		const totalTokens = this.events.reduce(
			(sum, e) => sum + (e.tokensUsed ?? 0),
			0,
		);
		const totalDurationMs = Date.now() - this.startTime;

		return {
			reviewId: this.reviewId,
			project: this.project,
			startedAt: new Date(this.startTime).toISOString(),
			completedAt: new Date().toISOString(),
			events: this.events,
			totalTokens,
			totalDurationMs,
			estimatedCostUSD: 0, // filled by consumer with pricing info
		};
	}

	// ── Query ──

	getEvents(): ReadonlyArray<TrajectoryEvent> {
		return this.events;
	}

	getEventsByType(type: TrajectoryEventType): TrajectoryEvent[] {
		return this.events.filter((e) => e.type === type);
	}

	getAgentSteps(): string[] {
		return this.events
			.filter((e) => e.type === "agent_start")
			.map((e) => e.step);
	}
}

// ── Formatting ──

export function formatTrajectory(trajectory: Trajectory): string {
	const lines: string[] = [];
	lines.push(`## Review Trajectory — ${trajectory.reviewId}`);
	lines.push(
		`**Project**: ${trajectory.project} | **Duration**: ${(trajectory.totalDurationMs / 1000).toFixed(1)}s | **Tokens**: ${trajectory.totalTokens}`,
	);
	lines.push("");

	let indent = 0;
	for (const event of trajectory.events) {
		const prefix = "  ".repeat(indent);
		const ts = event.timestamp.slice(11, 19); // HH:MM:SS

		switch (event.type) {
			case "pipeline_start":
				lines.push(`${prefix}${ts} ▶ Pipeline started`);
				indent++;
				break;
			case "pipeline_end":
				indent = Math.max(0, indent - 1);
				lines.push(`${prefix}${ts} ■ Pipeline ended`);
				break;
			case "agent_start":
				lines.push(
					`${prefix}${ts} → ${event.step}${event.model ? ` (${event.model})` : ""}`,
				);
				indent++;
				break;
			case "agent_end":
				indent = Math.max(0, indent - 1);
				lines.push(
					`${prefix}${ts} ← ${event.step}${event.tokensUsed ? ` [${event.tokensUsed} tok]` : ""}${event.durationMs ? ` ${event.durationMs}ms` : ""}`,
				);
				break;
			case "tool_start":
				lines.push(`${prefix}${ts}   🔧 ${event.step}`);
				break;
			case "tool_end":
				lines.push(
					`${prefix}${ts}   ✓ ${event.step}${event.durationMs ? ` ${event.durationMs}ms` : ""}`,
				);
				break;
			case "llm_call":
				lines.push(
					`${prefix}${ts}   🤖 ${event.model}${event.tokensUsed ? ` [${event.tokensUsed} tok]` : ""}`,
				);
				break;
			case "error":
				lines.push(`${prefix}${ts}   ✗ ERROR: ${event.error}`);
				break;
		}
	}

	return lines.join("\n");
}

// ── Serialization ──

export function trajectoryToJSON(trajectory: Trajectory): string {
	return JSON.stringify(trajectory, null, 2);
}

export function trajectoryFromJSON(json: string): Trajectory {
	return JSON.parse(json) as Trajectory;
}
