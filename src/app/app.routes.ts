import { Routes } from '@angular/router';

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
  {
    path: 'waiver',
    loadComponent: () => import('./waiver/waiver.page').then( m => m.WaiverPage)
  },
  {
    path: 'schedule',
    loadComponent: () => import('./schedule/schedule.page').then( m => m.SchedulePage)
  },
  {
    path: 'students',
    loadComponent: () => import('./students/students.page').then( m => m.StudentsPage)
  },
  {
    path: 'feedback',
    loadComponent: () => import('./feedback/feedback.page').then( m => m.FeedbackPage)
  },
  {
    path: 'signin',
    loadComponent: () => import('./signin/signin.page').then( m => m.SigninPage)
  },
];
