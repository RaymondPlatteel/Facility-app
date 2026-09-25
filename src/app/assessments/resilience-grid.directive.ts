import { Directive, ElementRef, OnDestroy, AfterViewInit, Renderer2 } from '@angular/core';

// Toggles a `.wide` class on this element once its own box is actually
// wide enough for a clean 4-across joint-card row (>=480px).
//
// This exists instead of a CSS `@container` query because that query was
// tried first and silently failed on this element tree: `container-type:
// inline-size` reported as set on the ancestor, but its computed `contain`
// stayed `none` even forced with `!important`, so the query body never
// evaluated and the grid fell back to whatever the plain (non-@container)
// rule said — 4 fixed columns squeezed into a compare-mode column, the
// exact "3 fit, 1 orphans onto a second row with a gap" bug this was meant
// to prevent. A measured breakpoint has no such dependency.
@Directive({
  selector: '[resGrid]',
  standalone: true
})
export class ResilienceGridDirective implements AfterViewInit, OnDestroy {
  private static readonly WIDE_AT = 480;
  private ro: ResizeObserver | null = null;

  constructor(private el: ElementRef<HTMLElement>, private renderer: Renderer2) {}

  ngAfterViewInit() {
    const apply = (width: number) => {
      const method = width >= ResilienceGridDirective.WIDE_AT ? 'addClass' : 'removeClass';
      this.renderer[method](this.el.nativeElement, 'wide');
    };
    apply(this.el.nativeElement.getBoundingClientRect().width);
    this.ro = new ResizeObserver(entries => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    this.ro.observe(this.el.nativeElement);
  }

  ngOnDestroy() {
    this.ro?.disconnect();
  }
}
