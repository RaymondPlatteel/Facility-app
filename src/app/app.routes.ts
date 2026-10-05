import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

// `data: { title }` feeds the mobile top bar (app.component.ts reads it off
// the active route on every navigation) — it's the ONE title shown on
// phone width, replacing each page's own <h1> there so there's exactly one
// title on screen instead of the top bar's and the page's stacked on top
// of each other. Desktop/tablet never reads this (no top bar there).
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
    loadComponent: () => import('./waiver/waiver.page').then( m => m.WaiverPage),
    data: { title: 'Waiver' }
  },
  {
    path: 'feedback',
    loadComponent: () => import('./feedback/feedback.page').then( m => m.FeedbackPage),
    data: { title: 'Feedback' }
  },
  {
    path: 'signin',
    loadComponent: () => import('./signin/signin.page').then( m => m.SigninPage),
    data: { title: 'Kiosk Mode' }
  },
  // Admin pages (PIN required)
  {
    path: 'schedule',
    canActivate: [authGuard],
    loadComponent: () => import('./schedule/schedule.page').then( m => m.SchedulePage),
    data: { title: 'Schedule' }
  },
  {
    path: 'announcements',
    // Announcements now live on the Events page, under their own tab.
    redirectTo: () => inject(Router).parseUrl('/events?tab=announcements')
  },
  {
    path: 'events',
    canActivate: [authGuard],
    loadComponent: () => import('./events/events.page').then( m => m.EventsPage),
    data: { title: 'Events' }
  },
  {
    path: 'students',
    canActivate: [authGuard],
    loadComponent: () => import('./students/students.page').then( m => m.StudentsPage),
    data: { title: 'Clients' }
  },
  {
    path: 'workouts',
    canActivate: [authGuard],
    loadComponent: () => import('./workouts/workouts.page').then( m => m.WorkoutsPage),
    data: { title: 'Workouts' }
  },
  {
    path: 'sessions',
    canActivate: [authGuard],
    loadComponent: () => import('./sessions/sessions.page').then( m => m.SessionsPage),
    data: { title: 'Sessions' }
  },
  {
    path: 'workouts-list',
    canActivate: [authGuard],
    loadComponent: () => import('./workouts-list/workouts-list.page').then( m => m.WorkoutsListPage),
    data: { title: 'Workouts' }
  },
  {
    path: 'session-workout-view/:sessionId',
    canActivate: [authGuard],
    loadComponent: () => import('./session-workout-view/session-workout-view.page').then( m => m.SessionWorkoutViewPage),
    data: { title: 'Session' }
  },
  {
    path: 'workout-display',
    canActivate: [authGuard],
    loadComponent: () => import('./workout-display/workout-display.page').then( m => m.WorkoutDisplayPage),
    data: { title: 'Workout' }
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./dashboard/dashboard.page').then( m => m.DashboardPage),
    data: { title: 'Admin Analytics' }
  },
  {
    path: 'packages',
    canActivate: [authGuard],
    loadComponent: () => import('./packages/packages.page').then( m => m.PackagesPage),
    data: { title: 'Packages' }
  },
  {
    path: 'jobs',
    canActivate: [authGuard],
    loadComponent: () => import('./jobs/jobs.page').then(m => m.JobsPage),
    data: { title: 'Jobs' }
  },
  {
    path: 'assessments',
    canActivate: [authGuard],
    loadComponent: () => import('./assessments/assessments.page').then( m => m.AssessmentsPage),
    data: { title: 'Assessments' }
  },
  {
    path: 'pending-assessments',
    canActivate: [authGuard],
    loadComponent: () => import('./pending-assessments/pending-assessments.page').then( m => m.PendingAssessmentsPage),
    data: { title: 'Pending' }
  },
  {
    path: 'feedback-admin',
    canActivate: [authGuard],
    loadComponent: () => import('./feedback-admin/feedback-admin.page').then( m => m.FeedbackAdminPage),
    data: { title: 'Feedback' }
  },
  {
    path: 'fit-analyzer',
    canActivate: [authGuard],
    loadComponent: () => import('./fit-analyzer/fit-analyzer.page').then( m => m.FitAnalyzerPage),
    data: { title: 'FIT Analyzer' }
  },
  // Training programs (program creator + workout log)
  {
    path: 'programs',
    canActivate: [authGuard],
    loadComponent: () => import('./programs/programs.page').then( m => m.ProgramsPage),
    data: { title: 'Programs' }
  },
  {
    path: 'program-review/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./program-review/program-review.page').then( m => m.ProgramReviewPage),
    data: { title: 'Program Review' }
  },
  {
    path: 'program-creator',
    canActivate: [authGuard],
    loadComponent: () => import('./program-creator/program-creator.page').then( m => m.ProgramCreatorPage),
    data: { title: 'Program Creator' }
  },
  {
    path: 'program-creator/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./program-creator/program-creator.page').then( m => m.ProgramCreatorPage),
    data: { title: 'Program Creator' }
  },
  {
    path: 'live-session',
    canActivate: [authGuard],
    loadComponent: () => import('./live-session/live-session.page').then( m => m.LiveSessionPage),
    data: { title: 'Live Session' }
  },
  {
    path: 'workout-log',
    canActivate: [authGuard],
    loadComponent: () => import('./workout-log/workout-log.page').then( m => m.WorkoutLogPage),
    data: { title: 'Workout Log' }
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./settings/settings.page').then( m => m.SettingsPage),
    data: { title: 'Settings' }
  },
];
