// Department colours of the organization chart (card border + legend). Presentation only.
// Every colour keeps at least 3:1 contrast (WCAG non-text) against both the light card (#ffffff) and the dark card
// (#111827), so a border reads in either theme; neighbours in the list differ in hue. Colours are handed out in the
// department master order of the current scope — never by position, level or a hard-coded department.

export const DEPT_COLORS: readonly string[] = [
  '#3b82f6', // blue
  '#ea580c', // orange
  '#0d9488', // teal
  '#a855f7', // purple
  '#e11d48', // rose
  '#16a34a', // green
  '#d97706', // amber
  '#0891b2', // cyan
  '#db2777', // pink
  '#65a30d', // lime
  '#6366f1', // indigo
  '#a16207', // ochre
  '#c026d3', // fuchsia
  '#059669', // emerald
  '#0284c7', // sky
  '#ef4444', // red
  '#8b5cf6', // violet
  '#b45309', // brown
];
/** people without a department */
export const NO_DEPT_COLOR = '#64748b';

/** department id → colour, in the given order (departments without anyone shown may be left out by the caller) */
export function departmentColors(ids: readonly number[]): Map<number, string> {
  return new Map(ids.map((id, i) => [id, DEPT_COLORS[i % DEPT_COLORS.length] as string]));
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rrggbb colours */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
