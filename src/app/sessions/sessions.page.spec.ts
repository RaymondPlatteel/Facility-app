import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TodaysSessionsPage } from './todays-sessions.page';

describe('TodaysSessionsPage', () => {
  let component: TodaysSessionsPage;
  let fixture: ComponentFixture<TodaysSessionsPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(TodaysSessionsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
