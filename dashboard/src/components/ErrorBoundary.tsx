import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Title, Text, Button, Container, Stack } from '@mantine/core';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Container size="sm" py="xl">
          <Stack align="center" gap="md">
            <Title order={2}>Something went wrong</Title>
            <Text c="dimmed" ta="center">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </Text>
            <Button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = import.meta.env.BASE_URL || '/';
              }}
            >
              Return to Dashboard
            </Button>
          </Stack>
        </Container>
      );
    }

    return this.props.children;
  }
}
