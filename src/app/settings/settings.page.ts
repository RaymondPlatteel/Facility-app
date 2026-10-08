import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, calendarOutline, layersOutline } from 'ionicons/icons';
import { CalendarSyncService } from '../services/calendar-sync.service';
import { FirebaseService, RescorePlan, RescoreChange, OmniRank, MemberMergePlan } from '../services/firebase.service';
import { MigrationPlan } from '../services/schedule.util';

// App-wide coach preferences. Currently just Apple Calendar sync — moved
// here from the Schedule page header so it's somewhere discoverable and
// stable rather than competing for space next to the week/month toggle.
@Component({
  selector: 'app-settings',
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon]
})
export class SettingsPage implements OnInit {
  calendarSyncEnabled = false;
  calendarSyncBusy = false;

  constructor(
    private router: Router,
    private toastController: ToastController,
    private calendarSync: CalendarSyncService,
    private firebase: FirebaseService
  ) {
    addIcons({ arrowBack, calendarOutline, layersOutline });
  }

  ngOnInit() {
    this.loadScheduling();
    this.loadMergeMembers();
    this.calendarSyncEnabled = this.calendarSync.isEnabled;
    // Opening this page doubles as a refresh, same as the Schedule page
    // syncing on every load — covers anyone whose calendar was left empty
    // by enabling before syncCurrentSchedule() existed, with no extra tap.
    // syncCurrentSchedule() itself already no-ops when sync is off.
    this.calendarSync.syncCurrentSchedule().catch(err =>
      console.error('Settings: background calendar refresh failed', err));
  }

  // ---- Scheduling: stored sessions ----
  storedSessionsOn = false;
  sessionsExist = false;
  schedulingBusy = false;
  schedulingStatus = '';
  migrationPreview: MigrationPlan[] | null = null;

  get migrationSessionCount(): number {
    return (this.migrationPreview || []).reduce((n, m) => n + m.toCreate.length, 0);
  }

  private async loadScheduling() {
    try {
      const [mode, sessions] = await Promise.all([
        this.firebase.getSchedulingMode(),
        this.firebase.listBookedSessions()
      ]);
      this.storedSessionsOn = mode === 'sessions';
      this.sessionsExist = sessions.length > 0;
    } catch (err) {
      console.error('Settings: failed to load scheduling mode', err);
    }
  }

  async previewMigration() {
    this.schedulingBusy = true;
    this.schedulingStatus = 'Building preview…';
    try {
      this.migrationPreview = await this.firebase.planStoredSessionsMigration();
      const changed = this.migrationPreview.filter(m => m.futureFromCalendar !== m.futureAfter).length;
      this.schedulingStatus = this.migrationPreview.length
        ? `${this.migrationPreview.length} packages ready. ${changed ? `${changed} highlighted — their upcoming sessions will change to match sessions left.` : 'Every calendar already matches its sessions left.'}`
        : 'Nothing to move — every active weekly package already has stored sessions.';
    } catch (err) {
      console.error('Settings: migration preview failed', err);
      this.schedulingStatus = "Couldn't build the preview — try again.";
    } finally {
      this.schedulingBusy = false;
    }
  }

  async applyMigration() {
    if (!this.migrationPreview?.length) return;
    const ok = confirm(`Create ${this.migrationSessionCount} stored sessions for ${this.migrationPreview.length} packages? This only adds sessions; nothing existing is changed or deleted.`);
    if (!ok) return;
    this.schedulingBusy = true;
    this.schedulingStatus = 'Creating sessions…';
    try {
      const written = await this.firebase.applyStoredSessionsMigration(this.migrationPreview);
      this.sessionsExist = this.sessionsExist || written > 0;
      this.migrationPreview = null;
      this.schedulingStatus = `Created ${written} sessions. Turn on "Use stored sessions" above when you're ready.`;
    } catch (err) {
      console.error('Settings: migration failed', err);
      this.schedulingStatus = "Couldn't finish creating sessions — run Preview again; packages already done are skipped.";
    } finally {
      this.schedulingBusy = false;
    }
  }

  // ---- Duplicate athletes ----
  mergeMembers: Array<{ nameKey: string; clientName: string; latestLvl: number | null }> = [];
  mergeKeep = '';
  mergeRetire = '';
  mergePlan: MemberMergePlan | null = null;
  mergeBusy = false;
  mergeStatus = '';

  private async loadMergeMembers() {
    try { this.mergeMembers = await this.firebase.listMembersBasic(); } catch (err) { console.error('Settings: member list failed', err); }
  }

  pickMerge(which: 'keep' | 'retire', key: string) {
    if (which === 'keep') this.mergeKeep = key; else this.mergeRetire = key;
    this.mergePlan = null;
    this.mergeStatus = '';
  }

  async previewMerge() {
    this.mergeBusy = true;
    this.mergeStatus = 'Checking both records…';
    try {
      const p = await this.firebase.planMemberMerge(this.mergeKeep, this.mergeRetire);
      this.mergePlan = p;
      this.mergeStatus = `${p.retireName} (Level ${p.retireLevel ?? '—'}) folds into ${p.keepName} (Level ${p.keepLevel ?? '—'}). ${p.keepName} stays at Level ${p.keepLevel ?? '—'}.`
        + (p.copyCompetitorId ? ' Their competitor ID is carried over.' : '');
    } catch (err) {
      console.error('Settings: merge preview failed', err);
      this.mergeStatus = "Couldn't build the preview. Try again.";
    } finally {
      this.mergeBusy = false;
    }
  }

