import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionWorkoutViewPage } from './session-workout-view.page';

describe('SessionWorkoutViewPage', () => {
  let component: SessionWorkoutViewPage;
  let fixture: ComponentFixture<SessionWorkoutViewPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(SessionWorkoutViewPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
