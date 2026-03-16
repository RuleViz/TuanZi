import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "./types";

export type ApprovalMode = "manual" | "auto" | "deny";

export class ConsoleApprovalGate implements ApprovalGate {
  constructor(private readonly mode: ApprovalMode) {}

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.mode === "auto") {
      return { approved: true };
    }

    if (this.mode === "deny") {
      return { approved: false, reason: "Approval mode is deny." };
    }

    if (!input.isTTY || !output.isTTY) {
      return { approved: false, reason: "Manual approval requires interactive TTY." };
    }

    const riskLabel = request.risk.toUpperCase();
    console.log(`\n[APPROVAL REQUIRED][${riskLabel}] ${request.action}`);
    if (request.preview) {
      console.log("---- Preview ----");
      console.log(request.preview);
      console.log("---- End Preview ----");
    }

    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question("Approve? (y/n): ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return { approved: true };
      }
      return { approved: false, reason: "Rejected by user." };
    } finally {
      rl.close();
    }
  }
}