  async applyMerge() {
    const p = this.mergePlan;
    if (!p) return;
    if (!confirm(`Merge ${p.retireName} into ${p.keepName}? ${p.assessmentIds.length} assessments and ${p.goalIds.length} goals move over. Nothing is deleted.`)) return;
    this.mergeBusy = true;
    this.mergeStatus = 'Merging…';
    try {
      await this.firebase.applyMemberMerge(p);
      this.mergePlan = null;
      this.mergeStatus = `Merged ${p.retireName} into ${p.keepName}.`;
      this.mergeRetire = '';
      await this.loadMergeMembers();
    } catch (err) {
      console.error('Settings: merge failed', err);
      this.mergeStatus = "Couldn't finish. Run Preview again; nothing was changed.";
    } finally {
      this.mergeBusy = false;
    }
  }

  // ---- Scoring: one-time rescore ----
  rescorePlan: RescorePlan | null = null;
  rescoreBusy = false;
  rescoreStatus = '';

  // The per-assessment rows are the athlete-facing history; the leaderboard
  // level is shown once per athlete, so list members and other records
  // together, athlete by athlete.
  get rescoreRows(): RescoreChange[] {
    return [...(this.rescorePlan?.changes ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.coll.localeCompare(b.coll));
  }

  get rescoreRankChanges(): number {
    return (this.rescorePlan?.changes ?? []).filter(c => c.coll === 'members' && c.oldRank !== c.newRank).length;
  }

  rankText(rank: OmniRank): string {
    return rank === 'UNRANKED' ? 'Unranked' : rank.replace('-RANK', '-Rank');
  }

  async previewRescore() {
    this.rescoreBusy = true;
    this.rescoreStatus = 'Checking every record…';
    try {
      this.rescorePlan = await this.firebase.planRescore();
      const c = this.rescorePlan.checked;
      const checked = `Checked ${c.assessments} assessments, ${c.pending} pending, ${c.goals} goals and ${c.members} members.`;
      this.rescoreStatus = this.rescorePlan.changes.length || this.rescorePlan.refresh.length
        ? `${checked} ${this.rescorePlan.refresh.length} athletes get a record dated today. Highlighted rows change rank.`
        : `${checked} Everything is already up to date.`;
    } catch (err) {
      console.error('Settings: rescore preview failed', err);
      this.rescoreStatus = "Couldn't build the preview. Try again.";
    } finally {
      this.rescoreBusy = false;
    }
  }

  async applyRescore() {
    const plan = this.rescorePlan;
    if (!plan || !(plan.changes.length || plan.refresh.length)) return;
    const ok = confirm(`Update ${plan.changes.length} levels (${this.rescoreRankChanges} athletes change rank) and add a record dated today for ${plan.refresh.length} athletes? The previous level and rank stay on each record.`);
    if (!ok) return;
    this.rescoreBusy = true;
    this.rescoreStatus = 'Rescoring…';
    try {
      const written = await this.firebase.applyRescore(plan);
      this.rescorePlan = null;
      this.rescoreStatus = `Rescored ${written} records.`;
    } catch (err) {
      console.error('Settings: rescore failed', err);
      this.rescoreStatus = "Couldn't finish. Run Preview again; records already done are skipped.";
    } finally {
      this.rescoreBusy = false;
    }
  }

  async toggleStoredSessions() {
    const next = this.storedSessionsOn ? 'formula' : 'sessions';
    const ok = confirm(next === 'sessions'
      ? 'Switch the schedule to stored sessions? Both apps will read bookings from now on. You can switch back any time.'
      : 'Switch back to the weekly-pattern calendar? Stored sessions are kept, just not used.');
    if (!ok) return;
    this.schedulingBusy = true;
    try {
      await this.firebase.setSchedulingMode(next);
      this.storedSessionsOn = next === 'sessions';
      this.presentToast(this.storedSessionsOn ? 'Now using stored sessions' : 'Back on the weekly-pattern calendar');
    } catch (err) {
      console.error('Settings: failed to switch scheduling mode', err);
      this.presentToast("Couldn't switch — try again");
    } finally {
      this.schedulingBusy = false;
    }
  }

  get calendarSyncSupported(): boolean {
    return this.calendarSync.isSupported;
  }

  // Enables/disables the whole feature: requests calendar write access (or,
  // when turning off, deletes the dedicated calendar and forgets everything
  // synced). Enabling also immediately pushes the current schedule in —
  // enable() on its own only creates the empty calendar, so without this the
  // calendar would stay blank until the Schedule page next happened to load.
  async toggleCalendarSync() {
    if (this.calendarSyncBusy) return;
    this.calendarSyncBusy = true;
    try {
      if (this.calendarSyncEnabled) {
        await this.calendarSync.disable();
        this.calendarSyncEnabled = false;
        this.presentToast('Apple Calendar sync turned off');
      } else {
        const granted = await this.calendarSync.enable();
        if (!granted) {
          this.presentToast('Calendar access was not granted', 'danger');
          return;
        }
        this.calendarSyncEnabled = true;
        this.presentToast('Syncing your schedule to Apple Calendar…');
        await this.calendarSync.syncCurrentSchedule();
        this.presentToast('Synced to Apple Calendar');
      }
    } catch (err) {
      console.error('Settings: calendar sync toggle failed', err);
      this.presentToast('Could not update calendar sync', 'danger');
    } finally {
      this.calendarSyncBusy = false;
    }
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 2200, position: 'bottom', color });
    await toast.present();
  }
}
