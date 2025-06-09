import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WaiverPage } from './waiver.page';

describe('WaiverPage', () => {
  let component: WaiverPage;
  let fixture: ComponentFixture<WaiverPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(WaiverPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
