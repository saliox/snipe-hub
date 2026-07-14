// Notifications locales (résultats de snipe, noms libérés). Fonctionnent au
// premier plan ET depuis la tâche de fond. En Expo Go SDK 53+, les notifications
// PUSH distantes ne marchent plus, mais les notifications LOCALES (celles-ci) oui.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

// Affiche la notif même app ouverte (bannière + son).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldShowAlert: true, // compat versions < SDK 52
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Demande la permission (idempotent). Renvoie true si accordée.
export async function ensureNotifPermissions() {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    if (cur.canAskAgain === false) return false;
    const req = await Notifications.requestPermissionsAsync();
    return !!req.granted;
  } catch { return false; }
}

// Canal Android (importance haute = bannière + son). À appeler au démarrage.
export async function setupNotifications() {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('snipes', {
        name: 'Snipes',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }
  } catch { /* ignore */ }
}

// Notif immédiate. Silencieux si permission absente.
export async function notify(title, body) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: null, // immédiat
    });
  } catch { /* perms manquantes ou indispo */ }
}
