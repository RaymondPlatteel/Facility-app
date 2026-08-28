import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkoutsListPage } from './workouts-list.page';

describe('WorkoutsListPage', () => {
  let component: WorkoutsListPage;
  let fixture: ComponentFixture<WorkoutsListPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(WorkoutsListPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
