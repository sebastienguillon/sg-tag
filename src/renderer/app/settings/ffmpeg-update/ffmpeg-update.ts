import { Component, computed, inject, input, signal } from '@angular/core';
import type { ReleaseComparison } from '@shared/ffmpeg-version';
import { compareWithRelease, FFMPEG_DOWNLOAD_PAGE } from '@shared/ffmpeg-version';
import type { MediaToolInfo } from '@shared/model';
import { DESKTOP, ipcErrorMessage } from '../../core/desktop';
import { Icon } from '../../ui/icon/icon';

type ToolName = 'ffmpeg' | 'ffprobe';

interface CheckedTool {
  readonly name: ToolName;
  readonly version: string | null;
}

interface Outcome {
  /** An out-of-date tool comes first, then one that cannot be compared. */
  readonly comparison: ReleaseComparison;
  /** The tools in that state. */
  readonly tools: readonly ToolName[];
}

type UpdateCheck =
  | { readonly step: 'idle' }
  | { readonly step: 'checking' }
  | { readonly step: 'done'; readonly latest: string; readonly outcome: Outcome }
  | { readonly step: 'error'; readonly message: string };

/**
 * Below ffmpeg and ffprobe in the Diagnostics of Settings. Both come with every FFmpeg release, so
 * one check, on request, compares both with the latest release on ffmpeg.org. A tool shipped with
 * SG Tag is left out: the app updates it. A tool not found gets a link to install FFmpeg.
 */
@Component({
  selector: 'app-ffmpeg-update',
  imports: [Icon],
  templateUrl: './ffmpeg-update.html',
  styleUrl: './ffmpeg-update.css',
})
export class FfmpegUpdate {
  private readonly desktop = inject(DESKTOP);

  /** `null` when not found. */
  readonly ffmpeg = input.required<MediaToolInfo | null>();
  /** `null` when not found. */
  readonly ffprobe = input.required<MediaToolInfo | null>();

  private readonly tools = computed(() => [
    { name: 'ffmpeg' as const, info: this.ffmpeg() },
    { name: 'ffprobe' as const, info: this.ffprobe() },
  ]);
  /** The tools found, except those shipped with SG Tag. */
  protected readonly checked = computed((): readonly CheckedTool[] =>
    this.tools().flatMap(({ name, info }) =>
      info === null || info.bundled ? [] : [{ name, version: info.version }],
    ),
  );
  protected readonly missing = computed((): readonly ToolName[] =>
    this.tools().flatMap(({ name, info }) => (info === null ? [name] : [])),
  );

  protected readonly check = signal<UpdateCheck>({ step: 'idle' });
  protected readonly downloadPage = FFMPEG_DOWNLOAD_PAGE;

  protected async checkForUpdates(): Promise<void> {
    if (this.check().step === 'checking') {
      return;
    }
    this.check.set({ step: 'checking' });
    try {
      const latest = await this.desktop.latestFfmpegRelease();
      this.check.set({ step: 'done', latest, outcome: outcomeOf(this.checked(), latest) });
    } catch (error) {
      this.check.set({ step: 'error', message: ipcErrorMessage(error) });
    }
  }

  /** `ffmpeg`, `ffmpeg and ffprobe`. */
  protected names(tools: readonly (ToolName | CheckedTool)[]): string {
    return tools.map((tool) => (typeof tool === 'string' ? tool : tool.name)).join(' and ');
  }
}

function outcomeOf(tools: readonly CheckedTool[], latest: string): Outcome {
  const compared = tools.map((tool) => ({
    name: tool.name,
    comparison: compareWithRelease(tool.version, latest),
  }));
  const comparison = (['outdated', 'unknown'] as const).find((state) =>
    compared.some((tool) => tool.comparison === state),
  );
  return comparison === undefined
    ? { comparison: 'current', tools: compared.map((tool) => tool.name) }
    : {
        comparison,
        tools: compared.filter((tool) => tool.comparison === comparison).map((tool) => tool.name),
      };
}
