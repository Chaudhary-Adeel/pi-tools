// ask_user — let the model pause and ask the human a question mid-task.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text } from "../lib/shared.ts";

export function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the human a question and wait for their answer. Use ONLY when you " +
      "genuinely cannot proceed without a decision the user must make " +
      "(ambiguous requirements, a choice between real alternatives, missing " +
      "credentials). Do not use it for things you can infer or look up.",
    promptSnippet: "ask the user a blocking question when you truly need their input",
    promptGuidelines: [
      "Use ask_user only when blocked on a decision that is genuinely the user's to make.",
      "Prefer sensible defaults and continue working rather than asking about trivia.",
      "Provide choices when the answer is one of a small set of options.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user." }),
      choices: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional fixed set of answers to choose from.",
        }),
      ),
      default: Type.Optional(
        Type.String({ description: "Default answer if the user just confirms." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // No interactive UI (e.g. print / batch mode): we can't block on a human.
      if (!ctx.hasUI) {
        return text(
          `[ask_user] No interactive UI available. Question was: "${params.question}". ` +
            `Proceed using your best judgement${
              params.default ? ` (suggested default: ${params.default}).` : "."
            }`,
        );
      }
      try {
        let answer: string | undefined;
        if (params.choices && params.choices.length > 0) {
          answer = await ctx.ui.select(params.question, params.choices);
        } else {
          answer = await ctx.ui.input(params.question, params.default ?? "");
        }
        const final = (answer ?? params.default ?? "").trim();
        return text(`User answered: ${final || "(no answer)"}`, { answer: final });
      } catch (e) {
        return text(
          `Could not collect an answer (${(e as Error).message}). ` +
            `Proceeding with best judgement${
              params.default ? ` / default: ${params.default}` : ""
            }.`,
        );
      }
    },
    renderCall(args, theme, _context) {
      const q = (args.question as string) ?? "?";
      const short = q.length > 80 ? q.slice(0, 77) + "…" : q;
      let t = theme.fg("toolTitle", theme.bold("ask: "));
      t += theme.fg("muted", short);
      return new Text(t, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      const answer = d?.answer as string | undefined;
      const summary = answer
        ? theme.fg("muted", `→ ${answer}`)
        : theme.fg("dim", "(no answer / auto)");
      return new Text(summary, 0, 0);
    },
  });
}
