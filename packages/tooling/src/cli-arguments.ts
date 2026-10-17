export type CliCommand =
  | { readonly name: "help" | "init" | "build" }
  | { readonly name: "check"; readonly fix: boolean }
  | { readonly name: "dev" | "preview"; readonly port: number | undefined };

export const usage =
  "hesperia init\nhesperia check [--fix]\nhesperia build\nhesperia dev [--port <number>]\nhesperia preview [--port <number>]";

/** Validate command-line syntax before starting any project operation. */
export function parseCommand(arguments_: readonly string[]): CliCommand {
  const [name, ...args] = arguments_;

  if (!name || name === "--help" || name === "help") return { name: "help" };

  switch (name) {
    case "init":
    case "build":
      if (args.length) throw new Error(`Usage: hesperia ${name}`);

      return { name };
    case "check": {
      const fix = args.length === 1 && args[0] === "--fix";

      if (args.length && !fix) throw new Error("Usage: hesperia check [--fix]");

      return { name, fix };
    }
    case "dev":
    case "preview": {
      if (args.length === 0) return { name, port: undefined };

      if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]!))
        throw new Error(`Usage: hesperia ${name} [--port <number>]`);

      const port = Number(args[1]);

      if (port > 65535) throw new Error("Port must be between 0 and 65535");

      return { name, port };
    }
    default:
      throw new Error(`Unknown Hesperia command: ${name}`);
  }
}
