// Racine de l'app : en-tête « SNIPE HUB », navigation par onglets (Snipe /
// Watchlist / Réglages) et hydratation de la config au démarrage.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, StatusBar as RNStatusBar } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import SnipeScreen from './src/screens/SnipeScreen.js';
import WatchlistScreen from './src/screens/WatchlistScreen.js';
import SettingsScreen from './src/screens/SettingsScreen.js';
import { hydrateConfig } from './src/engine/config.js';
import { theme } from './src/theme.js';

const APP_VERSION = '0.4.0';
const TABS = [
  { id: 'snipe', label: 'Snipe', icon: '🎯' },
  { id: 'watch', label: 'Watchlist', icon: '👁' },
  { id: 'settings', label: 'Réglages', icon: '⚙️' },
];

export default function App() {
  const [tab, setTab] = useState('snipe');
  const [ready, setReady] = useState(false);

  useEffect(() => { hydrateConfig().finally(() => setReady(true)); }, []);

  const topPad = Platform.OS === 'android' ? (RNStatusBar.currentHeight || 0) : 52;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar style="light" />
      {/* En-tête */}
      <View style={[st.header, { paddingTop: topPad + 8 }]}>
        <View style={st.brand}>
          <View style={st.logo}><Text style={st.logoTxt}>◎</Text></View>
          <Text style={st.brandTxt}>SNIPE<Text style={{ color: theme.accent }}>HUB</Text></Text>
          <View style={st.beta}><Text style={st.betaTxt}>BÊTA</Text></View>
        </View>
        <Text style={st.ver}>v{APP_VERSION}</Text>
      </View>

      {/* Écran actif */}
      <View style={{ flex: 1 }}>
        {ready && tab === 'snipe' && <SnipeScreen />}
        {ready && tab === 'watch' && <WatchlistScreen />}
        {ready && tab === 'settings' && <SettingsScreen version={APP_VERSION} />}
      </View>

      {/* Onglets */}
      <View style={st.tabbar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.id} style={st.tab} onPress={() => setTab(t.id)} activeOpacity={0.7}>
            <Text style={[st.tabIcon, tab === t.id && { opacity: 1 }]}>{t.icon}</Text>
            <Text style={[st.tabLabel, tab === t.id && { color: theme.accent }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, backgroundColor: theme.bg2, borderBottomWidth: 1, borderColor: theme.cardBorder },
  brand: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  logo: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: theme.accent, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  logoTxt: { color: theme.accent, fontSize: 16, lineHeight: 18 },
  brandTxt: { color: theme.text, fontWeight: '800', fontSize: 18, letterSpacing: 1 },
  beta: { backgroundColor: theme.accentDark, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  betaTxt: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  ver: { color: theme.faint, fontSize: 12 },
  tabbar: { flexDirection: 'row', backgroundColor: theme.bg2, borderTopWidth: 1, borderColor: theme.cardBorder, paddingBottom: Platform.OS === 'ios' ? 24 : 10, paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, opacity: 0.6, marginBottom: 2 },
  tabLabel: { color: theme.muted, fontSize: 11, fontWeight: '600' },
});
