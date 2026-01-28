import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Title, Text, Button, Stack, Paper } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import classes from './Login.module.css';

export function Login() {
  const { user, loading, signInWithGitHub } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user && !loading) {
      navigate('/', { replace: true });
    }
  }, [user, loading, navigate]);

  const handleLogin = async () => {
    await signInWithGitHub();
  };

  return (
    <Container size="xs" className={classes.container}>
      <Paper radius="md" p="xl" withBorder className={classes.paper}>
        <Stack gap="lg" align="center">
          <Title order={2}>Welcome to Ghagga</Title>
          <Text c="dimmed" ta="center">
            Multi-provider AI code review platform
          </Text>
          <Button
            leftSection={<IconBrandGithub size={20} />}
            onClick={handleLogin}
            size="lg"
            fullWidth
            loading={loading}
          >
            Sign in with GitHub
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
}
