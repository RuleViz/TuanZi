export function showToast(msg: string, success = false): void {
  let toast = document.querySelector(".error-toast") as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "error-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle("success", success);
  toast.classList.add("visible");
  setTimeout(() => toast!.classList.remove("visible"), 4000);
}

export function showError(msg: string): void {
  showToast(msg, false);
}

export function showSuccess(msg: string): void {
  showToast(msg, true);
}
