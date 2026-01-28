import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  AppShell,
  Burger,
  Group,
  NavLink as MantineNavLink,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconDashboard,
  IconSettings,
  IconWebhook,
  IconUsers,
} from '@tabler/icons-react';
import classes from './Layout.module.css';

const navItems = [
  { to: '/', label: 'Dashboard', icon: IconDashboard },
  { to: '/installations', label: 'Installations', icon: IconUsers },
  { to: '/webhooks', label: 'Webhooks', icon: IconWebhook },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: 260,
        breakpoint: 'sm',
        collapsed: { mobile: !opened },
      }}
      padding="md"
    >
      <AppShell.Header className={classes.header}>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Title order={3} className={classes.logo}>
              Ghagga
            </Title>
          </Group>
          <Text size="sm" c="dimmed" visibleFrom="sm">
            AI Code Review Platform
          </Text>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" className={classes.navbar}>
        <AppShell.Section grow>
          {navItems.map((item) => (
            <MantineNavLink
              key={item.to}
              component={NavLink}
              to={item.to}
              label={item.label}
              leftSection={<item.icon size={18} stroke={1.5} />}
              active={location.pathname === item.to}
              onClick={close}
              className={classes.navLink}
            />
          ))}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
