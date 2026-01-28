import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Container, Title, Text, Stack, Button, Group } from '@mantine/core'; // Ajusta el paquete según corresponda

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
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
    </Routes>
  );
}
