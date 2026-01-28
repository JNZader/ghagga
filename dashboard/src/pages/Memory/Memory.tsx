import {
  Container,
  Title,
  Text,
  Stack,
  SimpleGrid,
  TextInput,
  Group,
  Paper,
  Loader,
  Center,
  Select,
  Badge,
  RingProgress,
} from '@mantine/core';
import { IconSearch, IconBrain, IconActivity, IconLink, IconTrendingUp } from '@tabler/icons-react';
import { useMemory, AssociationType } from '../../lib/hooks/useMemory';
import { AssociationCard } from '../../components/AssociationCard/AssociationCard';
import classes from './Memory.module.css';

const typeOptions = [
  { value: '', label: 'All Types' },
  { value: 'code_pattern', label: 'Code Pattern' },
  { value: 'review_pattern', label: 'Review Pattern' },
  { value: 'error_fix', label: 'Error Fix' },
  { value: 'style_preference', label: 'Style Preference' },
];

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color?: string;
}

function StatCard({ icon, label, value, color = 'blue' }: StatCardProps) {
  return (
    <Paper className={classes.statCard} p="md" radius="md" withBorder>
      <Group>
        <Badge size="lg" radius="md" variant="light" color={color} className={classes.statIcon}>
          {icon}
        </Badge>
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            {label}
          </Text>
          <Text size="xl" fw={700}>
            {value}
          </Text>
        </div>
      </Group>
    </Paper>
  );
}

export function Memory() {
  const { associations, stats, loading, error, filterByPattern, filterPattern } = useMemory({
    limit: 100,
    minWeight: 0.1,
  });

  const handleFilterChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    filterByPattern(event.target.value);
  };

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Center>
          <Text c="red">Error loading memory data: {error.message}</Text>
        </Center>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1} className={classes.title}>
            <IconBrain size={32} className={classes.titleIcon} />
            Memory Network
          </Title>
          <Text c="dimmed" mt="xs">
            Visualization of learned Hebbian associations between patterns
          </Text>
        </div>

        {stats && (
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
            <StatCard
              icon={<IconLink size={20} />}
              label="Total Connections"
              value={stats.totalConnections}
              color="blue"
            />
            <StatCard
              icon={<IconTrendingUp size={20} />}
              label="Avg Weight"
              value={`${Math.round(stats.avgWeight * 100)}%`}
              color="green"
            />
            <StatCard
              icon={<IconActivity size={20} />}
              label="Strong (>70%)"
              value={stats.strongConnections}
              color="violet"
            />
            <StatCard
              icon={<IconActivity size={20} />}
              label="Recent (24h)"
              value={stats.recentActivations}
              color="orange"
            />
          </SimpleGrid>
        )}

        {stats && stats.totalConnections > 0 && (
          <Paper p="md" radius="md" withBorder className={classes.breakdown}>
            <Text fw={600} mb="md">
              Association Type Breakdown
            </Text>
            <Group justify="space-around">
              {Object.entries(stats.typeBreakdown).map(([type, count]) => {
                const percent =
                  stats.totalConnections > 0
                    ? Math.round((count / stats.totalConnections) * 100)
                    : 0;
                const colors: Record<string, string> = {
                  code_pattern: 'blue',
                  review_pattern: 'green',
                  error_fix: 'red',
                  style_preference: 'violet',
                };
                const labels: Record<string, string> = {
                  code_pattern: 'Code',
                  review_pattern: 'Review',
                  error_fix: 'Error Fix',
                  style_preference: 'Style',
                };
                return (
                  <div key={type} className={classes.ringContainer}>
                    <RingProgress
                      size={80}
                      thickness={8}
                      roundCaps
                      sections={[{ value: percent, color: colors[type] }]}
                      label={
                        <Text ta="center" size="xs" fw={700}>
                          {percent}%
                        </Text>
                      }
                    />
                    <Text size="xs" c="dimmed" ta="center" mt={4}>
                      {labels[type]}
                    </Text>
                    <Text size="xs" fw={600} ta="center">
                      {count}
                    </Text>
                  </div>
                );
              })}
            </Group>
          </Paper>
        )}

        <Group>
          <TextInput
            placeholder="Filter by pattern..."
            leftSection={<IconSearch size={16} />}
            value={filterPattern}
            onChange={handleFilterChange}
            className={classes.filterInput}
          />
          <Select
            data={typeOptions}
            placeholder="Filter by type"
            clearable
            className={classes.typeSelect}
          />
        </Group>

        {loading ? (
          <Center py="xl">
            <Loader size="lg" />
          </Center>
        ) : associations.length === 0 ? (
          <Paper p="xl" radius="md" withBorder>
            <Center>
              <Stack align="center" gap="sm">
                <IconBrain size={48} opacity={0.3} />
                <Text c="dimmed">No associations found</Text>
                <Text size="sm" c="dimmed">
                  Associations are learned as the system processes code reviews
                </Text>
              </Stack>
            </Center>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {associations.map((association) => (
              <AssociationCard key={association.id} association={association} />
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Container>
  );
}
