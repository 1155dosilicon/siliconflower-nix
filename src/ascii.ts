const SILICONFLOWER_LOGO = `
███████╗██╗██╗     ██╗ ██████╗ ██████╗ ███╗   ██╗███████╗██╗      ██████╗ ██╗    ██╗███████╗██████╗
██╔════╝██║██║     ██║██╔════╝██╔═══██╗████╗  ██║██╔════╝██║     ██╔═══██╗██║    ██║██╔════╝██╔══██╗
███████╗██║██║     ██║██║     ██║   ██║██╔██╗ ██║█████╗  ██║     ██║   ██║██║ █╗ ██║█████╗  ██████╔╝
╚════██║██║██║     ██║██║     ██║   ██║██║╚██╗██║██╔══╝  ██║     ██║   ██║██║███╗██║██╔══╝  ██╔══██╗
███████║██║███████╗██║╚██████╗╚██████╔╝██║ ╚████║██║     ███████╗╚██████╔╝╚███╔███╔╝███████╗██║  ██║
╚══════╝╚═╝╚══════╝╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝
`;

const ROWS = SILICONFLOWER_LOGO.replace(/^\n+|\n+$/g, "").split("\n").map((row) => row.trimEnd());
// Column where "FLOWER" starts (the second "███████╗" in the first row).
const SPLIT = ROWS[0].indexOf("███████╗", 1);

/** Full logo on one block (~100 columns). */
const WIDE = ROWS.join("\n");
/** "SILICON" stacked over "FLOWER" (~51 columns). */
const STACKED = [...ROWS.map((r) => r.slice(0, SPLIT).trimEnd()), ...ROWS.map((r) => r.slice(SPLIT).trimEnd())].join("\n");
/** Plain text for very narrow terminals. */
const COMPACT = "SILICONFLOWER";

function width(art: string): number {
  return Math.max(...art.split("\n").map((line) => [...line].length));
}

const VARIANTS = [WIDE, STACKED].map((art) => ({ art, width: width(art) }));

/**
 * Picks the largest logo that fits the terminal. A line as wide as the terminal makes it
 * wrap, which breaks the block art in small windows, so one spare column is required.
 */
export function renderLogo(columns: number = process.stdout.columns ?? 120): { art: string; color: string } {
  const fit = VARIANTS.find((v) => v.width < columns);
  return { art: fit?.art ?? COMPACT, color: "magenta" };
}
