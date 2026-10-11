import { Component, input, model, signal } from '@angular/core';

/**
 * Splitter on the left edge of a panel docked to the right: drag it or use the arrow keys to
 * resize the panel, double-click it to restore the default width.
 */
@Component({
  selector: 'app-resize-handle',
  template: '',
  styleUrl: './resize-handle.css',
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'size()',
    '[class.dragging]': 'dragStart() !== null',
    '(pointerdown)': 'startDrag($event)',
    '(pointermove)': 'drag($event)',
    '(lostpointercapture)': 'dragStart.set(null)',
    '(dblclick)': 'size.set(defaultSize())',
    '(keydown)': 'onKeydown($event)',
  },
})
export class ResizeHandle {
  /** Width of the panel, in CSS pixels. */
  readonly size = model.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input.required<number>();
  readonly defaultSize = input.required<number>();
  /** The resized panel; its styles may hold it narrower than `size`, so moves start from its actual width. */
  readonly panel = input.required<HTMLElement>();

  protected readonly dragStart = signal<{ x: number; size: number } | null>(null);

  protected startDrag(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragStart.set({ x: event.clientX, size: this.panelWidth() });
  }

  protected drag(event: PointerEvent): void {
    const start = this.dragStart();
    if (start !== null) {
      this.resize(start.size + start.x - event.clientX);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const width = this.panelWidth();
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: width + this.step(),
      ArrowRight: width - this.step(),
      Home: this.min(),
      End: this.max(),
    };
    const target = targets[event.key];
    if (target !== undefined) {
      event.preventDefault();
      this.resize(target);
    }
  }

  private panelWidth(): number {
    return this.panel().getBoundingClientRect().width;
  }

  private resize(size: number): void {
    this.size.set(Math.min(this.max(), Math.max(this.min(), Math.round(size))));
  }
}
