import type { ElementRef } from '@angular/core';
import {
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  inject,
  input,
  linkedSignal,
  viewChild,
} from '@angular/core';
import type { FileDetails } from '@shared/model';
import { Icon } from '../../ui/icon/icon';
import { isPlayable } from './playback';

type State = 'poster' | 'playing' | 'failed';

/**
 * The selected video's thumbnail, played in place on request. Nothing loads until then, so browsing
 * stays instant; formats Chromium cannot decode are left to Open and the system player.
 */
@Component({
  selector: 'app-video-preview',
  imports: [Icon],
  templateUrl: './video-preview.html',
  styleUrl: './video-preview.css',
})
export class VideoPreview {
  private readonly probe = inject(DOCUMENT).createElement('video');

  readonly file = input.required<FileDetails>();
  readonly poster = input.required<string>();

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  /** Changes with the file shown, not with its details (tags, metadata) reloading. */
  private readonly fileId = computed(() => this.file().id);

  /** Back to the thumbnail whenever another file is shown. */
  protected readonly state = linkedSignal<number, State>({
    source: this.fileId,
    computation: () => 'poster',
  });
  protected readonly available = computed(() => !this.file().missing && !this.file().offline);
  protected readonly playable = computed(() =>
    isPlayable(this.file(), (type) => this.probe.canPlayType(type)),
  );
  protected readonly source = computed(
    () => `media://file/${this.file().id}?v=${this.file().mtimeMs}`,
  );

  constructor() {
    // The player takes over the focus of the play button it replaces.
    afterRenderEffect(() => {
      this.video()?.nativeElement.focus();
    });
  }

  /** Some files load but only their sound decodes (ProRes, Theora): no picture, no preview. */
  protected checkPicture(video: HTMLVideoElement): void {
    if (video.videoWidth === 0) {
      this.state.set('failed');
    }
  }
}
