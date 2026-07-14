// Watchlist unifiée : liste des noms/codes surveillés, check groupé (surligne
// ceux qui se sont libérés), suppression et historique des snipes.
import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { Card, CardTitle, Button, Muted } from '../ui/components.js';
import { getWatch, removeWatch, clearWatch, getHistory, getSettings } from '../engine/storage.js';
import { ADAPTERS } from '../engine/adapters.js';
import { registerBackground, unregisterBackground, isBackgroundRegistered } from '../engine/background.js';
import { ensureNotifPermissions } from '../engine/notify.js';
import { theme } from '../theme.js';

export default function WatchlistScreen() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState({}); // id -> free|null
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState([]);
  const [bgOn, setBgOn] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgMsg, setBgMsg] = useState('');

  async function refresh() { setItems(await getWatch()); setHistory(await getHistory()); }
  useEffect(() => { refresh(); (async () => {
    const reg = await isBackgroundRegistered();
    const s = await getSettings();
    setBgOn(reg || !!s.bgMonitor);
  })(); }, []);

  async function toggleBg(next) {
    setBgBusy(true); setBgMsg('');
    try {
      if (next) {
        const granted = await ensureNotifPermissions();
        if (!granted) { setBgMsg('Autorise les notifications pour recevoir les résultats.'); }
        const r = await registerBackground();
        if (r.ok) { setBgOn(true); setBgMsg(granted ? 'Actif — l\'OS réveille l\'app ~toutes les 15 min+.' : 'Actif, mais notifs désactivées.'); }
        else { setBgOn(false); setBgMsg(r.reason || 'Impossible d\'activer.'); }
      } else {
        await unregisterBackground();
        setBgOn(false); setBgMsg('Désactivé.');
      }
    } finally { setBgBusy(false); }
  }

  async function checkAll() {
    setChecking(true);
    const next = {};
    for (const it of items) {
      try { const r = await ADAPTERS[it.platform]?.check(it.name); next[it.id] = r?.free ?? null; }
      catch { next[it.id] = null; }
      setStatus({ ...next });
    }
    setChecking(false);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space, paddingBottom: 40 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <CardTitle>🌙 Surveillance en arrière-plan</CardTitle>
          <View style={{ flex: 1 }} />
          <Switch value={bgOn} onValueChange={toggleBg} disabled={bgBusy} trackColor={{ true: theme.accent }} />
        </View>
        <Muted>
          L'app sonde la watchlist même fermée et t'envoie une notif dès qu'un nom se libère
          (snipe tenté automatiquement si tu es connecté). Réveils cadencés par l'OS (≥ 15 min),
          non garantis à la seconde — pour un drop précis, garde l'app ouverte.
        </Muted>
        {bgMsg ? <Text style={st.bgMsg}>{bgMsg}</Text> : null}
      </Card>

      <Card>
        <CardTitle right={<Button title="Tout vérifier" busy={checking} onPress={checkAll} />}>👁 Watchlist</CardTitle>
        {items.length === 0
          ? <Muted>Aucun nom surveillé. Ajoute-en depuis l'écran Snipe (« + Watch »).</Muted>
          : items.map((it) => {
            const free = status[it.id];
            const c = free === true ? theme.green : free === false ? theme.red : theme.faint;
            return (
              <View key={it.id} style={st.row}>
                <View style={[st.dot, { backgroundColor: c }]} />
                <Text style={st.plat}>{ADAPTERS[it.platform]?.emoji}</Text>
                <Text style={st.name}>{it.name}</Text>
                {free === true ? <Text style={[st.free, { color: theme.green }]}>LIBRE</Text> : null}
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={async () => { await removeWatch(it.id); refresh(); }}>
                  <Text style={st.rm}>✕</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        {items.length > 0 && (
          <Button title="Vider la watchlist" variant="ghost" style={{ marginTop: 10 }}
            onPress={async () => { await clearWatch(); refresh(); setStatus({}); }} />
        )}
      </Card>

      <Card>
        <CardTitle>📜 Historique</CardTitle>
        {history.length === 0
          ? <Muted>Aucun snipe pour l'instant.</Muted>
          : history.slice(0, 40).map((h, i) => (
            <View key={i} style={st.histRow}>
              <Text style={st.plat}>{ADAPTERS[h.platform]?.emoji}</Text>
              <Text style={st.name}>{h.name}</Text>
              <View style={{ flex: 1 }} />
              <Text style={{ color: h.ok ? theme.green : theme.red, fontWeight: '700', fontSize: 13 }}>
                {h.ok ? '🎯 réussi' : 'échec'}
              </Text>
            </View>
          ))}
      </Card>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderColor: theme.cardBorder },
  histRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.cardBorder },
  dot: { width: 9, height: 9, borderRadius: 5, marginRight: 10 },
  plat: { fontSize: 16, marginRight: 8 },
  name: { color: theme.text, fontWeight: '600', fontSize: 14 },
  free: { marginLeft: 10, fontWeight: '800', fontSize: 12 },
  rm: { color: theme.faint, fontSize: 18, paddingHorizontal: 6 },
  bgMsg: { color: theme.accent, fontSize: 12, marginTop: 8 },
});
