import { useState } from 'react';
import {
  Container,
  Title,
  Text,
  Stack,
  Group,
  Select,
  TextInput,
  Alert,
  Modal,
  Badge,
  Divider,
  Code,
  ScrollArea,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconAlertCircle, IconFilter } from '@tabler/icons-react';
import { useReviews } from '../../lib/hooks/useReviews';
import { ReviewTable } from '../../components/ReviewTable/ReviewTable';
import type { Review, ReviewStatus } from '../../lib/types';
import classes from './Reviews.module.css';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'skipped', label: 'Skipped' },
];

const statusColors: Record<ReviewStatus, string> = {
  passed: 'green',
  failed: 'red',
  pending: 'yellow',
  in_progress: 'blue',
  skipped: 'gray',
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Reviews() {
  const {
    reviews,
    loading,
    error,
    pagination,
    filters,
    repos,
    setPage,
    setPageSize,
    setFilters,
  } = useReviews();

  const [searchValue, setSearchValue] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchValue, 300);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);

  const handleStatusChange = (value: string | null) => {
    setFilters({
      ...filters,
      status: (value || undefined) as ReviewStatus | undefined,
    });
  };

  const handleRepoChange = (value: string | null) => {
    setFilters({
      ...filters,
      repo: value || undefined,
    });
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setSearchValue(value);
  };

  if (debouncedSearch !== filters.search) {
    setFilters({
      ...filters,
      search: debouncedSearch || undefined,
    });
  }

  const repoOptions = [
    { value: '', label: 'All repositories' },
    ...repos.map(repo => ({ value: repo, label: repo })),
  ];

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={1}>Reviews</Title>
          <Text c="dimmed">View and search code review history</Text>
        </div>

        {error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            title="Error loading reviews"
            color="red"
          >
            {error}
          </Alert>
        )}

        <Group gap="md" className={classes.filters}>
          <TextInput
            placeholder="Search reviews..."
            leftSection={<IconSearch size={16} />}
            value={searchValue}
            onChange={handleSearchChange}
            className={classes.searchInput}
          />
          <Select
            placeholder="Filter by status"
            leftSection={<IconFilter size={16} />}
            data={STATUS_OPTIONS}
            value={filters.status || ''}
            onChange={handleStatusChange}
            clearable={false}
            w={180}
          />
          <Select
            placeholder="Filter by repository"
            data={repoOptions}
            value={filters.repo || ''}
            onChange={handleRepoChange}
            clearable={false}
            searchable
            w={250}
          />
        </Group>

        <ReviewTable
          reviews={reviews}
          loading={loading}
          pagination={pagination}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRowClick={setSelectedReview}
        />

        <Modal
          opened={selectedReview !== null}
          onClose={() => setSelectedReview(null)}
          title="Review Details"
          size="lg"
        >
          {selectedReview && (
            <Stack gap="md">
              <Group justify="space-between">
                <div>
                  <Text fw={600} size="lg">{selectedReview.repo_full_name}</Text>
                  <Text c="dimmed" size="sm">
                    PR #{selectedReview.pr_number}
                    {selectedReview.pr_title && ` - ${selectedReview.pr_title}`}
                  </Text>
                </div>
                <Badge
                  color={statusColors[selectedReview.status]}
                  variant="light"
                  size="lg"
                >
                  {selectedReview.status.replace('_', ' ')}
                </Badge>
              </Group>

              <Divider />

              <div>
                <Text fw={500} mb="xs">Summary</Text>
                <Text>{selectedReview.result_summary}</Text>
              </div>

              {selectedReview.files_reviewed.length > 0 && (
                <div>
                  <Text fw={500} mb="xs">
                    Files Reviewed ({selectedReview.files_reviewed.length})
                  </Text>
                  <ScrollArea h={150}>
                    <Stack gap={4}>
                      {selectedReview.files_reviewed.map((file, index) => (
                        <Code key={index} block={false}>{file}</Code>
                      ))}
                    </Stack>
                  </ScrollArea>
                </div>
              )}

              <Divider />

              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  Created: {formatDate(selectedReview.created_at)}
                </Text>
                {selectedReview.updated_at && (
                  <Text size="sm" c="dimmed">
                    Updated: {formatDate(selectedReview.updated_at)}
                  </Text>
                )}
              </Group>
            </Stack>
          )}
        </Modal>
      </Stack>
    </Container>
  );
}
