export interface GridLayout {
  readonly columns: number;
  /** Tile edge in CSS pixels: tiles stretch so that each row fills the available width. */
  readonly tileSize: number;
  /** Tile plus the gap above it. */
  readonly rowHeight: number;
  readonly rowCount: number;
}

export interface GridMetrics {
  readonly width: number;
  readonly targetTileSize: number;
  readonly gap: number;
  readonly padding: number;
  readonly itemCount: number;
}

/** As many columns of at least `targetTileSize` as fit, then widened to fill the row. */
export function computeGridLayout({
  width,
  targetTileSize,
  gap,
  padding,
  itemCount,
}: GridMetrics): GridLayout {
  const inner = Math.max(0, width - 2 * padding);
  const columns = Math.max(1, Math.floor((inner + gap) / (targetTileSize + gap)));
  const tileSize = Math.max(1, Math.floor((inner - gap * (columns - 1)) / columns));
  return {
    columns,
    tileSize,
    rowHeight: tileSize + gap,
    rowCount: Math.ceil(itemCount / columns),
  };
}
