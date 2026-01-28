import { Routes, Route, Navigate } from 'react-router-dom';
import { Container, Title, Text, Stack, Button, Group } from '@mantine/core';
import { Dashboard } from './pages/Dashboard';
import { Reviews } from './pages/Reviews/Reviews';

function Home() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Title order={1}>Ghagga Dashboard</Title>
        <Text c="dimmed">Multi-provider AI code review platform</Text>
      </Stack>
    </Container>
  );
}

export function App() {
  return (
    <Routes>
      {/* Puedes elegir: redirigir o mostrar Home */}
      {/* Opción A: redirigir directamente */}
      {/* <Route path="/" element={<Navigate to="/dashboard" replace />} /> */}

      {/* Opción B: mostrar Home */}
      <Route path="/" element={<Home />} />

      <Route
        path="/dashboard"
        element={
          <Container>
            <Stack>
              <Title order={2}>Bienvenido al Dashboard</Title>
              <Text>Este es tu panel principal</Text>
              <Group>
                <Button>Acción 1</Button>
                <Button variant="outline">Acción 2</Button>
              </Group>
            </Stack>
            <Dashboard />
          </Container>
        }
      />
      <Route path="/reviews" element={<Reviews />} />
    </Routes>
  );
}
