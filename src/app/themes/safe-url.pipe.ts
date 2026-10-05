import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

// The Themes page frames an address the coach typed (the athlete app's dev server).
@Pipe({ name: 'safeUrl', standalone: true })
export class SafeUrlPipe implements PipeTransform {
  private last = '';
  private cached: SafeResourceUrl | null = null;
  constructor(private sanitizer: DomSanitizer) {}
  transform(url: string): SafeResourceUrl {
    if (url !== this.last || !this.cached) { this.last = url; this.cached = this.sanitizer.bypassSecurityTrustResourceUrl(url); }
    return this.cached;
  }
}
