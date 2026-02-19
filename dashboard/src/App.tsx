import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Center, Loader, Title, Text, Stack, Button } from '@mantine/core';
import { Layout } from './components/Layout/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login/Login';

const Dashboard = lazy(() =>
  import('./pages/Dashboard').then(m => ({ default: m.Dashboard }))
);
const Reviews = lazy(() =>
  import('./pages/Reviews/Reviews').then(m => ({ default: m.Reviews }))
);
const Memory = lazy(() =>
  import('./pages/Memory/Memory').then(m => ({ default: m.Memory }))
);
const Settings = lazy(() =>
  import('./pages/Settings/Settings').then(m => ({ default: m.Settings }))
);

function PageLoader() {
  return (
    <Center h="50vh">
      <Loader size="lg" />
    </Center>
  );
}

function NotFound() {
  return (
    <Center h="50vh">
      <Stack align="center" gap="md">
        <Title order={2}>404 - Page Not Found</Title>
        <Text c="dimmed">The page you're looking for doesn't exist.</Text>
        <Button component="a" href="dashboard">
          Go to Dashboard
        </Button>
      </Stack>
    </Center>
  );
}

export function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard" replace />
            </ProtectedRoute>
          }
        />

        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
