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
} from '@mantine/core';
import { IconAlertCircle, IconGitBranch } from '@tabler/icons-react';
import { useSettings } from '../../lib/hooks/useSettings';
import styles from './Settings.module.css';

export function Settings() {
  const { installations, repoConfigs, loading, error, selectRepo, selectedRepo } =
    useSettings();

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
      </Stack>
    </Container>
  );
}
