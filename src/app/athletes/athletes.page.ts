import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, searchOutline } from 'ionicons/icons';
import { FirebaseService, Member } from '../services/firebase.service';

type View = 'all' | 'inPerson' | 'remote';

// Everyone with an account in the athlete app (the Remote Users page), split into the facility's in-person athletes and the remote ones. These
// are the members behind the accounts, not coaching clients: a remote athlete has no client profile at all.
@Component({
  selector: 'app-athletes',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './athletes.page.html',
  styleUrls: ['./athletes.page.scss']
})
export class AthletesPage implements OnInit {
  members: Member[] = [];
  view: View = 'all';
  query = '';
  loading = true;
  error = '';
  open: string | null = null;
  // The open athlete's edits.
  draftInPerson = false;
  draftSuspended = false;
  draftReason = '';
  draftFree = false;
  saving = false;

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, searchOutline });
  }

  async ngOnInit() { await this.load(); }

  async load() {
    this.loading = true;
    this.error = '';
    try { this.members = await this.firebase.listMembers(); }
    catch { this.error = 'The users could not be loaded.'; }
    finally { this.loading = false; }
  }

  goBack() { this.router.navigate(['/home']); }
  openAssessments(m: Member) { this.router.navigate(['/assessments'], { queryParams: { client: m.clientName } }); }
  goMerge() { this.router.navigate(['/merge']); }

  count(v: View): number { return this.members.filter(m => this.inView(m, v)).length; }
  private inView(m: Member, v: View): boolean { return v === 'all' || (v === 'inPerson' ? !!m.inPerson : !m.inPerson); }

  get shown(): Member[] {
    const q = this.query.trim().toLowerCase();
    return this.members.filter(m => this.inView(m, this.view) && (!q || m.clientName.toLowerCase().includes(q)));
  }

  toggle(m: Member) {
    if (this.open === m.nameKey) { this.open = null; return; }
    this.open = m.nameKey;
    this.draftInPerson = !!m.inPerson;
    this.draftSuspended = !!m.suspended;
    this.draftReason = m.suspendedReason ?? '';
    this.draftFree = !!m.freeProgram;
  }

  async save(m: Member) {
    if (this.saving) return;
    this.saving = true;
    this.error = '';
    try {
      await this.firebase.setMemberInPerson(m.nameKey, m.clientName, this.draftInPerson);
      await this.firebase.setMemberSuspended(m.nameKey, m.clientName, this.draftSuspended, this.draftReason);
      await this.firebase.setMemberFreeProgram(m.nameKey, m.clientName, this.draftFree);
      m.inPerson = this.draftInPerson;
      m.suspended = this.draftSuspended;
      m.suspendedReason = this.draftSuspended ? this.draftReason.trim() : '';
      m.freeProgram = this.draftFree;
      this.open = null;
    } catch { this.error = `${m.clientName} could not be saved.`; }
    finally { this.saving = false; }
  }

  track(_: number, m: Member) { return m.nameKey; }
}
