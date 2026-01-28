import { Card, Text, Badge, Group, Stack, Progress, Tooltip } from '@mantine/core';
import { IconLink, IconActivity, IconClock } from '@tabler/icons-react';
import type { HebbianAssociation, AssociationType } from '../../lib/hooks/useMemory';
import classes from './AssociationCard.module.css';

interface AssociationCardProps {
  association: HebbianAssociation;
}

const typeColors: Record<AssociationType, string> = {
  code_pattern: 'blue',
  review_pattern: 'green',
  error_fix: 'red',
  style_preference: 'violet',
};

const typeLabels: Record<AssociationType, string> = {
  code_pattern: 'Code Pattern',
  review_pattern: 'Review Pattern',
  error_fix: 'Error Fix',
  style_preference: 'Style Preference',
};

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}

function getWeightColor(weight: number): string {
  if (weight >= 0.8) return 'green';
  if (weight >= 0.6) return 'blue';
  if (weight >= 0.4) return 'yellow';
  return 'gray';
}

export function AssociationCard({ association }: AssociationCardProps) {
  const {
    source_pattern,
    target_pattern,
    association_type,
    weight,
    activation_count,
    last_activated_at,
  } = association;

  const weightPercent = Math.round(weight * 100);
  const weightColor = getWeightColor(weight);

  return (
    <Card className={classes.card} padding="md" radius="md" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Badge color={typeColors[association_type]} variant="light" size="sm">
            {typeLabels[association_type]}
          </Badge>
          <Tooltip label={`Weight: ${weightPercent}%`}>
            <Badge color={weightColor} variant="filled" size="sm">
              {weightPercent}%
            </Badge>
          </Tooltip>
        </Group>

        <div className={classes.patterns}>
          <div className={classes.pattern}>
            <Text size="sm" fw={500} truncate>
              {source_pattern}
            </Text>
          </div>
          <div className={classes.connector}>
            <IconLink size={16} className={classes.linkIcon} />
          </div>
          <div className={classes.pattern}>
            <Text size="sm" fw={500} truncate>
              {target_pattern}
            </Text>
          </div>
        </div>

        <Progress
          value={weightPercent}
          color={weightColor}
          size="sm"
          radius="xl"
          className={classes.progress}
        />

        <Group gap="xs" className={classes.meta}>
          <Tooltip label="Activation count">
            <Group gap={4}>
              <IconActivity size={14} />
              <Text size="xs" c="dimmed">
                {activation_count}
              </Text>
            </Group>
          </Tooltip>
          <Tooltip label="Last activated">
            <Group gap={4}>
              <IconClock size={14} />
              <Text size="xs" c="dimmed">
                {formatTimeAgo(last_activated_at)}
              </Text>
            </Group>
          </Tooltip>
        </Group>
      </Stack>
    </Card>
  );
}
