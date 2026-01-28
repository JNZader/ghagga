import { Paper, Text, Group, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';
import styles from './StatsCard.module.css';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: ReactNode;
  color: string;
  description?: string;
}

export function StatsCard({ title, value, icon, color, description }: StatsCardProps) {
  return (
    <Paper className={styles.card} p="md" radius="md" withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text className={styles.title} c="dimmed" size="xs" tt="uppercase" fw={700}>
            {title}
          </Text>
          <Text className={styles.value} fw={700} size="xl">
            {value}
          </Text>
          {description && (
            <Text className={styles.description} c="dimmed" size="sm">
              {description}
            </Text>
          )}
        </div>
        <ThemeIcon color={color} variant="light" size={38} radius="md">
          {icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}
