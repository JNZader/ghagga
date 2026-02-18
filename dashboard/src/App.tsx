import { Routes, Route, Navigate } from 'react-router-dom';
import { Container, Title, Text, Stack, Button, Group } from '@mantine/core';
import { Dashboard } from './pages/Dashboard';
import { Reviews } from './pages/Reviews/Reviews';
import { Memory } from './pages/Memory/Memory';
import { Settings } from './pages/Settings/Settings';
import { Login } from './pages/Login/Login';
import { ProtectedRoute } from './components/ProtectedRoute';

export function App() {
  return (
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
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reviews"
        element={
          <ProtectedRoute>
            <Reviews />
          </ProtectedRoute>
        }
      />
      <Route
        path="/memory"
        element={
          <ProtectedRoute>
            <Memory />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
