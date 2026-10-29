import { Card, CardHeader } from '@/components/Card';
import { PR_EXPLANATIONS_DOCS_HREF } from '@/components/explain-tour/steps';

interface PrExplanationsSectionProps {
  mode: 'edit' | 'inherited';
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  description: string;
}

/**
 * Shared PR explanations block for repository and installation settings.
 * Tour anchors stay on the real controls: the toggle wraps the
 * `explanationsEnabled` checkbox whenever the page can edit it.
 */
export function PrExplanationsSection({
  mode,
  enabled,
  onChange,
  description,
}: PrExplanationsSectionProps) {
  return (
    <Card>
      <div data-explain-tour="card">
        {mode === 'edit' ? (
          <div className="flex items-center justify-between">
            <CardHeader title="PR explanations" description={description} />
            <label data-explain-tour="toggle" className="flex cursor-pointer items-center gap-3">
              <span className="text-sm text-text-secondary">
                {enabled ? 'Enabled' : 'Disabled'}
              </span>
              <div className="relative">
                <input
                  id="explanationsEnabled"
                  name="explanationsEnabled"
                  type="checkbox"
                  aria-label="PR explanations"
                  checked={enabled}
                  onChange={(event) => onChange?.(event.target.checked)}
                  className="peer sr-only"
                />
                <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
                <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
              </div>
            </label>
          </div>
        ) : (
          <>
            <CardHeader title="PR explanations" description={description} />
            <p data-explain-tour="toggle" className="text-sm text-text-secondary">
              <strong className="text-text-primary">/ghagga explain:</strong>{' '}
              {enabled ? 'Enabled' : 'Disabled'}
            </p>
          </>
        )}
        <p data-explain-tour="usage" className="mt-2 text-xs text-text-secondary">
          {mode === 'edit' ? (
            <>
              Off by default. An OWNER, MEMBER, or COLLABORATOR comments{' '}
              <code>{'/ghagga explain <question>'}</code> on the GitHub pull request.
            </>
          ) : (
            <>
              Ask with <code>{'/ghagga explain <question>'}</code> on the GitHub pull request after
              this opt-in is on.
            </>
          )}
        </p>
        <p data-explain-tour="limits" className="mt-1 text-xs text-text-secondary">
          GHAGGA replies in the conversation. It does not approve or request changes, and it does
          not post review findings or add a review mode.
        </p>
        <p className="mt-2 text-xs">
          <a
            data-explain-tour="docs"
            href={PR_EXPLANATIONS_DOCS_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-400 underline hover:text-primary-300"
          >
            PR explanations guide
          </a>
        </p>
      </div>
    </Card>
  );
}
