import { Routes, Route } from 'react-router-dom';
import { Container, Title, Text, Stack, Button, Group } from '@mantine/core';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login/Login';

function Home() {
  const { user, signOut } = useAuth();

  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={1}>Ghagga Dashboard</Title>
          <Button variant="subtle" onClick={() => signOut()}>
            Sign out
          </Button>
        </Group>
        <Text c="dimmed">
          Welcome, {user?.user_metadata?.user_name ?? user?.email}
        </Text>
        <Text c="dimmed">Multi-provider AI code review platform</Text>
      </Stack>
    </Container>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
