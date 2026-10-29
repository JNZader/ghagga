export const PR_EXPLANATIONS_DOCS_HREF = 'https://ghagga.javierzader.com/docs/#/pr-explanations';

/** Settings field the enable step must keep spotlighting. */
export const EXPLAIN_TOUR_TOGGLE_FIELD = 'explanationsEnabled' as const;

export type ExplainTourAnchor = 'card' | 'toggle' | 'usage' | 'limits' | 'docs';

export interface ExplainTourStep {
  id: 'what' | 'enable' | 'use' | 'limits' | 'docs';
  anchor: ExplainTourAnchor;
  /** Present when the step spotlights a real settings field. */
  field?: typeof EXPLAIN_TOUR_TOGGLE_FIELD;
  title: string;
  body: string;
}

export function buildExplainTourSteps(input: {
  scope: 'repository' | 'installation';
  editable: boolean;
}): ExplainTourStep[] {
  const enableBody = enableCopy(input);

  return [
    {
      id: 'what',
      anchor: 'card',
      title: 'A Q&A, not a review',
      body: '/ghagga explain answers one question about the current pull request. The reply does not include review findings.',
    },
    {
      id: 'enable',
      anchor: 'toggle',
      field: EXPLAIN_TOUR_TOGGLE_FIELD,
      title: 'Turn on explanationsEnabled',
      body: enableBody,
    },
    {
      id: 'use',
      anchor: 'usage',
      title: 'Ask on the GitHub pull request',
      body: 'Comment /ghagga explain followed by the question. The comment has to come from an OWNER, MEMBER, or COLLABORATOR.',
    },
    {
      id: 'limits',
      anchor: 'limits',
      title: 'It does not approve or request changes',
      body: 'An explanation never approves the pull request and never requests changes. It does not add a review mode.',
    },
    {
      id: 'docs',
      anchor: 'docs',
      title: 'The short guide',
      body: 'The guide covers who can ask, which replies are posted, and which outcomes stay silent.',
    },
  ];
}

function enableCopy(input: { scope: 'repository' | 'installation'; editable: boolean }): string {
  if (input.scope === 'installation') {
    return 'This switch is explanationsEnabled for the installation. Repositories on global settings inherit it. It stays off until you save.';
  }
  if (!input.editable) {
    return 'This repository inherits explanationsEnabled. Turn the switch on in Global Settings, or choose Custom and save it on this page.';
  }
  return 'This switch is explanationsEnabled. Turn on PR explanations and save. It stays off until you do.';
}
