import { resolve } from "node:path";

export interface RunRequest {
  step: string;
  prompt: string;
  model: string;
  /** Working directory: the app directory. The agent writes under replica/ and reads build/input/. */
  cwd: string;
  writeDir: string;
  readDirs: string[];
  /** Directories the agent must never read: the raw capture and the held-out set. */
  denyDirs: string[];
  /** The only shell command prefix allowed. */
  checkCommand: string;
  maxUsd: number;
  maxTurns: number;
  resume?: string;
}

export interface RunResult {
  ok: boolean;
  costUsd: number;
  sessionId?: string;
  text: string;
  error?: string;
}

export interface AgentRunner {
  run(req: RunRequest): Promise<RunResult>;
}

const inside = (file: string, dir: string) => {
  const f = resolve(file);
  const d = resolve(dir);
  return f === d || f.startsWith(`${d}/`);
};

/** Decide whether a tool call stays inside the builder's box. Exported for tests. */
export function allowTool(
  tool: string,
  input: Record<string, unknown>,
  req: Pick<RunRequest, "cwd" | "writeDir" | "readDirs" | "denyDirs" | "checkCommand">,
): string | null {
  const path = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  const abs = path ? resolve(req.cwd, path) : undefined;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    if (!abs || !inside(abs, req.writeDir)) return `You may only write under ${req.writeDir}.`;
    return null;
  }
  if (["Read", "Glob", "Grep", "LS"].includes(tool)) {
    const target = abs ?? req.cwd;
    if (req.denyDirs.some((d) => inside(target, d))) return "That directory is not available to the builder.";
    if (abs && ![req.writeDir, ...req.readDirs].some((d) => inside(abs, d)))
      return "You may only read replica/ and build/input/.";
    if (!abs && tool !== "Read") {
      const pattern = String(input.pattern ?? "");
      if (/held-out|captures|profile|pseudonyms/.test(pattern))
        return "That directory is not available to the builder.";
    }
    return null;
  }
  if (tool === "Bash") {
    const cmd = String(input.command ?? "").trim();
    if (cmd.startsWith(req.checkCommand) && !/[;&|`$<>]/.test(cmd.slice(req.checkCommand.length))) return null;
    return `Only this command may be run: ${req.checkCommand} [--cluster <id>]`;
  }
  if (["TodoWrite", "Task", "Agent"].includes(tool))
    return tool === "TodoWrite" ? null : "Sub-agents are not available.";
  return `${tool} is not available to the builder.`;
}

/** Runs a build step with the Claude Agent SDK, using the user's own Anthropic API key. */
export class ClaudeRunner implements AgentRunner {
  async run(req: RunRequest): Promise<RunResult> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_USE_BEDROCK && !process.env.CLAUDE_CODE_USE_VERTEX)
      throw new Error("ANTHROPIC_API_KEY is not set. The builder runs on your own Anthropic API key.");
    const name = "@anthropic-ai/claude-agent-sdk";
    // Optional peer dependency, loaded at run time.
    const sdk: any = await import(name).catch(() => null);
    if (!sdk?.query)
      throw new Error(
        "The builder needs the Claude Agent SDK. Install it with: npm install @anthropic-ai/claude-agent-sdk",
      );
    let sessionId: string | undefined;
    let last: RunResult = { ok: false, costUsd: 0, text: "", error: "the agent ended without a result" };
    const stream = sdk.query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        model: req.model,
        settingSources: [],
        maxTurns: req.maxTurns,
        maxBudgetUsd: req.maxUsd,
        resume: req.resume,
        additionalDirectories: [req.writeDir, ...req.readDirs],
        tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"],
        canUseTool: async (tool: string, input: Record<string, unknown>) => {
          const why = allowTool(tool, input, req);
          return why ? { behavior: "deny", message: why } : { behavior: "allow", updatedInput: input };
        },
      },
    });
    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      if (msg.type === "result") {
        last = {
          ok: msg.subtype === "success" && !msg.is_error,
          costUsd: Number(msg.total_cost_usd ?? 0),
          sessionId: msg.session_id ?? sessionId,
          text: typeof msg.result === "string" ? msg.result : "",
          error: msg.subtype === "success" ? undefined : String(msg.subtype),
        };
      }
    }
    return last;
  }
}
