export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

export function showDesktopNotification(title: string, body: string, onClick?: () => void) {
  if (Notification.permission !== "granted") return;
  const n = new Notification(title, { body, icon: "/icon.png" });
  if (onClick) n.onclick = () => { window.focus(); onClick(); };
}

export function setTabTitleAlert(msg: string) { document.title = msg; }
export function resetTabTitle() { document.title = "OpenWork"; }
