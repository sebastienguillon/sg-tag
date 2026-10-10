import { computeGridLayout } from './grid-layout';

describe('computeGridLayout', () => {
  const base = { gap: 8, padding: 12, itemCount: 100 };

  it('fits as many columns as possible and stretches tiles to fill the row', () => {
    // 1000 - 24 = 976 inner; (976 + 8) / (176 + 8) = 5.3 → 5 columns of (976 - 32) / 5 = 188
    expect(computeGridLayout({ ...base, width: 1000, targetTileSize: 176 })).toEqual({
      columns: 5,
      tileSize: 188,
      rowHeight: 196,
      rowCount: 20,
    });
  });

  it('keeps at least one column and one pixel', () => {
    const layout = computeGridLayout({ ...base, width: 0, targetTileSize: 300 });
    expect(layout.columns).toBe(1);
    expect(layout.tileSize).toBe(1);
  });

  it('rounds the last partial row up', () => {
    expect(
      computeGridLayout({ ...base, width: 1000, targetTileSize: 176, itemCount: 11 }).rowCount,
    ).toBe(3);
  });
});
