/**
 * Tests for RepoProvider context and useSelectedRepo hook.
 */

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoProvider, useSelectedRepo } from './repo-context';

// ─── Mocks ──────────────────────────────────────────────────────

const mockLocalStorage: Record<string, string> = {};
const mockGetItem = vi.fn((key: string) => mockLocalStorage[key] ?? null);
const mockSetItem = vi.fn((key: string, value: string) => {
  mockLocalStorage[key] = value;
});
const mockRemoveItem = vi.fn((key: string) => {
  delete mockLocalStorage[key];
});

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: mockGetItem,
    setItem: mockSetItem,
    removeItem: mockRemoveItem,
  });
  // Clear stored values
  for (const key of Object.keys(mockLocalStorage)) {
    delete mockLocalStorage[key];
  }
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ────────────────────────────────────────────────────

function RepoTestWrapper({ children }: { children: ReactNode }) {
  return <RepoProvider>{children}</RepoProvider>;
}

// ═══════════════════════════════════════════════════════════════════
// RepoProvider
// ═══════════════════════════════════════════════════════════════════

describe('RepoProvider', () => {
  it('initializes selectedRepo from localStorage', () => {
    mockLocalStorage.ghagga_selected_repo = 'acme/app';

    const { result } = renderHook(() => useSelectedRepo(), {
      wrapper: RepoTestWrapper,
    });

    expect(result.current.selectedRepo).toBe('acme/app');
    expect(mockGetItem).toHaveBeenCalledWith('ghagga_selected_repo');
  });

  it('defaults to empty string when localStorage has no value', () => {
    const { result } = renderHook(() => useSelectedRepo(), {
      wrapper: RepoTestWrapper,
    });

    expect(result.current.selectedRepo).toBe('');
  });

  it('defaults to empty string when localStorage throws', () => {
    mockGetItem.mockImplementation(() => {
      throw new Error('localStorage not available');
    });

    const { result } = renderHook(() => useSelectedRepo(), {
      wrapper: RepoTestWrapper,
    });

    expect(result.current.selectedRepo).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// useSelectedRepo
// ═══════════════════════════════════════════════════════════════════

describe('useSelectedRepo', () => {
  it('setSelectedRepo updates state and persists to localStorage', () => {
    const { result } = renderHook(() => useSelectedRepo(), {
      wrapper: RepoTestWrapper,
    });

    act(() => {
      result.current.setSelectedRepo('acme/app');
    });

    expect(result.current.selectedRepo).toBe('acme/app');
    expect(mockSetItem).toHaveBeenCalledWith('ghagga_selected_repo', 'acme/app');
  });

  it('setting empty string removes from localStorage', () => {
    mockLocalStorage.ghagga_selected_repo = 'acme/app';

    const { result } = renderHook(() => useSelectedRepo(), {
      wrapper: RepoTestWrapper,
    });

    act(() => {
      result.current.setSelectedRepo('');
    });

    expect(result.current.selectedRepo).toBe('');
    expect(mockRemoveItem).toHaveBeenCalledWith('ghagga_selected_repo');
  });

  it('throws when used outside RepoProvider', () => {
    // Suppress console.error from React's error boundary
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useSelectedRepo());
    }).toThrow('useSelectedRepo must be used within a RepoProvider');

    spy.mockRestore();
  });
});
