// Modale de connexion, spécialisée selon la plateforme :
//   device : Microsoft device-code (Minecraft) — affiche code + URL, poll.
//   token  : coller un/des token(s) de bot (Discord).
//   code   : ouvrir la page Epic + coller l'authorizationCode (Fortnite).
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Button, Input, Muted, Label } from './components.js';
import { theme } from '../theme.js';

export default function LoginModal({ adapter, visible, onClose, onDone }) {
  const kind = adapter?.loginKind;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [device, setDevice] = useState(null); // { user_code, verification_uri }
  const cancelled = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setErr(''); setToken(''); setCode(''); setDevice(null); cancelled.current = false;
    if (kind === 'device') startDevice();
    return () => { cancelled.current = true; };
  }, [visible]);

  async function startDevice() {
    setBusy(true); setErr('');
    try {
      const dc = await adapter.engine.requestDeviceCode();
      setDevice({ user_code: dc.user_code, verification_uri: dc.verification_uri });
      await Clipboard.setStringAsync(dc.user_code);
      const msTok = await adapter.engine.pollForMsToken(dc, () => cancelled.current);
      await adapter.engine.completeLogin(msTok);
      onDone?.(); onClose?.();
    } catch (e) { if (!cancelled.current) setErr(e.message); }
    finally { setBusy(false); }
  }

  async function submitToken() {
    setBusy(true); setErr('');
    try {
      // Discord expose addTokens (multi-bots) ; Twitch/X/Roblox exposent setToken.
      const fn = adapter.engine.setToken || adapter.engine.addTokens;
      await fn(token);
      onDone?.(); onClose?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function submitCode() {
    setBusy(true); setErr('');
    try { await adapter.engine.login(code); onDone?.(); onClose?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={st.backdrop}>
        <View style={st.box}>
          <View style={st.head}>
            <Text style={st.title}>{adapter?.emoji} Connexion — {adapter?.label}</Text>
            <TouchableOpacity onPress={onClose}><Text style={st.x}>×</Text></TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 420 }}>
            <Muted style={{ marginBottom: 12 }}>{adapter?.needs}</Muted>

            {kind === 'device' && (
              <View>
                {device ? (
                  <View>
                    <Label>Ton code (copié)</Label>
                    <Text style={st.code}>{device.user_code}</Text>
                    <Button title="Ouvrir la page Microsoft" variant="primary" style={{ marginTop: 10 }}
                      onPress={() => WebBrowser.openBrowserAsync(device.verification_uri)} />
                    <Button title="Recopier le code" variant="ghost" style={{ marginTop: 8 }}
                      onPress={() => Clipboard.setStringAsync(device.user_code)} />
                    <Muted style={{ marginTop: 10 }}>Saisis le code sur la page, puis reviens : la connexion se termine automatiquement.</Muted>
                  </View>
                ) : <Muted>Préparation du code…</Muted>}
              </View>
            )}

            {(kind === 'token' || kind === 'cookie') && (
              <View>
                <Label>{adapter?.id === 'discord' ? 'Token(s) de bot — 1 par ligne' : (kind === 'cookie' ? 'Cookie / identifiants' : 'Jeton')}</Label>
                <Input value={token} onChangeText={setToken} multiline numberOfLines={4}
                  autoCapitalize="none" autoCorrect={false}
                  placeholder={adapter?.loginPlaceholder || 'colle ici…'}
                  style={{ minHeight: 100, textAlignVertical: 'top' }} />
                <Button title={adapter?.id === 'discord' ? 'Ajouter' : 'Connexion'} variant="primary" busy={busy} style={{ marginTop: 10 }} onPress={submitToken} />
              </View>
            )}

            {kind === 'code' && (
              <View>
                <Button title="Obtenir un code (ouvre Epic)" variant="ghost"
                  onPress={() => WebBrowser.openBrowserAsync(adapter.engine.authCodeUrl())} />
                <Label style={{ marginTop: 12 }}>authorizationCode</Label>
                <Input value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false}
                  placeholder="colle le code ici…" />
                <Button title="Valider" variant="primary" busy={busy} style={{ marginTop: 10 }} onPress={submitCode} />
              </View>
            )}

            {err ? <Text style={st.err}>{err}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  box: { backgroundColor: theme.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, borderTopWidth: 1, borderColor: theme.cardBorder },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1 },
  x: { color: theme.muted, fontSize: 30, lineHeight: 30, paddingHorizontal: 6 },
  code: { color: theme.accent, fontSize: 30, fontWeight: '800', letterSpacing: 4, textAlign: 'center', paddingVertical: 8 },
  err: { color: theme.red, marginTop: 12, fontSize: 13 },
});
