import { Routes, Route } from 'react-router-dom';
import { Container, Title, Text, Stack } from '@mantine/core';
import { Layout } from './components/Layout/Layout';

function Home() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Title order={1}>Dashboard</Title>
        <Text c="dimmed">Welcome to Ghagga - Multi-provider AI code review platform</Text>
      </Stack>
    </Container>
  );
}

function Installations() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Title order={1}>Installations</Title>
        <Text c="dimmed">Manage your GitHub App installations</Text>
      </Stack>
    </Container>
  );
}

function Webhooks() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Title order={1}>Webhooks</Title>
        <Text c="dimmed">View webhook events and logs</Text>
      </Stack>
    </Container>
  );
}

function Settings() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md">
        <Title order={1}>Settings</Title>
        <Text c="dimmed">Configure your application settings</Text>
      </Stack>
    </Container>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/installations" element={<Installations />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
