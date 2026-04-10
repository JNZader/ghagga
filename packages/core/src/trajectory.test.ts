import { describe, expect, it } from 'vitest';
import {
  formatTrajectory,
  TrajectoryRecorder,
  trajectoryFromJSON,
  trajectoryToJSON,
} from './trajectory.js';

describe('TrajectoryRecorder', () => {
  it('creates with pipeline_start event', () => {
    const rec = new TrajectoryRecorder('rev-1', 'my-project');
    const events = rec.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe('pipeline_start');
  });

  it('records agent start/end', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordAgentStart('scope-analysis', 'claude-sonnet-4');
    rec.recordAgentEnd('scope-analysis', { tokensUsed: 1500, durationMs: 2000 });

    const agents = rec.getEventsByType('agent_start');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.step).toBe('scope-analysis');
    expect(agents[0]?.model).toBe('claude-sonnet-4');

    const ends = rec.getEventsByType('agent_end');
    expect(ends[0]?.tokensUsed).toBe(1500);
  });

  it('records tool execution', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordToolStart('semgrep');
    rec.recordToolEnd('semgrep', { durationMs: 5000, output: '3 findings' });

    const tools = rec.getEventsByType('tool_end');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.durationMs).toBe(5000);
  });

  it('records LLM calls', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordLLMCall('claude-opus-4', { tokensUsed: 5000, durationMs: 3000 });

    const calls = rec.getEventsByType('llm_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('claude-opus-4');
  });

  it('records errors', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordError('trivy', 'Command not found');

    const errors = rec.getEventsByType('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBe('Command not found');
  });

  it('getAgentSteps returns ordered agent names', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordAgentStart('scope-analysis');
    rec.recordAgentStart('security-review');
    rec.recordAgentStart('quality-check');

    expect(rec.getAgentSteps()).toEqual(['scope-analysis', 'security-review', 'quality-check']);
  });

  it('finalize produces complete trajectory', () => {
    const rec = new TrajectoryRecorder('rev-1', 'my-project');
    rec.recordAgentStart('scope', 'sonnet');
    rec.recordLLMCall('sonnet', { tokensUsed: 2000 });
    rec.recordAgentEnd('scope', { tokensUsed: 2000, durationMs: 1500 });

    const traj = rec.finalize();
    expect(traj.reviewId).toBe('rev-1');
    expect(traj.project).toBe('my-project');
    expect(traj.startedAt).toBeTruthy();
    expect(traj.completedAt).toBeTruthy();
    expect(traj.totalTokens).toBe(4000); // 2000 from llm + 2000 from agent_end
    expect(traj.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(traj.events.length).toBeGreaterThanOrEqual(4); // start + agent + llm + agent_end + end
  });
});

describe('formatTrajectory', () => {
  it('produces readable output', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordAgentStart('scope-analysis', 'claude-sonnet-4');
    rec.recordToolStart('semgrep');
    rec.recordToolEnd('semgrep', { durationMs: 500 });
    rec.recordLLMCall('claude-sonnet-4', { tokensUsed: 1500 });
    rec.recordAgentEnd('scope-analysis', { tokensUsed: 1500, durationMs: 2000 });
    rec.recordError('trivy', 'timeout');

    const traj = rec.finalize();
    const text = formatTrajectory(traj);

    expect(text).toContain('Review Trajectory');
    expect(text).toContain('scope-analysis');
    expect(text).toContain('semgrep');
    expect(text).toContain('ERROR: timeout');
  });
});

describe('serialization', () => {
  it('roundtrips through JSON', () => {
    const rec = new TrajectoryRecorder('rev-1', 'test');
    rec.recordAgentStart('scope', 'sonnet');
    rec.recordAgentEnd('scope', { tokensUsed: 1000 });
    const traj = rec.finalize();

    const json = trajectoryToJSON(traj);
    const restored = trajectoryFromJSON(json);

    expect(restored.reviewId).toBe('rev-1');
    expect(restored.events.length).toBe(traj.events.length);
    expect(restored.totalTokens).toBe(traj.totalTokens);
  });
});
