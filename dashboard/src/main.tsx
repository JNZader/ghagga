import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { BrowserRouter } from 'react-router-dom';
import { theme } from './theme';
import { App } from './App';

import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <BrowserRouter basename="/ghagga">
        <App />
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>
);
