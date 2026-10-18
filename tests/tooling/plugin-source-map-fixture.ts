import type { PluginSourceMap } from "../../packages/tooling/src/plugins.ts";

interface IdentityLine {
  readonly generatedLine: number;
  readonly sourceIndex: number;
  readonly originalLine: number;
  readonly text: string;
}

interface SourceContent {
  readonly filename: string;
  readonly content: string;
}

export function identityMappings(lines: readonly IdentityLine[]): string {
  const mappingsByLine: number[][][] = [];
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;

  for (const line of lines) {
    let previousGeneratedColumn = 0;
    const segments = (mappingsByLine[line.generatedLine] ??= []);

    for (let column = 0; column <= line.text.length; column++) {
      segments.push([
        column - previousGeneratedColumn,
        line.sourceIndex - previousSource,
        line.originalLine - previousOriginalLine,
        column - previousOriginalColumn,
      ]);

      previousGeneratedColumn = column;
      previousSource = line.sourceIndex;
      previousOriginalLine = line.originalLine;
      previousOriginalColumn = column;
    }
  }

  return mappingsByLine
    .map((segments) => (segments ?? []).map((segment) => segment.map(encodeVlq).join("")).join(","))
    .join(";");
}

export function pluginSourceMap(
  sources: readonly SourceContent[],
  mappings: string,
): PluginSourceMap {
  return {
    version: 3,
    sources: sources.map((source) => source.filename),
    sourcesContent: sources.map((source) => source.content),
    names: [],
    mappings,
  };
}

function encodeVlq(value: number): string {
  let encoded = value < 0 ? (-value * 2) | 1 : value * 2;
  let output = "";

  do {
    let digit = encoded & 31;
    encoded = Math.floor(encoded / 32);

    if (encoded > 0) digit |= 32;

    output += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[digit]!;
  } while (encoded > 0);

  return output;
}
