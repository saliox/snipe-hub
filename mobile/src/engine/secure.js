// Stockage sécurisé des secrets (tokens, comptes) via expo-secure-store :
// Keychain (iOS) / Keystore (Android), adossé au matériel. Remplace le
// « securebox » chiffré-au-repos du desktop — ici c'est l'OS qui chiffre.
//
// SecureStore ne stocke que des chaînes (< 2 Ko par clé conseillé). On y met du
// JSON. Les clés doivent matcher /^[A-Za-z0-9._-]+$/.
import * as SecureStore from 'expo-secure-store';

export async function secureGet(key) {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function secureSet(key, value) {
  await SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function secureDelete(key) {
  try { await SecureStore.deleteItemAsync(key); } catch { /* ignore */ }
}
