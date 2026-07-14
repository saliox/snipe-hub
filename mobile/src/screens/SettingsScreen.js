// Réglages : IDs d'application (Minecraft/Epic) et User-Agent Discord, stockés en
// local. Renseigne MS_CLIENT_ID pour le login Minecraft ; les défauts Epic
// conviennent en général.
import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Card, CardTitle, Button, Input, Muted, Label } from '../ui/components.js';
import { getSettings } from '../engine/storage.js';
import { setConfig } from '../engine/config.js';
import { theme } from '../theme.js';

export default function SettingsScreen({ version }) {
  const [ms, setMs] = useState('');
  const [epicId, setEpicId] = useState('');
  const [epicSecret, setEpicSecret] = useState('');
  const [ua, setUa] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { (async () => {
    const s = await getSettings();
    setMs(s.msClientId); setEpicId(s.epicClientId); setEpicSecret(s.epicClientSecret); setUa(s.discordUA);
  })(); }, []);

  async function save() {
    setBusy(true); setMsg('');
    await setConfig({ msClientId: ms.trim(), epicClientId: epicId.trim(), epicClientSecret: epicSecret.trim(), discordUA: ua.trim() });
    setMsg('✓ Enregistré'); setBusy(false);
    setTimeout(() => setMsg(''), 2500);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space, paddingBottom: 40 }}>
      <Card>
        <CardTitle>⚙️ Réglages</CardTitle>

        <Label>Minecraft — MS_CLIENT_ID</Label>
        <Input value={ms} onChangeText={setMs} autoCapitalize="none" autoCorrect={false}
          placeholder="xxxxxxxx-xxxx-xxxx-…" />
        <Muted style={st.hint}>App Azure AD (public client, scope XboxLive.signin), approuvée pour Minecraft.</Muted>

        <Label>Fortnite — EPIC_CLIENT_ID</Label>
        <Input value={epicId} onChangeText={setEpicId} autoCapitalize="none" autoCorrect={false}
          placeholder="(défaut : client Fortnite iOS)" />
        <Label>Fortnite — EPIC_CLIENT_SECRET</Label>
        <Input value={epicSecret} onChangeText={setEpicSecret} autoCapitalize="none" autoCorrect={false}
          secureTextEntry placeholder="(laisser vide = défaut)" />

        <Label>Discord — User-Agent</Label>
        <Input value={ua} onChangeText={setUa} autoCapitalize="none" autoCorrect={false}
          placeholder="(optionnel)" />

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
          <Muted>{msg}</Muted>
          <View style={{ flex: 1 }} />
          <Button title="Enregistrer" variant="primary" busy={busy} onPress={save} />
        </View>
      </Card>

      <Card>
        <CardTitle>ℹ️ À propos</CardTitle>
        <Muted>Snipe Hub Mobile v{version}</Muted>
        <Muted style={{ marginTop: 6 }}>
          Port iOS/Android du hub de sniping. Les secrets (tokens) sont stockés dans le trousseau
          sécurisé de l'appareil (Keychain / Keystore). Garde l'app au premier plan pendant un snipe
          planifié : les timers sont throttlés en arrière-plan.
        </Muted>
      </Card>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hint: { marginTop: 4, marginBottom: 6 },
});
