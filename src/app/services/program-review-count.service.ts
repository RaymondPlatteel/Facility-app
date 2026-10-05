import { Injectable } from '@angular/core';
import { FirebaseService } from './firebase.service';

// How many generated programs are waiting on the coach: a new program, a proposed update, or an unanswered
// question from the athlete. Shown as a badge in the sidebar and on the home screen.
@Injectable({ providedIn: 'root' })
export class ProgramReviewCountService {
  count = 0;

  constructor(private firebase: FirebaseService) {}

  async refresh() {
    try {
      const programs = await this.firebase.listPrograms();
      this.count = programs.filter(p => p.generated && (p.reviewStatus !== 'approved' || !!p.proposal || this.needsReply(p))).length;
    } catch (err) {
      console.error('Program reviews: count failed', err);
    }
  }

  private needsReply(p: { support?: Array<{ from: string }> }): boolean {
    const last = (p.support || [])[(p.support || []).length - 1];
    return !!last && last.from === 'athlete';
  }
}
