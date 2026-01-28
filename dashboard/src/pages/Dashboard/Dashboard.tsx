import { Container, Title, Text, SimpleGrid, Stack, Loader, Alert, Paper, RingProgress, Group, Center } from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  IconFileCheck,
  IconFileX,
  IconClock,
  IconChartBar,
  IconAlertCircle,
} from '@tabler/icons-react';
import { StatsCard } from '../../components/StatsCard';
import { useStats } from '../../lib/hooks/useStats';
import styles from './Dashboard.module.css';

export function Dashboard() {
  const { stats, loading, error } = useStats();

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Stack align="center" gap="md">
          <Loader size="lg" />
          <Text c="dimmed">Loading dashboard...</Text>
        </Stack>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red">
          {error}
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Dashboard</Title>
          <Text c="dimmed" mt="xs">
            Overview of your code review metrics
          </Text>
        </div>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
          <StatsCard
            title="Total Reviews"
            value={stats?.totalReviews ?? 0}
            icon={<IconChartBar size={20} />}
            color="blue"
            description="All time reviews"
          />
          <StatsCard
            title="Passed"
            value={stats?.passedReviews ?? 0}
            icon={<IconFileCheck size={20} />}
            color="green"
            description="Successful reviews"
          />
          <StatsCard
            title="Failed"
            value={stats?.failedReviews ?? 0}
            icon={<IconFileX size={20} />}
            color="red"
            description="Reviews with issues"
          />
          <StatsCard
            title="Pending"
            value={stats?.pendingReviews ?? 0}
            icon={<IconClock size={20} />}
            color="yellow"
            description="In progress"
          />
        </SimpleGrid>

        <Paper className={styles.chartSection} p="md" radius="md" withBorder>
          <Title order={3} mb="md">
            Reviews Over Time
          </Title>
          {stats?.reviewsOverTime && stats.reviewsOverTime.length > 0 ? (
            <AreaChart
              h={300}
              data={stats.reviewsOverTime}
              dataKey="date"
              series={[
                { name: 'passed', color: 'green.6' },
                { name: 'failed', color: 'red.6' },
              ]}
              curveType="monotone"
              withLegend
              legendProps={{ verticalAlign: 'bottom', height: 50 }}
            />
          ) : (
            <Text c="dimmed" size="sm">
              No review data available yet
            </Text>
          )}
        </Paper>

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Paper className={styles.chartSection} p="md" radius="md" withBorder>
            <Title order={3} mb="md">
              Pass Rate
            </Title>
            <Center>
              <RingProgress
                size={200}
                thickness={20}
                roundCaps
                sections={[
                  { value: stats?.passRate ?? 0, color: 'green' },
                  { value: 100 - (stats?.passRate ?? 0), color: 'red' },
                ]}
                label={
                  <Center>
                    <Stack gap={0} align="center">
                      <Text size="xl" fw={700}>
                        {stats?.passRate ?? 0}%
                      </Text>
                      <Text size="xs" c="dimmed">
                        Pass Rate
                      </Text>
                    </Stack>
                  </Center>
                }
              />
            </Center>
          </Paper>

          <Paper className={styles.chartSection} p="md" radius="md" withBorder>
            <Title order={3} mb="md">
              Review Breakdown
            </Title>
            <Stack gap="md">
              <Group justify="space-between">
                <Text c="dimmed">Passed</Text>
                <Text fw={500} c="green">
                  {stats?.passedReviews ?? 0}
                </Text>
              </Group>
              <Group justify="space-between">
                <Text c="dimmed">Failed</Text>
                <Text fw={500} c="red">
                  {stats?.failedReviews ?? 0}
                </Text>
              </Group>
              <Group justify="space-between">
                <Text c="dimmed">Pending</Text>
                <Text fw={500} c="yellow">
                  {stats?.pendingReviews ?? 0}
                </Text>
              </Group>
              <Group justify="space-between">
                <Text c="dimmed">Total</Text>
                <Text fw={500}>{stats?.totalReviews ?? 0}</Text>
              </Group>
            </Stack>
          </Paper>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
