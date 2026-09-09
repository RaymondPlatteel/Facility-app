import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
  // Kiosk-facing pages (no PIN required)
  {
    path: 'waiver',
    loadComponent: () => import('./waiver/waiver.page').then( m => m.WaiverPage)
  },
  {
    path: 'feedback',
    loadComponent: () => import('./feedback/feedback.page').then( m => m.FeedbackPage)
  },
  {
    path: 'signin',
    loadComponent: () => import('./signin/signin.page').then( m => m.SigninPage)
  },
  // Admin pages (PIN required)
  {
    path: 'schedule',
    canActivate: [authGuard],
    loadComponent: () => import('./schedule/schedule.page').then( m => m.SchedulePage)
  },
  {
    path: 'students',
    canActivate: [authGuard],
    loadComponent: () => import('./students/students.page').then( m => m.StudentsPage)
  },
  {
    path: 'workouts',
    canActivate: [authGuard],
    loadComponent: () => import('./workouts/workouts.page').then( m => m.WorkoutsPage)
  },
  {
    path: 'sessions',
    canActivate: [authGuard],
    loadComponent: () => import('./sessions/sessions.page').then( m => m.SessionsPage)
  },
  {
    path: 'workouts-list',
    canActivate: [authGuard],
    loadComponent: () => import('./workouts-list/workouts-list.page').then( m => m.WorkoutsListPage)
  },
  {
    path: 'session-workout-view/:sessionId',
    canActivate: [authGuard],
    loadComponent: () => import('./session-workout-view/session-workout-view.page').then( m => m.SessionWorkoutViewPage)
  },
  {
    path: 'workout-display',
    canActivate: [authGuard],
    loadComponent: () => import('./workout-display/workout-display.page').then( m => m.WorkoutDisplayPage)
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./dashboard/dashboard.page').then( m => m.DashboardPage)
  },
  {
    path: 'packages',
    canActivate: [authGuard],
    loadComponent: () => import('./packages/packages.page').then( m => m.PackagesPage)
  },
  {
    path: 'jobs',
    canActivate: [authGuard],
    loadComponent: () => import('./jobs/jobs.page').then(m => m.JobsPage)
  },
  {
    path: 'assessments',
    canActivate: [authGuard],
    loadComponent: () => import('./assessments/assessments.page').then( m => m.AssessmentsPage)
  },
  {
    path: 'pending-assessments',
    canActivate: [authGuard],
    loadComponent: () => import('./pending-assessments/pending-assessments.page').then( m => m.PendingAssessmentsPage)
  },
  {
    path: 'feedback-admin',
    canActivate: [authGuard],
    loadComponent: () => import('./feedback-admin/feedback-admin.page').then( m => m.FeedbackAdminPage)
  },
  {
    path: 'fit-analyzer',
    canActivate: [authGuard],
    loadComponent: () => import('./fit-analyzer/fit-analyzer.page').then( m => m.FitAnalyzerPage)
  },
  // Training programs (program creator + workout log)
  {
    path: 'programs',
    canActivate: [authGuard],
    loadComponent: () => import('./programs/programs.page').then( m => m.ProgramsPage)
  },
  {
    path: 'program-creator',
    canActivate: [authGuard],
    loadComponent: () => import('./program-creator/program-creator.page').then( m => m.ProgramCreatorPage)
  },
  {
    path: 'program-creator/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./program-creator/program-creator.page').then( m => m.ProgramCreatorPage)
  },
  {
    path: 'live-session',
    canActivate: [authGuard],
    loadComponent: () => import('./live-session/live-session.page').then( m => m.LiveSessionPage)
  },
  {
    path: 'workout-log',
    canActivate: [authGuard],
    loadComponent: () => import('./workout-log/workout-log.page').then( m => m.WorkoutLogPage)
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./settings/settings.page').then( m => m.SettingsPage)
  },
];
