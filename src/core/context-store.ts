export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export class AgentContextStore {
  private readonly messages: ContextMessage[] = [];
  private readonly mountedPaths: Set<string> = new Set<string>();

  append(message: ContextMessage): void {
    this.messages.push(message);
  }

  mountPath(absolutePath: string): void {
    this.mountedPaths.add(absolutePath);
  }

  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  getMountedPaths(): string[] {
    return [...this.mountedPaths];
  }

  clear(): void {
    this.messages.length = 0;
    this.mountedPaths.clear();
  }
}
