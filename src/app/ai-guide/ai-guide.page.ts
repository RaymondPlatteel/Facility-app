import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AiReference, FirebaseService } from '../services/firebase.service';

type GuideId = 'aiGuide' | 'aiWorkoutGuide';

// Everything that guides the athlete app's AI, in two parts: the guides (sent with every conversation) and the reference topics
// (each with a name and a line on when it applies; the AI reads one only when a question needs it).
//
// The app sends the AI only the athlete's name, the date, the notes it keeps about
// them and its lookups; whatever is written here is added to that. With both guides empty the AI answers as plain Claude, with
// access to the athlete's records. The athlete app reads a guide at the start of each conversation, so a change applies with no new build.
@Component({
  selector: 'app-ai-guide',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './ai-guide.page.html',
  styleUrls: ['./ai-guide.page.scss']
})
export class AiGuidePage implements OnInit {
  readonly guides: Array<{ id: GuideId; title: string; note: string }> = [
    { id: 'aiGuide', title: 'Chat guide', note: 'Read for every conversation: the AI Chat page and the assistant in the workout log.' },
    { id: 'aiWorkoutGuide', title: 'Workout guide', note: 'Read only by the assistant in the workout log, in addition to the chat guide.' }
  ];
  text: Record<GuideId, string> = { aiGuide: '', aiWorkoutGuide: '' };
  saved: Record<GuideId, string> = { aiGuide: '', aiWorkoutGuide: '' };
  busy: Record<GuideId, boolean> = { aiGuide: false, aiWorkoutGuide: false };
  topics: AiReference[] = [];
  topicSaved: Record<string, string> = {};   // id → the saved copy, to tell what changed
  topicBusy: Record<string, boolean> = {};
  loading = true;
  error = '';
  message = '';

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack });
  }

  async ngOnInit() {
    try {
      for (const g of this.guides) { this.text[g.id] = this.saved[g.id] = await this.firebase.getAiGuide(g.id); }
      this.topics = await this.firebase.listAiReference();
      this.topics.forEach(t => this.topicSaved[t.id] = this.signature(t));
    } catch (e) {
      console.error('AI guide: could not load', e);
      this.error = 'The guides could not be loaded.';
    }
    this.loading = false;
  }

  goBack() { this.router.navigate(['/home']); }
  changed(id: GuideId): boolean { return this.text[id] !== this.saved[id]; }
  chars(id: GuideId): string { return `${this.text[id].length.toLocaleString()} characters`; }

  async save(id: GuideId) {
    this.error = ''; this.message = '';
    this.busy[id] = true;
    try {
      await this.firebase.setAiGuide(id, this.text[id].trim());
      this.saved[id] = this.text[id];
      this.message = `${this.guides.find(g => g.id === id)!.title} saved.`;
    } catch (e) {
      console.error('AI guide: could not save', e);
      this.error = 'The guide could not be saved. Check the connection and try again.';
    }
    this.busy[id] = false;
  }

  // ---------- Reference topics ----------

  private signature(t: AiReference): string { return JSON.stringify([t.title, t.summary, t.text]); }
  topicChanged(t: AiReference): boolean { return this.topicSaved[t.id] !== this.signature(t); }
  topicReady(t: AiReference): boolean { return !!t.title.trim() && !!t.summary.trim() && !!t.text.trim(); }
  private slug(title: string): string { return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'topic'; }

  addTopic() {
    this.topics = [{ id: '', title: '', summary: '', text: '' }, ...this.topics];
  }

  // A text, Markdown, CSV or JSON file becomes the topic's text. Its name, without the extension, is the topic's name if there is none yet.
  async pick(t: AiReference, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error = '';
    if (!/\.(txt|md|markdown|csv|json)$/i.test(file.name) && !file.type.startsWith('text/')) { this.error = 'Choose a text, Markdown, CSV or JSON file. For a PDF or Word file, copy its text into a .txt or .md file first.'; return; }
    t.text = await file.text();
    t.fileName = file.name;
    if (!t.title.trim()) t.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  }

  async saveTopic(t: AiReference) {
    this.error = ''; this.message = '';
    const id = t.id || this.slug(t.title);
    if (!t.id && this.topics.some(o => o.id === id)) { this.error = `A topic named "${t.title.trim()}" already exists.`; return; }
    const key = t.id || 'new';
    this.topicBusy[key] = true;
    try {
      await this.firebase.saveAiReference(id, { title: t.title.trim(), summary: t.summary.trim(), text: t.text.trim(), ...(t.fileName ? { fileName: t.fileName } : {}) });
      t.id = id;
      this.topicSaved[id] = this.signature(t);
      this.message = `${t.title.trim()} saved.`;
    } catch (e) {
      console.error('AI reference: could not save', e);
      this.error = 'The topic could not be saved. Check the connection and try again.';
    }
    delete this.topicBusy[key];
  }

  async removeTopic(t: AiReference) {
    this.error = ''; this.message = '';
    if (t.id) {
      try { await this.firebase.deleteAiReference(t.id); }
      catch (e) { console.error('AI reference: could not delete', e); this.error = 'The topic could not be deleted.'; return; }
      delete this.topicSaved[t.id];
    }
    this.topics = this.topics.filter(o => o !== t);
  }
}
