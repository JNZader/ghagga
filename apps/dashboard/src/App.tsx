import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Layout } from '@/components/Layout';
import { ToastProvider } from '@/components/Toast';
import { AuthProvider, ProtectedRoute } from '@/lib/auth';
import { RepoProvider } from '@/lib/repo-context';

// ─── Lazy-loaded pages (code splitting) ─────────────────────────
const Login = lazy(() => import('@/pages/Login').then((m) => ({ default: m.Login })));
const AuthCallback = lazy(() =>
  import('@/pages/AuthCallback').then((m) => ({ default: m.AuthCallback })),
);
const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Reviews = lazy(() => import('@/pages/Reviews').then((m) => ({ default: m.Reviews })));
const IssueTriage = lazy(() =>
  import('@/pages/IssueTriage').then((m) => ({ default: m.IssueTriage })),
);
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const GlobalSettings = lazy(() =>
  import('@/pages/GlobalSettings').then((m) => ({ default: m.GlobalSettings })),
);
const Memory = lazy(() => import('@/pages/Memory').then((m) => ({ default: m.Memory })));

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <RepoProvider>
        <Layout>{children}</Layout>
      </RepoProvider>
    </ProtectedRoute>
  );
}

function PageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <ToastProvider>
          <ErrorBoundary>
            <Suspense fallback={<PageSpinner />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route
                  path="/"
                  element={
                    <ProtectedLayout>
                      <Dashboard />
                    </ProtectedLayout>
                  }
                />
                <Route
                  path="/reviews"
                  element={
                    <ProtectedLayout>
                      <Reviews />
                    </ProtectedLayout>
                  }
                />
                <Route
                  path="/issue-triage"
                  element={
                    <ProtectedLayout>
                      <IssueTriage />
                    </ProtectedLayout>
                  }
                />
                <Route
                  path="/global-settings"
                  element={
                    <ProtectedLayout>
                      <GlobalSettings />
                    </ProtectedLayout>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <ProtectedLayout>
                      <Settings />
                    </ProtectedLayout>
                  }
                />
                <Route
                  path="/memory"
                  element={
                    <ProtectedLayout>
                      <Memory />
                    </ProtectedLayout>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </ToastProvider>
      </HashRouter>
    </AuthProvider>
  );
}
