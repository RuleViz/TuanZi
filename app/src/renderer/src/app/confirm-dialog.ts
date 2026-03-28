export function showConfirmDialog(message: string, title = "确认操作"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-dialog-overlay";

    overlay.innerHTML = `
      <div class="confirm-dialog-content">
        <div class="confirm-dialog-header">
          <h3 class="confirm-dialog-title">${title}</h3>
        </div>
        <div class="confirm-dialog-body">
          <p class="confirm-dialog-message">${message}</p>
        </div>
        <div class="confirm-dialog-footer">
          <button class="agent-btn secondary confirm-dialog-cancel">取消</button>
          <button class="agent-btn danger confirm-dialog-ok">确认</button>
        </div>
      </div>
    `;

    const close = (result: boolean) => {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 250);
      resolve(result);
    };

    const cancelBtn = overlay.querySelector(".confirm-dialog-cancel") as HTMLButtonElement;
    const okBtn = overlay.querySelector(".confirm-dialog-ok") as HTMLButtonElement;

    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("visible"));
    okBtn.focus();
  });
}
