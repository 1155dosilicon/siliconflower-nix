import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";

/**
 * Conservative (over-)estimate of how many terminal rows `text` takes once rendered by
 * MarkdownText at `cols` columns. Overestimating is harmless (the live area is clipped a
 * bit early); underestimating would let the Ink frame grow past the terminal height,
 * which makes Ink clear and repaint the whole screen on every token (flicker).
 */
export function estimateRenderedRows(text: string, cols: number): number {
  const width = Math.max(10, cols - 4);
  let rows = 0;
  let fences = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) fences++;
    // Code blocks add border + padding, so count their lines as a bit wider.
    rows += Math.max(1, Math.ceil((line.length + 4) / width));
  }
  // Each code block adds top/bottom border and vertical margins.
  rows += Math.ceil(fences / 2) * 4;
  return rows;
}

/**
 * Keeps only the tail of a streaming Markdown text, re-opening a code fence when the cut
 * falls inside one so the visible part still renders as code.
 */
export function tailMarkdown(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const cut = lines.length - maxLines;
  const head = lines.slice(0, cut);
  const insideFence = head.filter((l) => l.startsWith("```")).length % 2 === 1;
  const tail = lines.slice(cut);
  return (insideFence ? ["```", ...tail] : tail).join("\n");
}

interface LiveResponseProps {
  text: string;
  cols: number;
  /** Rows this component may use, header line included. */
  maxRows: number;
}

/**
 * The response being streamed. Its height is capped at `maxRows` and only the end of the
 * text is shown, so the whole Ink frame stays shorter than the terminal; the full text is
 * printed into the scrollback (via <Static>) once the response finishes.
 */
export const LiveResponse: React.FC<LiveResponseProps> = ({ text, cols, maxRows }) => {
  const bodyRows = Math.max(1, maxRows - 1);
  const overflowing = estimateRenderedRows(text, cols) > bodyRows;
  const shown = overflowing ? tailMarkdown(text, bodyRows) : text;
  return (
    <Box flexDirection="column">
      <Text bold color="green">
        {"ia>"}
        {overflowing ? <Text dimColor>{" (mostrando o final; a resposta completa aparece ao terminar)"}</Text> : null}
      </Text>
      {overflowing ? (
        <Box height={bodyRows} overflow="hidden" flexDirection="column" justifyContent="flex-end">
          <Box flexDirection="column" flexShrink={0}>
            <MarkdownText>{shown}</MarkdownText>
          </Box>
        </Box>
      ) : (
        <MarkdownText>{shown}</MarkdownText>
      )}
    </Box>
  );
};
