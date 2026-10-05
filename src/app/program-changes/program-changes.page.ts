import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, checkmarkCircle } from 'ionicons/icons';
import { FirebaseService, ProgramChange } from '../services/firebase.service';

interface ChangeGroup {
  key: string;
  summary: string;
  count: number;
  athletes: string[];
  last: string;
  notes: string[];
  ids: string[];
}

// Every correction coaches make while reviewing a program, grouped by what was changed and ordered by how
// often it happens, so the generator can be tuned at the source. Marking a group resolved clears it from the list.
@Component({
  selector: 'app-program-changes',
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule],
  templateUrl: './program-changes.page.html',
  styleUrls: ['./program-changes.page.scss']
})
export class ProgramChangesPage implements OnInit {
  loading = true;
  showResolved = false;
  private all: ProgramChange[] = [];

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, checkmarkCircle });
  }

  async ngOnInit() { await this.load(); }

  private async load() {
    this.loading = true;
    this.all = await this.firebase.getProgramChanges().catch(() => []);
    this.loading = false;
  }

  get resolvedCount(): number { return this.all.filter(c => c.resolved).length; }

  get groups(): ChangeGroup[] {
    const map = new Map<string, ChangeGroup>();
    for (const c of this.all.filter(x => !!x.resolved === this.showResolved)) {
      const g = map.get(c.key) ?? { key: c.key, summary: c.summary, count: 0, athletes: [], last: '', notes: [], ids: [] };
      g.count++;
      g.ids.push(c.id!);
      if (!g.athletes.includes(c.athlete)) g.athletes.push(c.athlete);
      if (c.at > g.last) g.last = c.at;
      if (c.detail && !g.notes.includes(c.detail)) g.notes.push(c.detail);
      map.set(c.key, g);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  }

  when(at: string): string { return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

  async toggle(g: ChangeGroup) {
    await this.firebase.setProgramChangesResolved(g.ids, !this.showResolved);
    for (const c of this.all) if (g.ids.includes(c.id!)) c.resolved = !this.showResolved;
  }

  goBack() { this.router.navigateByUrl('/programs'); }
}
