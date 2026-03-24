function showToast(msg, type, duration) {
  const toast = document.getElementById("toast");
  const message = document.getElementById("message");
  if (!toast || !message) return;

  message.textContent = msg;
  toast.className = "";
  if (type) toast.classList.add(type);
  toast.classList.add("show");

  clearTimeout(toast._toastTimer);
  toast._toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, duration || 3000);
}
