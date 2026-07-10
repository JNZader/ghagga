import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/Card';
import { ProviderChainEditor } from '@/components/settings/ProviderChainEditor';
import type { ProviderEntryState } from '@/components/settings/ProviderEntry';
import { KNOWN_MODELS } from '@/components/settings/provider-fields/shared';
import { ToolGrid } from '@/components/settings/ToolGrid';
import {
  ApiError,
  useCopySettingsToGlobal,
  useInstallWorkflow,
  useRepositories,
  useSettings,
  useUpdateSettings,
  useWorkflowStatus,
} from '@/lib/api';
import { useSelectedRepo } from '@/lib/repo-context';
import type {
  ProviderChainUpdate,
  ProviderChainView,
  RegisteredTool,
  ReviewMode,
  SaaSProvider,
} from '@/lib/types';

/** Human-readable message for the Settings load-error state (PRODOPS-001). */
function getSettingsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This repository could not be found.';
    if (error.status === 403) return "You don't have access to this repository's settings.";
    return error.message || 'Failed to load settings.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Failed to load settings.';
}

export function Settings() {
  const { selectedRepo, setSelectedRepo } = useSelectedRepo();
  const { data: repos } = useRepositories();
  const {
    data: settings,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useSettings(selectedRepo);
  const updateSettings = useUpdateSettings();
  const copyToGlobal = useCopySettingsToGlobal();

  // ── Load-gated Save (PRODOPS-001) ───────────────────────────
  // Tracks which repo's data the local form state was actually hydrated
  // from. Save is only enabled once this matches selectedRepo — never on a
  // failed/never-loaded fetch, and never with a previous repo's leftover
  // state after switching repos.
  const [hydratedRepo, setHydratedRepo] = useState<string | null>(null);
  const canSave = hydratedRepo === selectedRepo && !!settings;

  // ── Workflow installation ───────────────────────────────────
  const [workflowOwner, workflowRepo] = selectedRepo
    ? (selectedRepo.split('/') as [string, string])
    : [undefined, undefined];
  const { data: workflowStatus, isLoading: workflowLoading } = useWorkflowStatus(
    workflowOwner,
    workflowRepo,
  );
  const installWorkflow = useInstallWorkflow(workflowOwner ?? '', workflowRepo ?? '');

  // ── Global vs custom toggle ─────────────────────────────────
  const [useGlobalSettings, setUseGlobalSettings] = useState(true);

  // ── Static analysis toggles (legacy) ─────────────────────────
  const [enableSemgrep, setEnableSemgrep] = useState(true);
  const [enableTrivy, setEnableTrivy] = useState(true);
  const [enableCpd, setEnableCpd] = useState(false);
  const [enableMemory, setEnableMemory] = useState(true);

  // ── Tool grid state ─────────────────────────────────────────
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [registeredTools, setRegisteredTools] = useState<RegisteredTool[]>([]);

  // ── AI Review toggle ────────────────────────────────────────
  const [aiReviewEnabled, setAiReviewEnabled] = useState(true);

  // ── Provider chain ──────────────────────────────────────────
  const [providerChain, setProviderChain] = useState<ProviderEntryState[]>([]);

  // ── Review mode ─────────────────────────────────────────────
  const [reviewMode, setReviewMode] = useState<ReviewMode>('simple');

  // ── Blast Radius toggle ──────────────────────────────────────
  const [enableBlastRadius, setEnableBlastRadius] = useState(false);

  // ── Other settings ──────────────────────────────────────────
  const [customRules, setCustomRules] = useState('');
  const [ignorePatterns, setIgnorePatterns] = useState('');

  // ── Save feedback ───────────────────────────────────────────
  const [saveSuccess, setSaveSuccess] = useState(false);

  // ── Copy-to-global confirmation ─────────────────────────────
  const [showCopyConfirm, setShowCopyConfirm] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  // ── Reset local state immediately on repo change (PRODOPS-001) ──
  // Runs BEFORE any fetch for the new repo resolves, so a slow or failing
  // load for repo B can never leave repo A's values sitting in the form
  // (and therefore never leak into a Save call for B). The hydration sync
  // effect below re-populates these once B's load actually succeeds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset-on-repo-change, not a data sync
  useEffect(() => {
    setHydratedRepo(null);
    setUseGlobalSettings(true);
    setEnableSemgrep(true);
    setEnableTrivy(true);
    setEnableCpd(false);
    setEnableMemory(true);
    setDisabledTools([]);
    setRegisteredTools([]);
    setAiReviewEnabled(true);
    setProviderChain([]);
    setReviewMode('simple');
    setEnableBlastRadius(false);
    setCustomRules('');
    setIgnorePatterns('');
  }, [selectedRepo]);

  // ── Sync form state with fetched settings ───────────────────
  useEffect(() => {
    if (settings) {
      setUseGlobalSettings(settings.useGlobalSettings);
      setEnableSemgrep(settings.enableSemgrep);
      setEnableTrivy(settings.enableTrivy);
      setEnableCpd(settings.enableCpd);
      setEnableMemory(settings.enableMemory);
      setEnableBlastRadius(settings.enableBlastRadius ?? false);
      setAiReviewEnabled(settings.aiReviewEnabled);
      setReviewMode(settings.reviewMode);
      setCustomRules(settings.customRules);
      setIgnorePatterns(settings.ignorePatterns.join('\n'));
      setDisabledTools(settings.disabledTools ?? []);
      setRegisteredTools(settings.registeredTools ?? []);

      // Map server chain view to local entry state
      setProviderChain(
        settings.providerChain.map((entry: ProviderChainView, index: number) => ({
          id: `${entry.provider}-${index}`,
          provider: entry.provider,
          model: entry.model,
          apiKey: '',
          // Use full known model list so the dropdown is immediately usable
          availableModels:
            KNOWN_MODELS[entry.provider as SaaSProvider] ?? (entry.model ? [entry.model] : []),
          hasExistingKey: entry.hasApiKey,
          maskedApiKey: entry.maskedApiKey,
          validated:
            entry.hasApiKey ||
            entry.provider === 'cli-bridge' ||
            entry.provider === 'ollama' ||
            entry.provider === 'gateway',
          cliModel: entry.cliModel,
          gatewayUrl: entry.gatewayUrl,
        })),
      );

      // Only NOW is it safe to Save — the form genuinely reflects a
      // successful load for the currently selected repo.
      setHydratedRepo(selectedRepo);
    }
  }, [settings, selectedRepo]);

  // ── Handle global toggle ────────────────────────────────────
  const handleGlobalToggle = async (useGlobal: boolean) => {
    setUseGlobalSettings(useGlobal);
    if (!selectedRepo) return;

    // If switching to custom and the repo has no chain yet, pre-fill from global
    if (!useGlobal && settings?.globalSettings && providerChain.length === 0) {
      setProviderChain(
        settings.globalSettings.providerChain.map((entry: ProviderChainView, index: number) => ({
          id: `${entry.provider}-${index}`,
          provider: entry.provider,
          model: entry.model,
          apiKey: '',
          availableModels: entry.model ? [entry.model] : [],
          hasExistingKey: entry.hasApiKey,
          maskedApiKey: entry.maskedApiKey,
          validated:
            entry.hasApiKey ||
            entry.provider === 'cli-bridge' ||
            entry.provider === 'ollama' ||
            entry.provider === 'gateway',
          cliModel: entry.cliModel,
          gatewayUrl: entry.gatewayUrl,
        })),
      );
      if (settings.globalSettings) {
        setAiReviewEnabled(settings.globalSettings.aiReviewEnabled);
        setReviewMode(settings.globalSettings.reviewMode as ReviewMode);
        setEnableSemgrep(settings.globalSettings.enableSemgrep);
        setEnableTrivy(settings.globalSettings.enableTrivy);
        setEnableCpd(settings.globalSettings.enableCpd);
        setEnableMemory(settings.globalSettings.enableMemory);
        setEnableBlastRadius(settings.globalSettings.enableBlastRadius ?? false);
        setCustomRules(settings.globalSettings.customRules);
        setIgnorePatterns(settings.globalSettings.ignorePatterns.join('\n'));
      }
    }
  };

  // ── Save handler ────────────────────────────────────────────
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRepo) return;
    // Guard against submitting over a config that never successfully loaded
    // for this repo (PRODOPS-001). The Save button is also disabled in this
    // case, but the guard is kept here too since a stray Enter-key submit on
    // a text field bypasses the disabled button.
    if (!canSave) return;

    if (useGlobalSettings) {
      // Only save the toggle
      await updateSettings.mutateAsync({
        repoFullName: selectedRepo,
        useGlobalSettings: true,
      });
    } else {
      const chainUpdate: ProviderChainUpdate[] = providerChain.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        ...(entry.apiKey.trim() ? { apiKey: entry.apiKey.trim() } : {}),
        ...(entry.provider === 'cli-bridge' && entry.cliModel ? { cliModel: entry.cliModel } : {}),
        ...(entry.provider === 'gateway' && entry.gatewayUrl
          ? { gatewayUrl: entry.gatewayUrl }
          : {}),
      }));

      await updateSettings.mutateAsync({
        repoFullName: selectedRepo,
        useGlobalSettings: false,
        aiReviewEnabled,
        providerChain: chainUpdate,
        reviewMode,
        enableSemgrep,
        enableTrivy,
        enableCpd,
        enableMemory,
        enableBlastRadius,
        disabledTools,
        customRules,
        ignorePatterns: ignorePatterns
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean),
      });
    }

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  // Find the repo ID for the selected repo (needed for CI job discovery)
  const selectedRepoId = repos?.find((r) => r.fullName === selectedRepo)?.id ?? undefined;

  // ── Copy to Global handler ───────────────────────────────────
  const handleCopyToGlobal = async () => {
    if (!selectedRepoId) return;
    try {
      await copyToGlobal.mutateAsync({ repoId: selectedRepoId });
      setCopySuccess(true);
      setShowCopyConfirm(false);
      setTimeout(() => setCopySuccess(false), 3000);
    } catch {
      // Error state is handled by copyToGlobal.isError
      setShowCopyConfirm(false);
    }
  };

  const globalSettings = settings?.globalSettings;

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Repository Settings</h1>
          <p className="mt-1 text-text-secondary">
            Configure review settings for a specific repository
          </p>
        </div>

        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="select-field w-64"
        >
          <option value="">Select a repository</option>
          {repos?.map((repo) => (
            <option key={repo.id} value={repo.fullName}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </div>

      {!selectedRepo ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 text-5xl">&#9881;&#65039;</div>
          <h2 className="mb-2 text-xl font-semibold text-text-primary">Select a Repository</h2>
          <p className="max-w-md text-text-secondary">
            Choose a repository from the dropdown above to configure its review settings.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : isError ? (
        /* ── Load error: never render the editable form here (PRODOPS-001) ──
           Rendering the form with default local state would let Save
           overwrite a config that never actually loaded. */
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-red-500/30 bg-red-500/10 py-16 text-center">
          <div className="text-4xl" aria-hidden="true">
            ⚠️
          </div>
          <div>
            <h2 className="mb-1 text-lg font-semibold text-text-primary">
              Failed to load settings for {selectedRepo}
            </h2>
            <p className="max-w-md text-sm text-text-secondary">{getSettingsErrorMessage(error)}</p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="btn-primary"
          >
            {isFetching ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-6">
          {/* ── Global vs Custom Toggle ──────────────────────── */}
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader
                title="Settings Source"
                description="Choose whether this repo uses global defaults or custom settings"
              />
              <label className="flex cursor-pointer items-center gap-3">
                <span className="text-sm text-text-secondary">
                  {useGlobalSettings ? 'Global' : 'Custom'}
                </span>
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={useGlobalSettings}
                    onChange={(e) => handleGlobalToggle(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
                  <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                </div>
              </label>
            </div>

            {useGlobalSettings && (
              <div className="mt-3 rounded-lg border border-primary-600/30 bg-primary-600/10 p-3">
                <p className="text-sm text-primary-300">
                  This repository inherits settings from{' '}
                  <Link
                    to="/global-settings"
                    className="font-medium underline hover:text-primary-200"
                  >
                    Global Settings
                  </Link>
                  . Switch to &quot;Custom&quot; to override.
                </p>
              </div>
            )}
          </Card>

          {/* ── Copy to Global ────────────────────────────── */}
          {!useGlobalSettings && selectedRepoId && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowCopyConfirm(true)}
                disabled={copyToGlobal.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-surface-bg px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:border-primary-600/50 hover:bg-primary-600/10"
              >
                <span aria-hidden="true">📤</span>
                {copyToGlobal.isPending ? 'Copying...' : 'Copy to Global'}
              </button>
              {copySuccess && (
                <span className="text-sm text-green-400">Settings copied to global!</span>
              )}
              {copyToGlobal.isError && (
                <span className="text-sm text-red-400">Failed to copy settings.</span>
              )}
            </div>
          )}

          {/* ── Copy to Global Confirmation Dialog ─────────── */}
          {showCopyConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="w-full max-w-md rounded-xl border border-surface-border bg-surface-card p-6 shadow-xl">
                <h3 className="text-lg font-semibold text-text-primary">
                  Copy Settings to Global?
                </h3>
                <p className="mt-2 text-sm text-text-secondary">
                  This will overwrite the Global (installation-level) settings with this repo&apos;s
                  provider chain, review mode, and tool configuration.
                </p>
                <p className="mt-2 text-sm font-medium text-yellow-400">
                  All repositories using &quot;Global&quot; settings will be affected.
                </p>
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowCopyConfirm(false)}
                    className="rounded-lg border border-surface-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-bg"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyToGlobal}
                    disabled={copyToGlobal.isPending}
                    className="btn-primary"
                  >
                    {copyToGlobal.isPending ? 'Copying...' : 'Yes, Copy to Global'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {useGlobalSettings && globalSettings ? (
            /* ── Read-only inherited view ─────────────────────── */
            <div className="space-y-6 opacity-75">
              <Card>
                <CardHeader
                  title="Static Analysis Tools"
                  description="Inherited from global settings"
                />
                {registeredTools.length > 0 ? (
                  <ToolGrid
                    tools={registeredTools}
                    disabledTools={globalSettings.disabledTools ?? []}
                    onToggle={() => {}}
                    readOnly
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {[
                      {
                        label: 'Semgrep (security + patterns)',
                        value: globalSettings.enableSemgrep,
                      },
                      { label: 'Trivy (vulnerabilities)', value: globalSettings.enableTrivy },
                      { label: 'PMD/CPD (code duplication)', value: globalSettings.enableCpd },
                      { label: 'Memory (project knowledge)', value: globalSettings.enableMemory },
                    ].map((toggle) => (
                      <div
                        key={toggle.label}
                        className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3"
                      >
                        <span
                          className={`text-sm ${toggle.value ? 'text-green-400' : 'text-text-muted'}`}
                        >
                          {toggle.value ? '✓' : '✕'}
                        </span>
                        <span className="text-sm text-text-secondary">{toggle.label}</span>
                        <span className="ml-auto rounded-sm bg-primary-600/20 px-2 py-0.5 text-xs text-primary-400">
                          Inherited
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title="AI Review" description="Inherited from global settings" />
                <div className="space-y-2 text-sm text-text-secondary">
                  <p>
                    <strong className="text-text-primary">Status:</strong>{' '}
                    {globalSettings.aiReviewEnabled ? 'Enabled' : 'Disabled'}
                  </p>
                  <p>
                    <strong className="text-text-primary">Review Mode:</strong>{' '}
                    <span className="capitalize">{globalSettings.reviewMode}</span>
                  </p>
                  <p>
                    <strong className="text-text-primary">Provider Chain:</strong>{' '}
                    {globalSettings.providerChain.length === 0
                      ? 'Not configured'
                      : globalSettings.providerChain
                          .map((e: ProviderChainView) => `${e.provider} (${e.model})`)
                          .join(' → ')}
                  </p>
                </div>
              </Card>
            </div>
          ) : !useGlobalSettings ? (
            /* ── Editable custom settings ─────────────────────── */
            <>
              {/* ── Static Analysis Tools ────────────────────────── */}
              <Card>
                <CardHeader
                  title="Static Analysis Tools"
                  description="Configure which static analysis tools run on pull requests"
                />
                {registeredTools.length > 0 ? (
                  <ToolGrid
                    tools={registeredTools}
                    disabledTools={disabledTools}
                    onToggle={setDisabledTools}
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {[
                      {
                        label: 'Semgrep (security + patterns)',
                        value: enableSemgrep,
                        setter: setEnableSemgrep,
                      },
                      {
                        label: 'Trivy (vulnerabilities)',
                        value: enableTrivy,
                        setter: setEnableTrivy,
                      },
                      {
                        label: 'PMD/CPD (code duplication)',
                        value: enableCpd,
                        setter: setEnableCpd,
                      },
                    ].map((toggle) => (
                      <label
                        key={toggle.label}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3 transition-colors hover:border-surface-border/80"
                      >
                        <input
                          type="checkbox"
                          checked={toggle.value}
                          onChange={(e) => toggle.setter(e.target.checked)}
                          className="h-4 w-4 accent-primary-600"
                        />
                        <span className="text-sm text-text-primary">{toggle.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </Card>

              {/* ── Memory ────────────────────────────────────────── */}
              <Card>
                <div className="flex items-center justify-between">
                  <CardHeader
                    title="Memory"
                    description="Enable project knowledge memory for context-aware reviews"
                  />
                  <label className="flex cursor-pointer items-center gap-3">
                    <span className="text-sm text-text-secondary">
                      {enableMemory ? 'Enabled' : 'Disabled'}
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={enableMemory}
                        onChange={(e) => setEnableMemory(e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
                      <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                    </div>
                  </label>
                </div>
              </Card>

              {/* ── Blast Radius ─────────────────────────────────── */}
              <Card>
                <div className="flex items-center justify-between">
                  <CardHeader
                    title="Blast Radius"
                    description="Analyze dependency graph to focus reviews on impacted files"
                  />
                  <label className="flex cursor-pointer items-center gap-3">
                    <span className="text-sm text-text-secondary">
                      {enableBlastRadius ? 'Enabled' : 'Disabled'}
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={enableBlastRadius}
                        onChange={(e) => setEnableBlastRadius(e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
                      <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                    </div>
                  </label>
                </div>
                {enableBlastRadius && (
                  <div className="mt-2 space-y-1 text-xs text-text-secondary">
                    <p>
                      When enabled, GHAGGA analyzes which files are <em>actually impacted</em> by
                      the changed code (via import/call graph) and limits the review to those files
                      only — reducing tokens by up to 6×.
                    </p>
                    <p className="text-yellow-400/80">
                      ⚡ The dependency graph is built automatically on the first review after
                      enabling. The <strong>second review onwards</strong> will use blast-radius
                      filtering.
                    </p>
                  </div>
                )}
              </Card>

              {/* ── AI Review ────────────────────────────────────── */}
              <Card>
                <div className="flex items-center justify-between">
                  <CardHeader
                    title="AI Review"
                    description="Enable LLM-powered code review with provider fallback chain"
                  />
                  <label className="flex cursor-pointer items-center gap-3">
                    <span className="text-sm text-text-secondary">
                      {aiReviewEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={aiReviewEnabled}
                        onChange={(e) => setAiReviewEnabled(e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
                      <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                    </div>
                  </label>
                </div>

                {aiReviewEnabled && (
                  <div className="mt-4 space-y-4">
                    <div>
                      <span className="mb-2 block text-sm font-medium text-text-primary">
                        Provider Chain
                        <span className="ml-2 font-normal text-text-secondary">
                          (ordered by priority — primary first, fallbacks below)
                        </span>
                      </span>
                      <ProviderChainEditor chain={providerChain} onChange={setProviderChain} />
                    </div>

                    <div>
                      <span
                        id="review-mode-label"
                        className="mb-2 block text-sm font-medium text-text-primary"
                      >
                        Review Mode
                      </span>
                      <div
                        className="flex gap-4"
                        role="radiogroup"
                        aria-labelledby="review-mode-label"
                      >
                        {(['simple', 'workflow', 'consensus'] as const).map((mode) => (
                          <label key={mode} className="flex cursor-pointer items-center gap-2">
                            <input
                              type="radio"
                              name="reviewMode"
                              value={mode}
                              checked={reviewMode === mode}
                              onChange={() => setReviewMode(mode)}
                              className="accent-primary-600"
                            />
                            <span className="text-sm capitalize text-text-primary">{mode}</span>
                          </label>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        Simple: 1 LLM call &middot; Workflow: 5 specialist agents &middot;
                        Consensus: 3 stances debate
                      </p>
                    </div>
                  </div>
                )}
              </Card>

              {/* ── Advanced Settings ─────────────────────────────── */}
              <Card>
                <CardHeader title="Advanced" description="Custom rules and file ignore patterns" />

                <div className="mb-4">
                  <label
                    htmlFor="customRules"
                    className="mb-2 block text-sm font-medium text-text-primary"
                  >
                    Custom Rules
                  </label>
                  <textarea
                    id="customRules"
                    value={customRules}
                    onChange={(e) => setCustomRules(e.target.value)}
                    placeholder="Add custom review rules..."
                    rows={4}
                    className="input-field resize-y"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ignorePatterns"
                    className="mb-2 block text-sm font-medium text-text-primary"
                  >
                    Ignore Patterns{' '}
                    <span className="font-normal text-text-secondary">(one per line)</span>
                  </label>
                  <textarea
                    id="ignorePatterns"
                    value={ignorePatterns}
                    onChange={(e) => setIgnorePatterns(e.target.value)}
                    placeholder={'*.lock\ndist/**\nnode_modules/**'}
                    rows={4}
                    className="input-field resize-y font-mono text-sm"
                  />
                </div>
              </Card>
            </>
          ) : null}

          {/* ── Workflow Installation ─────────────────────────── */}
          <Card>
            <CardHeader
              title="Inline Workflow"
              description="GHAGGA injects a GitHub Actions workflow into this repository for static analysis"
            />

            {workflowLoading && (
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
                <span className="text-sm text-text-secondary">Checking workflow status...</span>
              </div>
            )}

            {!workflowLoading && workflowStatus?.installed && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <svg
                    className="h-5 w-5 text-green-400"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    aria-label="Workflow installed"
                    role="img"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-text-primary">Workflow installed</span>
                  {workflowStatus.workflowInstalledAt && (
                    <span className="text-xs text-text-secondary">
                      — {new Date(workflowStatus.workflowInstalledAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => installWorkflow.mutate()}
                  disabled={installWorkflow.isPending}
                  className="btn-secondary text-sm"
                >
                  {installWorkflow.isPending ? 'Updating...' : 'Update Workflow'}
                </button>
                {installWorkflow.isError && (
                  <p className="text-sm text-red-400">
                    Failed to update workflow. Please try again.
                  </p>
                )}
              </div>
            )}

            {!workflowLoading && !workflowStatus?.installed && (
              <div className="space-y-3">
                <p className="text-sm text-text-secondary">
                  The GHAGGA inline workflow has not been installed in this repository yet. Install
                  it to enable static analysis (Semgrep, Trivy, PMD/CPD) on pull requests.
                </p>
                <button
                  type="button"
                  onClick={() => installWorkflow.mutate()}
                  disabled={installWorkflow.isPending}
                  className="btn-primary"
                >
                  {installWorkflow.isPending ? 'Installing...' : 'Install Workflow'}
                </button>
                {installWorkflow.isError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
                    <p className="text-sm text-red-300">
                      Failed to install workflow. This may be due to branch protection rules on the
                      default branch.
                    </p>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* ── Save Button ──────────────────────────────────── */}
          {/* Enabled only after a successful load hydrated the form for this
              exact repo (PRODOPS-001) — see `canSave` above. */}
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={updateSettings.isPending || !canSave}
              className="btn-primary"
            >
              {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
            </button>
            {saveSuccess && (
              <span className="text-sm text-green-400">Settings saved successfully!</span>
            )}
            {updateSettings.isError && (
              <span className="text-sm text-red-400">Failed to save settings.</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
