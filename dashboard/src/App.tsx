import { Routes, Route } from 'react-router-dom';
import { Container, Title, Text, Stack } from '@mantine/core';
import { Memory } from './pages/Memory/Memory';

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
      <Route path="/" element={<Home />} />
      <Route path="/memory" element={<Memory />} />
    </Routes>
  );
}
