import { Table, Badge, Text, Pagination, Group, Select, Skeleton } from '@mantine/core';
import type { Review, ReviewStatus, PaginationState } from '../../lib/types';
import classes from './ReviewTable.module.css';

interface ReviewTableProps {
  reviews: Review[];
  loading: boolean;
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRowClick: (review: Review) => void;
}

const statusColors: Record<ReviewStatus, string> = {
  passed: 'green',
  failed: 'red',
  pending: 'yellow',
  in_progress: 'blue',
  skipped: 'gray',
};

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '10 per page' },
  { value: '25', label: '25 per page' },
  { value: '50', label: '50 per page' },
];

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function ReviewTable({
  reviews,
  loading,
  pagination,
  onPageChange,
  onPageSizeChange,
  onRowClick,
}: ReviewTableProps) {
  const totalPages = Math.ceil(pagination.total / pagination.pageSize);

  if (loading) {
    return (
      <div className={classes.container}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Repository</Table.Th>
              <Table.Th>PR</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Summary</Table.Th>
              <Table.Th>Date</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <Table.Tr key={i}>
                <Table.Td><Skeleton height={20} /></Table.Td>
                <Table.Td><Skeleton height={20} width={60} /></Table.Td>
                <Table.Td><Skeleton height={20} width={80} /></Table.Td>
                <Table.Td><Skeleton height={20} /></Table.Td>
                <Table.Td><Skeleton height={20} width={120} /></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className={classes.empty}>
        <Text c="dimmed">No reviews found</Text>
      </div>
    );
  }

  return (
    <div className={classes.container}>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Repository</Table.Th>
            <Table.Th>PR</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Summary</Table.Th>
            <Table.Th>Date</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {reviews.map(review => (
            <Table.Tr
              key={review.id}
              className={classes.row}
              onClick={() => onRowClick(review)}
            >
              <Table.Td>
                <Text size="sm" fw={500}>{review.repo_full_name}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  #{review.pr_number}
                  {review.pr_title && (
                    <Text span c="dimmed" ml={4}>
                      {truncateText(review.pr_title, 30)}
                    </Text>
                  )}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge color={statusColors[review.status]} variant="light">
                  {review.status.replace('_', ' ')}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed" lineClamp={1}>
                  {review.result_summary}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {formatDate(review.created_at)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group justify="space-between" mt="md" className={classes.footer}>
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            Showing {(pagination.page - 1) * pagination.pageSize + 1} to{' '}
            {Math.min(pagination.page * pagination.pageSize, pagination.total)} of{' '}
            {pagination.total} reviews
          </Text>
          <Select
            size="xs"
            value={String(pagination.pageSize)}
            onChange={value => value && onPageSizeChange(Number(value))}
            data={PAGE_SIZE_OPTIONS}
            w={130}
          />
        </Group>
        <Pagination
          value={pagination.page}
          onChange={onPageChange}
          total={totalPages}
          size="sm"
        />
      </Group>
    </div>
  );
}
