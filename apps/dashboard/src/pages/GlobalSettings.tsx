import { type FormEvent, useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/Card';
import { ProviderChainEditor } from '@/components/settings/ProviderChainEditor';
import { KNOWN_MODELS, type ProviderEntryState } from '@/components/settings/ProviderEntry';
import { ToolGrid } from '@/components/settings/ToolGrid';
import {
  useInstallationSettings,
  useInstallations,
  useUpdateInstallationSettings,
} from '@/lib/api';
import type {
  ProviderChainUpdate,
  ProviderChainView,
  RegisteredTool,
  ReviewMode,
  SaaSProvider,
} from '@/lib/types';

export function GlobalSettings() {
  const { data: installations, isLoading: instLoading } = useInstallations();

  // Auto-select first installation, or let user pick
  const [selectedInstallation, setSelectedInstallation] = useState<number>(0);

  useEffect(() => {
    if (installations?.length && !selectedInstallation) {
      setSelectedInstallation(installations[0]?.id);
    }
  }, [installations, selectedInstallation]);

  const { data: settings, isLoading: settingsLoading } =
    useInstallationSettings(selectedInstallation);
  const updateSettings = useUpdateInstallationSettings();

  // ── Form state ──────────────────────────────────────────────
  const [enableSemgrep, setEnableSemgrep] = useState(true);
  const [enableTrivy, setEnableTrivy] = useState(true);
  const [enableCpd, setEnableCpd] = useState(false);
  const [enableMemory, setEnableMemory] = useState(true);
  const [enableBlastRadius, setEnableBlastRadius] = useState(false);
  const [aiReviewEnabled, setAiReviewEnabled] = useState(true);
  const [providerChain, setProviderChain] = useState<ProviderEntryState[]>([]);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('simple');
  const [customRules, setCustomRules] = useState('');
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [registeredTools, setRegisteredTools] = useState<RegisteredTool[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // ── Sync form with fetched settings ─────────────────────────
  useEffect(() => {
    if (settings) {
      setEnableSemgrep(settings.enableSemgrep);
      setEnableTrivy(settings.enableTrivy);
      setEnableCpd(settings.enableCpd);
      setEnableMemory(settings.enableMemory);
      setEnableBlastRadius(settings.enableBlastRadius ?? false);
      setAiReviewEnabled(settings.aiReviewEnabled);
      setReviewMode(settings.reviewMode as ReviewMode);
      setCustomRules(settings.customRules);
      setIgnorePatterns(settings.ignorePatterns.join('\n'));
      setDisabledTools(settings.disabledTools ?? []);
      setRegisteredTools(settings.registeredTools ?? []);

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
    }
  }, [settings]);

  // ── Save handler ────────────────────────────────────────────
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedInstallation) return;

    const chainUpdate: ProviderChainUpdate[] = providerChain.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      ...(entry.apiKey.trim() ? { apiKey: entry.apiKey.trim() } : {}),
      ...(entry.provider === 'cli-bridge' && entry.cliModel ? { cliModel: entry.cliModel } : {}),
      ...(entry.provider === 'gateway' && entry.gatewayUrl ? { gatewayUrl: entry.gatewayUrl } : {}),
    }));

    await updateSettings.mutateAsync({
      installationId: selectedInstallation,
      aiReviewEnabled,
      providerChain: chainUpdate,
      reviewMode,
      enableSemgrep,
      enableTrivy,
      enableCpd,
      enableMemory,
      enableBlastRadius,
      customRules,
      ignorePatterns: ignorePatterns
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
      disabledTools,
    });

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const selectedInst = installations?.find((i) => i.id === selectedInstallation);
  const isLoading = instLoading || settingsLoading;

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Global Settings</h1>
          <p className="mt-1 text-text-secondary">Default settings inherited by all repositories</p>
        </div>

        {installations && installations.length > 1 && (
          <select
            value={selectedInstallation}
            onChange={(e) => setSelectedInstallation(Number(e.target.value))}
            className="select-field w-64"
          >
            {installations.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.accountLogin} ({inst.accountType})
              </option>
            ))}
          </select>
        )}
      </div>

      {!selectedInstallation || instLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-6">
          {/* Info banner */}
          <div className="rounded-lg border border-primary-600/30 bg-primary-600/10 p-4">
            <p className="text-sm text-primary-300">
              <strong>Global defaults</strong> — These settings are inherited by all repositories
              under <strong>{selectedInst?.accountLogin ?? 'this installation'}</strong> unless a
              repository has custom settings configured.
            </p>
          </div>

          {/* ── Workflow Installation ────────────────────────── */}
          <Card>
            <CardHeader
              title="Inline Workflow Installation"
              description="GHAGGA injects a GitHub Actions workflow directly into each repository for static analysis"
            />
            <div className="rounded-md border border-primary-600/30 bg-primary-600/10 p-3">
              <p className="text-sm text-primary-300">
                Workflows are automatically injected when repositories are added to the GitHub App
                installation. To manually install or check status for a specific repository, go to{' '}
                <strong>Repository Settings</strong> and select the repository.
              </p>
            </div>
          </Card>

          {/* ── Static Analysis ──────────────────────────────── */}
          <Card>
            <CardHeader
              title="Static Analysis"
              description="Default static analysis tools for all repositories"
            />
            {registeredTools.length > 0 ? (
              <ToolGrid
                tools={registeredTools}
                disabledTools={disabledTools}
                onToggle={(updatedDisabledTools) => {
                  setDisabledTools(updatedDisabledTools);
                }}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  {
                    label: 'Semgrep (security + patterns)',
                    value: enableSemgrep,
                    setter: setEnableSemgrep,
                  },
                  { label: 'Trivy (vulnerabilities)', value: enableTrivy, setter: setEnableTrivy },
                  { label: 'PMD/CPD (code duplication)', value: enableCpd, setter: setEnableCpd },
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
            {/* Memory toggle — always shown, separate from tool grid */}
            <div className="mt-4 border-t border-surface-border pt-4">
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3 transition-colors hover:border-surface-border/80">
                <input
                  type="checkbox"
                  checked={enableMemory}
                  onChange={(e) => setEnableMemory(e.target.checked)}
                  className="h-4 w-4 accent-primary-600"
                />
                <span className="text-sm text-text-primary">Memory (project knowledge)</span>
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
                  When enabled, GHAGGA analyzes which files are <em>actually impacted</em> by the
                  changed code (via import/call graph) and limits the review to those files only —
                  reducing tokens by up to 6×.
                </p>
                <p className="text-yellow-400/80">
                  ⚡ The dependency graph is built automatically on the first review after enabling.
                  The <strong>second review onwards</strong> will use blast-radius filtering.
                </p>
              </div>
            )}
          </Card>

          {/* ── AI Review ────────────────────────────────────── */}
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader
                title="AI Review"
                description="Default LLM provider chain for all repositories"
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
                  <label className="mb-2 block text-sm font-medium text-text-primary">
                    Provider Chain
                    <span className="ml-2 font-normal text-text-secondary">
                      (ordered by priority — primary first, fallbacks below)
                    </span>
                  </label>
                  <ProviderChainEditor chain={providerChain} onChange={setProviderChain} />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-text-primary">
                    Review Mode
                  </label>
                  <div className="flex gap-4">
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
                    Simple: 1 LLM call &middot; Workflow: 5 specialist agents &middot; Consensus: 3
                    stances debate
                  </p>
                </div>
              </div>
            )}
          </Card>

          {/* ── Advanced Settings ─────────────────────────────── */}
          <Card>
            <CardHeader
              title="Advanced"
              description="Default custom rules and file ignore patterns"
            />

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

          {/* ── Save Button ──────────────────────────────────── */}
          <div className="flex items-center gap-4">
            <button type="submit" disabled={updateSettings.isPending} className="btn-primary">
              {updateSettings.isPending ? 'Saving...' : 'Save Global Settings'}
            </button>
            {saveSuccess && (
              <span className="text-sm text-green-400">Global settings saved successfully!</span>
            )}
            {updateSettings.isError && (
              <span className="text-sm text-red-400">Failed to save global settings.</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
