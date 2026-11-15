import { Component, input } from '@angular/core';
import type { MediaToolInfo } from '@shared/model';

/** ffmpeg or ffprobe in the Diagnostics of Settings: its version and path. */
@Component({
  selector: 'app-media-tool',
  templateUrl: './media-tool.html',
  styleUrl: './media-tool.css',
})
export class MediaTool {
  readonly tool = input.required<MediaToolInfo>();
}
