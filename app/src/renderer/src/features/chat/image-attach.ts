import type { PendingChatImage } from "../../app/state";

interface ImageAttachmentState {
  pendingImage: PendingChatImage | null;
  isSending: boolean;
}

interface ImageAttachmentDeps {
  state: ImageAttachmentState;
  inputImagePreview: HTMLDivElement;
  attachImageBtn: HTMLButtonElement;
  imageFileInput: HTMLInputElement;
  byId: <T extends HTMLElement>(id: string) => T;
  escapeHtml: (text: string) => string;
  formatByteSize: (bytes: number) => string;
  showError: (message: string) => void;
  maxImageBytes: number;
}

export interface ImageAttachmentController {
  clearPendingImage: () => void;
  attachImageFile: (file: File) => Promise<void>;
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read image data"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image data"));
    };
    reader.readAsDataURL(file);
  });
}

export function createImageAttachmentController(input: ImageAttachmentDeps): ImageAttachmentController {
  const clearPendingImage = (): void => {
    input.state.pendingImage = null;
    input.inputImagePreview.classList.remove("visible");
    input.inputImagePreview.innerHTML = "";
    input.attachImageBtn.classList.remove("active");
    input.imageFileInput.value = "";
  };

  const renderPendingImagePreview = (): void => {
    const image = input.state.pendingImage;
    if (!image) {
      input.inputImagePreview.classList.remove("visible");
      input.inputImagePreview.innerHTML = "";
      input.attachImageBtn.classList.remove("active");
      return;
    }

    input.inputImagePreview.classList.add("visible");
    input.attachImageBtn.classList.add("active");
    input.inputImagePreview.innerHTML = `
      <div class="input-image-card">
        <img class="input-image-thumb" src="${input.escapeHtml(image.dataUrl)}" alt="${input.escapeHtml(image.name)}" />
        <div class="input-image-meta">
          <div class="input-image-name">${input.escapeHtml(image.name)}</div>
          <div class="input-image-size">${input.escapeHtml(input.formatByteSize(image.sizeBytes))}</div>
        </div>
        <button class="input-image-remove" id="inputImageRemoveBtn" title="移除图片">×</button>
      </div>
    `;
    const removeBtn = input.byId<HTMLButtonElement>("inputImageRemoveBtn");
    removeBtn.addEventListener("click", () => {
      clearPendingImage();
    });
  };

  const setPendingImage = (image: PendingChatImage): void => {
    input.state.pendingImage = image;
    renderPendingImagePreview();
  };

  const attachImageFile = async (file: File): Promise<void> => {
    if (input.state.isSending) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      input.showError("Only image files are supported");
      return;
    }
    if (file.size > input.maxImageBytes) {
      input.showError(`Image is too large. Max ${Math.floor(input.maxImageBytes / (1024 * 1024))} MB`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPendingImage({
        name: file.name || "image",
        mimeType: file.type,
        dataUrl,
        sizeBytes: file.size
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.showError(`Failed to load image: ${message}`);
    } finally {
      input.imageFileInput.value = "";
    }
  };

  return {
    clearPendingImage,
    attachImageFile
  };
}
