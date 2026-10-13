import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AppVideo, FirebaseService } from '../services/firebase.service';
import { VideoSlot, videoSlots } from '../program-engine/videos';

// The videos the athlete app plays. Upload one to a slot, replace it, or remove it; the athlete app picks the change
// up the next time it opens, with no new build.
@Component({
  selector: 'app-app-videos',
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon],
  templateUrl: './app-videos.page.html',
  styleUrls: ['./app-videos.page.scss']
})
export class AppVideosPage implements OnInit {
  readonly slots = videoSlots();
  readonly groups = [...new Set(this.slots.map(s => s.group))];
  videos: Record<string, AppVideo> = {};
  loading = true;
  error = '';
  busy: Record<string, number> = {};   // slot key → upload percent
  previewing: string | null = null;

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack });
  }

  async ngOnInit() {
    try { this.videos = await this.firebase.listAppVideos(); }
    catch (e) { console.error('App videos: could not load', e); this.error = 'Videos could not be loaded.'; }
    this.loading = false;
  }

  goBack() { this.router.navigate(['/home']); }
  inGroup(g: string): VideoSlot[] { return this.slots.filter(s => s.group === g); }
  get uploaded(): number { return this.slots.filter(s => this.videos[s.key]).length; }
  size(v: AppVideo): string { return v.bytes > 1048576 ? `${(v.bytes / 1048576).toFixed(1)} MB` : `${Math.round(v.bytes / 1024)} KB`; }
  when(v: AppVideo): string { return new Date(v.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }

  async pick(slot: VideoSlot, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) { this.error = 'Choose a video file.'; return; }
    this.error = '';
    this.busy[slot.key] = 0;
    try {
      this.videos[slot.key] = await this.firebase.uploadAppVideo(slot.key, file, pct => this.busy[slot.key] = pct);
    } catch (e) {
      console.error('App videos: upload failed', e);
      this.error = `${slot.title}: the video could not be uploaded. Check the connection and try again.`;
    }
    delete this.busy[slot.key];
  }

  async remove(slot: VideoSlot) {
    if (!confirm(`Remove the video for ${slot.title}?`)) return;
    try {
      await this.firebase.removeAppVideo(slot.key);
      delete this.videos[slot.key];
      if (this.previewing === slot.key) this.previewing = null;
    } catch (e) {
      console.error('App videos: remove failed', e);
      this.error = `${slot.title}: the video could not be removed.`;
    }
  }

  preview(slot: VideoSlot) { this.previewing = this.previewing === slot.key ? null : slot.key; }
}
