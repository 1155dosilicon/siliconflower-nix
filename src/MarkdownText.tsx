import React from "react";
import { Box, Text } from "ink";

interface MarkdownTextProps {
  children: string;
}

/**
 * Renders Markdown formatting cleanly in the terminal / Ink.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ children }) => {
  if (!children) return null;

  const lines = children.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = "";

  lines.forEach((line, idx) => {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        elements.push(
          <Box
            key={`code_${idx}`}
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            marginY={1}
          >
            {codeLang ? <Text color="yellow" bold>{codeLang}</Text> : null}
            <Text color="green">{codeBuffer.join("\n")}</Text>
          </Box>
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        // Start of code block
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      return;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      return;
    }

    // Headers
    if (line.startsWith("# ")) {
      elements.push(
        <Text key={idx} bold color="cyan">
          {line.slice(2)}
        </Text>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <Text key={idx} bold color="blue">
          {line.slice(3)}
        </Text>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <Text key={idx} bold color="magenta">
          {line.slice(4)}
        </Text>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      // Bullet points
      elements.push(
        <Text key={idx}>
          <Text color="yellow">• </Text>
          {renderInline(line.slice(2))}
        </Text>
      );
    } else if (line.trim().startsWith("|")) {
      // Markdown table row
      elements.push(
        <Text key={idx} color="cyan">
          {renderInline(line)}
        </Text>
      );
    } else {
      // Standard paragraph
      elements.push(
        <Text key={idx}>
          {renderInline(line)}
        </Text>
      );
    }
  });

  if (inCodeBlock && codeBuffer.length > 0) {
    elements.push(
      <Box
        key="code_end"
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginY={1}
      >
        {codeLang ? <Text color="yellow" bold>{codeLang}</Text> : null}
        <Text color="green">{codeBuffer.join("\n")}</Text>
      </Box>
    );
  }

  return <Box flexDirection="column">{elements}</Box>;
};

function renderInline(text: string): React.ReactNode[] {
  // Simple parser for **bold** and `code`
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={i} bold>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text key={i} color="yellow">
          {part.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={i}>{part}</Text>;
  });
}
