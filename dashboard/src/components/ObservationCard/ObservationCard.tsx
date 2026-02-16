import { Card, Text, Badge, Group, Stack, Progress, Code, Tooltip } from '@mantine/core';
import { IconEye, IconClock } from '@tabler/icons-react';
import type { MemoryObservation, ObservationType } from '../../lib/hooks/useMemoryObservations';
import classes from './ObservationCard.module.css';

interface ObservationCardProps {
  observation: MemoryObservation;
}

const typeColors: Record<ObservationType, string> = {
  decision: 'blue',
  architecture: 'indigo',
  bugfix: 'red',
  pattern: 'green',
  config: 'gray',
  discovery: 'orange',
  learning: 'violet',
  session_summary: 'cyan',
};

const typeLabels: Record<ObservationType, string> = {
  decision: 'Decision',
  architecture: 'Architecture',
  bugfix: 'Bug Fix',
  pattern: 'Pattern',
  config: 'Config',
  discovery: 'Discovery',
  learning: 'Learning',
  session_summary: 'Summary',
};

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'green';
  if (confidence >= 0.6) return 'blue';
  if (confidence >= 0.4) return 'yellow';
  return 'gray';
}

export function ObservationCard({ observation }: ObservationCardProps) {
  const {
    observation_type,
    title,
    what_happened,
    where_in_code,
    what_was_learned,
    tags,
    confidence,
    created_at,
  } = observation;

  const confidencePercent = Math.round(confidence * 100);
  const confidenceColor = getConfidenceColor(confidence);

  return (
    <Card className={classes.card} padding="md" radius="md" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Badge color={typeColors[observation_type]} variant="light" size="sm">
            {typeLabels[observation_type]}
          </Badge>
          <Tooltip label={`Confidence: ${confidencePercent}%`}>
            <Badge color={confidenceColor} variant="filled" size="sm">
              {confidencePercent}%
            </Badge>
          </Tooltip>
        </Group>

        <Text size="sm" fw={600} lineClamp={2}>
          {title}
        </Text>

        {what_happened && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            {what_happened}
          </Text>
        )}

        {where_in_code && (
          <Code className={classes.codeLocation}>{where_in_code}</Code>
        )}

        {what_was_learned && (
          <div className={classes.learned}>
            <Text size="xs" fw={500} c="teal">
              Learned: {what_was_learned}
            </Text>
          </div>
        )}

        {tags.length > 0 && (
          <Group gap={4}>
            {tags.slice(0, 4).map((tag) => (
              <Badge key={tag} size="xs" variant="outline" color="gray">
                {tag}
              </Badge>
            ))}
          </Group>
        )}

        <Progress
          value={confidencePercent}
          color={confidenceColor}
          size="xs"
          radius="xl"
        />

        <Group gap="xs" className={classes.meta}>
          <Tooltip label="Confidence">
            <Group gap={4}>
              <IconEye size={14} />
              <Text size="xs" c="dimmed">
                {confidencePercent}%
              </Text>
            </Group>
          </Tooltip>
          <Tooltip label="Created">
            <Group gap={4}>
              <IconClock size={14} />
              <Text size="xs" c="dimmed">
                {formatTimeAgo(created_at)}
              </Text>
            </Group>
          </Tooltip>
        </Group>
      </Stack>
    </Card>
  );
}
