interface ChatViewportDeps {
  chatArea: HTMLDivElement;
  inputTextarea: HTMLTextAreaElement;
  maxInputHeight: number;
  nearBottomThreshold?: number;
}

export interface ChatViewport {
  scrollToBottom: () => void;
  smartScrollToBottom: () => void;
  autoResizeTextarea: () => void;
}

export function createChatViewport(input: ChatViewportDeps): ChatViewport {
  const isNearBottom = (threshold = input.nearBottomThreshold ?? 150): boolean => {
    return input.chatArea.scrollHeight - input.chatArea.scrollTop - input.chatArea.clientHeight < threshold;
  };

  const scrollToBottom = (): void => {
    requestAnimationFrame(() => {
      input.chatArea.scrollTop = input.chatArea.scrollHeight;
    });
  };

  const smartScrollToBottom = (): void => {
    if (isNearBottom()) {
      scrollToBottom();
    }
  };

  const autoResizeTextarea = (): void => {
    input.inputTextarea.style.height = "auto";
    const newHeight = Math.min(input.inputTextarea.scrollHeight, input.maxInputHeight);
    input.inputTextarea.style.height = `${newHeight}px`;
  };

  return {
    scrollToBottom,
    smartScrollToBottom,
    autoResizeTextarea
  };
}
