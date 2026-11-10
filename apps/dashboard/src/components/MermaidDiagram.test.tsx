/**
 * MermaidDiagram component tests (blast-radius-diagram T4.3).
 *
 * `vi.mock('mermaid')` — zero network, zero real rendering. Covers the
 * dashboard-ui scenarios: "Diagram renders when present" (mocked render
 * resolves → container wired with the SVG, legend shows the carried
 * flags) and "Render failure falls back to a code block" (reject AND
 * synchronous throw → read-only source block, no crash, no blank).
 */

import type { BlastRadiusDiagram } from '@ghagga/types';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInitialize = vi.fn();
const mockRender = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

import { MermaidDiagram } from './MermaidDiagram';

function makeDiagram(metaOverrides: Partial<BlastRadiusDiagram['meta']> = {}): BlastRadiusDiagram {
  return {
    mermaid: [
      'flowchart TD',
      '  classDef changed fill:#fef3c7,stroke:#d97706,stroke-width:2px',
      '  classDef dependent fill:#dbeafe,stroke:#2563eb',
      '  classDef test fill:#dcfce7,stroke:#16a34a',
      '  subgraph c0["src"]',
      '    n0["src/a.ts"]',
      '  end',
      '  class n0 changed',
    ].join('\n'),
    nodes: [{ id: 'n0', label: 'src/a.ts', role: 'changed', cluster: 'src' }],
    edges: [],
    meta: { stale: false, exceededCap: false, truncated: false, ...metaOverrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInitialize.mockClear();
  mockRender.mockReset();
});

describe('MermaidDiagram — success path', () => {
  it('initializes mermaid once with startOnLoad:false and renders the SVG into the container', async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="rendered">8 nodes 7 edges</svg>' });
    const diagram = makeDiagram();
    const { rerender } = render(<MermaidDiagram diagram={diagram} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-container').innerHTML).toContain('8 nodes 7 edges');
    });

    // mermaid.render called with the DTO mermaid source, unmodified.
    expect(mockRender).toHaveBeenCalledWith(expect.any(String), diagram.mermaid);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledWith({ startOnLoad: false });

    // Same mermaid source → effect memoized, no re-render.
    rerender(<MermaidDiagram diagram={makeDiagram()} />);
    expect(mockRender).toHaveBeenCalledTimes(1);

    // A CHANGED source re-renders; initialize stays once (module flag).
    const changed = makeDiagram();
    changed.mermaid = 'flowchart TD\n  n0["x.ts"]';
    rerender(<MermaidDiagram diagram={changed} />);
    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(2);
    });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('renders the honesty legend flags the data carries', async () => {
    mockRender.mockResolvedValue({ svg: '<svg>ok</svg>' });
    render(
      <MermaidDiagram
        diagram={makeDiagram({
          stale: true,
          exceededCap: true,
          truncated: true,
          clusterCounts: { src: 15 },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-container').innerHTML).toContain('ok');
    });
    expect(screen.getByText(/older than 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/exceeded the file cap/)).toBeInTheDocument();
    expect(screen.getByText('+15 more files not shown (render cap).')).toBeInTheDocument();
  });

  it('renders the edge-cap note for edge-only truncation', async () => {
    mockRender.mockResolvedValue({ svg: '<svg>ok</svg>' });
    render(<MermaidDiagram diagram={makeDiagram({ truncated: true })} />);
    await waitFor(() => {
      expect(screen.getByText('Some edges not shown (render cap).')).toBeInTheDocument();
    });
  });

  it('renders no legend when no flags are set', async () => {
    mockRender.mockResolvedValue({ svg: '<svg>ok</svg>' });
    render(<MermaidDiagram diagram={makeDiagram()} />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-container').innerHTML).toContain('ok');
    });
    expect(screen.queryByText(/older than 7 days/)).not.toBeInTheDocument();
    expect(screen.queryByText(/render cap/)).not.toBeInTheDocument();
  });
});

describe('MermaidDiagram — failure fallback', () => {
  it('render rejection → read-only source block with the mermaid source, no crash', async () => {
    mockRender.mockRejectedValue(new Error('parse error'));
    render(<MermaidDiagram diagram={makeDiagram()} />);

    const fallback = await screen.findByTestId('mermaid-fallback');
    expect(fallback).toBeInTheDocument();
    expect(screen.getByText(/diagram could not be rendered/)).toBeInTheDocument();
    // The mermaid source is shown verbatim (already on the DTO).
    expect(document.querySelector('pre code')?.textContent).toContain('flowchart TD');
    expect(screen.queryByTestId('mermaid-container')).not.toBeInTheDocument();
  });

  it('synchronous render throw → same fallback, no unhandled error', async () => {
    mockRender.mockImplementation(() => {
      throw new Error('mermaid exploded');
    });
    render(<MermaidDiagram diagram={makeDiagram()} />);

    const fallback = await screen.findByTestId('mermaid-fallback');
    expect(fallback).toBeInTheDocument();
    expect(document.querySelector('pre code')?.textContent).toContain('flowchart TD');
  });

  it('fallback still renders the honesty legend', async () => {
    mockRender.mockRejectedValue(new Error('parse error'));
    render(<MermaidDiagram diagram={makeDiagram({ stale: true })} />);
    expect(await screen.findByTestId('mermaid-fallback')).toBeInTheDocument();
    expect(screen.getByText(/older than 7 days/)).toBeInTheDocument();
  });

  it('missing meta (4R RES-002) renders without crashing — empty legend, no TypeError', async () => {
    const blobWithoutMeta = { ...makeDiagram(), meta: undefined } as unknown as BlastRadiusDiagram;
    render(<MermaidDiagram diagram={blobWithoutMeta} />);
    // Either path (render success or fallback) must mount without
    // throwing; the legend simply renders nothing.
    await waitFor(() => {
      expect(
        screen.queryByTestId('mermaid-container') ?? screen.queryByTestId('mermaid-fallback'),
      ).toBeInTheDocument();
    });
  });
});
