import { useState, useEffect } from 'react';
import {
  Container,
  Title,
  Text,
  Stack,
  Card,
  Group,
  Avatar,
  Badge,
  Loader,
  Alert,
  SimpleGrid,
  Switch,
  Divider,
  Select,
  Textarea,
  Button,
} from '@mantine/core';
import { IconAlertCircle, IconGitBranch, IconSettings } from '@tabler/icons-react';
import { useSettings, RepoConfig } from '../../lib/hooks/useSettings';
import styles from './Settings.module.css';

const PROVIDERS = [
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'openai', label: 'GPT (OpenAI)' },
  { value: 'gemini', label: 'Gemini (Google)' },
];

const MODELS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  gemini: [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
};

interface RepoConfigFormProps {
  repo: RepoConfig;
  onUpdate: (id: string, updates: Partial<RepoConfig>) => Promise<void>;
}

function RepoConfigForm({ repo, onUpdate }: RepoConfigFormProps) {
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState(repo.rules || '');
  const [rulesModified, setRulesModified] = useState(false);

  useEffect(() => {
    setRules(repo.rules || '');
    setRulesModified(false);
  }, [repo.id, repo.rules]);

  const handleToggle = async (field: keyof RepoConfig, value: boolean) => {
    setSaving(true);
    try {
      await onUpdate(repo.id, { [field]: value });
    } finally {
      setSaving(false);
    }
  };

  const handleSelectChange = async (field: keyof RepoConfig, value: string | null) => {
    if (!value) return;
    setSaving(true);
    try {
      const updates: Partial<RepoConfig> = { [field]: value };
      if (field === 'provider') {
        const defaultModel = MODELS[value]?.[0]?.value;
        if (defaultModel) {
          updates.model = defaultModel;
        }
      }
      await onUpdate(repo.id, updates);
    } finally {
      setSaving(false);
    }
  };

  const handleRulesChange = (value: string) => {
    setRules(value);
    setRulesModified(value !== (repo.rules || ''));
  };

  const handleSaveRules = async () => {
    setSaving(true);
    try {
      await onUpdate(repo.id, { rules: rules || null });
      setRulesModified(false);
    } finally {
      setSaving(false);
    }
  };

  const availableModels = MODELS[repo.provider] || MODELS.claude;

  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder className={styles.configCard}>
      <Stack gap="md">
        <Group>
          <IconSettings size={20} />
          <Title order={4}>Configuration for {repo.repo_full_name}</Title>
        </Group>

        <Divider label="Review Settings" labelPosition="left" />

        <Switch
          label="Enable Reviews"
          description="Allow AI code reviews on pull requests"
          checked={repo.enabled}
          onChange={(e) => handleToggle('enabled', e.currentTarget.checked)}
          disabled={saving}
        />

        <Group grow>
          <Select
            label="Provider"
            data={PROVIDERS}
            value={repo.provider}
            onChange={(value) => handleSelectChange('provider', value)}
            disabled={saving}
          />
          <Select
            label="Model"
            data={availableModels}
            value={repo.model}
            onChange={(value) => handleSelectChange('model', value)}
            disabled={saving}
          />
        </Group>

        <Divider label="Advanced Features" labelPosition="left" />

        <Switch
          label="Workflow Engine"
          description="Enable multi-step review workflow with stages"
          checked={repo.workflow_enabled}
          onChange={(e) => handleToggle('workflow_enabled', e.currentTarget.checked)}
          disabled={saving}
        />

        <Switch
          label="Consensus Engine"
          description="Use multiple AI models to reach consensus on reviews"
          checked={repo.consensus_enabled}
          onChange={(e) => handleToggle('consensus_enabled', e.currentTarget.checked)}
          disabled={saving}
        />

        <Switch
          label="Hebbian Learning"
          description="Learn from past reviews to improve suggestions"
          checked={repo.hebbian_enabled}
          onChange={(e) => handleToggle('hebbian_enabled', e.currentTarget.checked)}
          disabled={saving}
        />

        <Divider label="Custom Rules" labelPosition="left" />

        <Textarea
          label="Review Rules"
          description="Custom instructions for the AI reviewer (markdown supported)"
          placeholder="Enter custom review rules...&#10;&#10;Example:&#10;- Focus on security issues&#10;- Flag any hardcoded credentials&#10;- Ensure proper error handling"
          value={rules}
          onChange={(e) => handleRulesChange(e.currentTarget.value)}
          minRows={6}
          autosize
          maxRows={15}
          disabled={saving}
        />

        {rulesModified && (
          <Group justify="flex-end">
            <Button
              variant="light"
              onClick={() => {
                setRules(repo.rules || '');
                setRulesModified(false);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveRules} loading={saving}>
              Save Rules
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

export function Settings() {
  const {
    installations,
    repoConfigs,
    loading,
    error,
    selectRepo,
    selectedRepo,
    updateRepoConfig,
  } = useSettings();

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Stack align="center" gap="md">
          <Loader size="lg" />
          <Text c="dimmed">Loading settings...</Text>
        </Stack>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Alert
          icon={<IconAlertCircle size={16} />}
          title="Error loading settings"
          color="red"
        >
          {error}
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Settings</Title>
          <Text c="dimmed">Configure your repository settings</Text>
        </div>

        <div>
          <Title order={3} mb="md">
            Installed Repositories
          </Title>
          {repoConfigs.length === 0 ? (
            <Alert color="blue" title="No repositories">
              No repositories have been configured yet. Install the GitHub App on
              your repositories to get started.
            </Alert>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              {repoConfigs.map((repo) => {
                const installation = installations.find(
                  (i) => i.id === repo.installation_id
                );
                const isSelected = selectedRepo?.id === repo.id;

                return (
                  <Card
                    key={repo.id}
                    shadow="sm"
                    padding="lg"
                    radius="md"
                    withBorder
                    className={`${styles.repoCard} ${isSelected ? styles.selected : ''}`}
                    onClick={() => selectRepo(repo.repo_full_name)}
                  >
                    <Group>
                      <Avatar
                        src={installation?.account_avatar_url}
                        alt={installation?.account_login}
                        radius="xl"
                        size="md"
                      />
                      <div style={{ flex: 1 }}>
                        <Group gap="xs">
                          <IconGitBranch size={16} />
                          <Text fw={500}>{repo.repo_full_name}</Text>
                        </Group>
                        <Group gap="xs" mt={4}>
                          <Badge
                            color={repo.enabled ? 'green' : 'gray'}
                            variant="light"
                            size="sm"
                          >
                            {repo.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                          {repo.workflow_enabled && (
                            <Badge color="blue" variant="light" size="sm">
                              Workflow
                            </Badge>
                          )}
                          {repo.consensus_enabled && (
                            <Badge color="violet" variant="light" size="sm">
                              Consensus
                            </Badge>
                          )}
                          {repo.hebbian_enabled && (
                            <Badge color="orange" variant="light" size="sm">
                              Hebbian
                            </Badge>
                          )}
                        </Group>
                      </div>
                    </Group>
                  </Card>
                );
              })}
            </SimpleGrid>
          )}
        </div>

        {selectedRepo && (
          <RepoConfigForm repo={selectedRepo} onUpdate={updateRepoConfig} />
        )}
      </Stack>
    </Container>
  );
}
