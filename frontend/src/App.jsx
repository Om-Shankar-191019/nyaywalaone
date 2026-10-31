import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell.jsx';
import { RequireAuth, RequireRole } from './components/RouteGuards.jsx';
import { Spinner } from './components/ui.jsx';
import { NotFound } from './pages/NotFound.jsx';
import { Landing } from './pages/public/Landing.jsx';
import { Login } from './pages/public/Login.jsx';
import { Register } from './pages/public/Register.jsx';

/**
 * The dashboards are lazy so CodeMirror never reaches a student's phone, and
 * the landing page stays small. Auth screens are needed immediately, so they
 * stay in the main chunk.
 */
const StudentDashboard = lazy(() => import('./pages/student/Dashboard.jsx').then((module) => ({ default: module.StudentDashboard })));
const InstructorDashboard = lazy(() =>
  import('./pages/instructor/Dashboard.jsx').then((module) => ({ default: module.InstructorDashboard })),
);
const StudentCourse = lazy(() => import('./pages/student/Course.jsx').then((module) => ({ default: module.StudentCourse })));
const StudentAssignment = lazy(() =>
  import('./pages/student/Assignment.jsx').then((module) => ({ default: module.StudentAssignment })),
);
const StudentReport = lazy(() => import('./pages/student/Report.jsx').then((module) => ({ default: module.StudentReport })));
const InstructorCourse = lazy(() =>
  import('./pages/instructor/Course.jsx').then((module) => ({ default: module.InstructorCourse })),
);
const InstructorAssignment = lazy(() =>
  import('./pages/instructor/Assignment.jsx').then((module) => ({ default: module.InstructorAssignment })),
);

function PanelLoader() {
  return (
    <div className="flex items-center gap-3 py-16 text-sm text-muted" role="status">
      <Spinner className="text-brand" />
      Loading panel...
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/student" element={<RequireRole allow="STUDENT" />}>
            <Route index element={<Suspense fallback={<PanelLoader />}><StudentDashboard /></Suspense>} />
            <Route path="courses/:courseId" element={<Suspense fallback={<PanelLoader />}><StudentCourse /></Suspense>} />
            <Route path="assignments/:assignmentId" element={<Suspense fallback={<PanelLoader />}><StudentAssignment /></Suspense>} />
            <Route path="submissions/:submissionId" element={<Suspense fallback={<PanelLoader />}><StudentReport /></Suspense>} />
          </Route>
          <Route path="/instructor" element={<RequireRole allow="INSTRUCTOR" />}>
            <Route index element={<Suspense fallback={<PanelLoader />}><InstructorDashboard /></Suspense>} />
            <Route path="courses/:courseId" element={<Suspense fallback={<PanelLoader />}><InstructorCourse /></Suspense>} />
            <Route path="assignments/:assignmentId" element={<Suspense fallback={<PanelLoader />}><InstructorAssignment /></Suspense>} />
            <Route path="submissions/:submissionId" element={<Suspense fallback={<PanelLoader />}><StudentReport /></Suspense>} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
