import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/Card';
import { DelegatedCiEditor } from '@/components/settings/DelegatedCiEditor';
import { ProviderChainEditor } from '@/components/settings/ProviderChainEditor';
import type { ProviderEntryState } from '@/components/settings/ProviderEntry';
import { ToolGrid } from '@/components/settings/ToolGrid';
import { useRepositories, useSettings, useUpdateSettings } from '@/lib/api';
import { useSelectedRepo } from '@/lib/repo-context';
import type {
  DelegatedCiPolicy,
  ProviderChainUpdate,
  ProviderChainView,
  RegisteredTool,
  ReviewMode,
} from '@/lib/types';

export function Settings() {
  const { selectedRepo, setSelectedRepo } = useSelectedRepo();
  const { data: repos } = useRepositories();
  const { data: settings, isLoading } = useSettings(selectedRepo);
  const updateSettings = useUpdateSettings();

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

  // ── Delegated CI policy (repo-scoped, not inherited) ──────
  const [delegatedCiPolicy, setDelegatedCiPolicy] = useState<DelegatedCiPolicy | null>(null);

  // ── Other settings ──────────────────────────────────────────
  const [customRules, setCustomRules] = useState('');
  const [ignorePatterns, setIgnorePatterns] = useState('');

  // ── Save feedback ───────────────────────────────────────────
  const [saveSuccess, setSaveSuccess] = useState(false);

  // ── Sync form state with fetched settings ───────────────────
  useEffect(() => {
    if (settings) {
      setUseGlobalSettings(settings.useGlobalSettings);
      setEnableSemgrep(settings.enableSemgrep);
      setEnableTrivy(settings.enableTrivy);
      setEnableCpd(settings.enableCpd);
      setEnableMemory(settings.enableMemory);
      setAiReviewEnabled(settings.aiReviewEnabled);
      setReviewMode(settings.reviewMode);
      setCustomRules(settings.customRules);
      setIgnorePatterns(settings.ignorePatterns.join('\n'));
      setDisabledTools(settings.disabledTools ?? []);
      setRegisteredTools(settings.registeredTools ?? []);
      setDelegatedCiPolicy((settings.delegatedCiPolicy as DelegatedCiPolicy | null) ?? null);

      // Map server chain view to local entry state
      setProviderChain(
        settings.providerChain.map((entry: ProviderChainView) => ({
          provider: entry.provider,
          model: entry.model,
          apiKey: '',
          // Include the saved model so the <select> can display it
          availableModels: entry.model ? [entry.model] : [],
          hasExistingKey: entry.hasApiKey,
          maskedApiKey: entry.maskedApiKey,
          validated: entry.hasApiKey || entry.provider === 'github',
        })),
      );
    }
  }, [settings]);

  // ── Handle global toggle ────────────────────────────────────
  const handleGlobalToggle = async (useGlobal: boolean) => {
    setUseGlobalSettings(useGlobal);
    if (!selectedRepo) return;

    // If switching to custom and the repo has no chain yet, pre-fill from global
    if (!useGlobal && settings?.globalSettings && providerChain.length === 0) {
      setProviderChain(
        settings.globalSettings.providerChain.map((entry: ProviderChainView) => ({
          provider: entry.provider,
          model: entry.model,
          apiKey: '',
          availableModels: entry.model ? [entry.model] : [],
          hasExistingKey: entry.hasApiKey,
          maskedApiKey: entry.maskedApiKey,
          validated: entry.hasApiKey || entry.provider === 'github',
        })),
      );
      if (settings.globalSettings) {
        setAiReviewEnabled(settings.globalSettings.aiReviewEnabled);
        setReviewMode(settings.globalSettings.reviewMode as ReviewMode);
        setEnableSemgrep(settings.globalSettings.enableSemgrep);
        setEnableTrivy(settings.globalSettings.enableTrivy);
        setEnableCpd(settings.globalSettings.enableCpd);
        setEnableMemory(settings.globalSettings.enableMemory);
        setCustomRules(settings.globalSettings.customRules);
        setIgnorePatterns(settings.globalSettings.ignorePatterns.join('\n'));
      }
    }
  };

  // ── Save handler ────────────────────────────────────────────
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRepo) return;

    if (useGlobalSettings) {
      // Only save the toggle + delegated CI (repo-scoped, not inherited)
      await updateSettings.mutateAsync({
        repoFullName: selectedRepo,
        useGlobalSettings: true,
        delegatedCiPolicy,
      });
    } else {
      const chainUpdate: ProviderChainUpdate[] = providerChain.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        ...(entry.apiKey.trim() ? { apiKey: entry.apiKey.trim() } : {}),
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
        disabledTools,
        customRules,
        ignorePatterns: ignorePatterns
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean),
        delegatedCiPolicy,
      });
    }

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
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

              {/* ── Delegated CI ──────────────────────────────────── */}
              <DelegatedCiEditor value={delegatedCiPolicy} onChange={setDelegatedCiPolicy} />
            </>
          ) : null}

          {/* ── Delegated CI (always visible — repo-only, not inherited) ── */}
          {useGlobalSettings && (
            <DelegatedCiEditor value={delegatedCiPolicy} onChange={setDelegatedCiPolicy} />
          )}

          {/* ── Save Button ──────────────────────────────────── */}
          <div className="flex items-center gap-4">
            <button type="submit" disabled={updateSettings.isPending} className="btn-primary">
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
