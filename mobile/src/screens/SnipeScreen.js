// Écran principal : sélection de plateforme, statut du compte, check de dispo,
// et formulaire de snipe (surveillance ou planifié) avec journal en direct.
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { Card, CardTitle, Button, Input, Pill, Muted, Label } from '../ui/components.js';
import LogView from '../ui/LogView.js';
import LoginModal from '../ui/LoginModal.js';
import { ADAPTERS, PLATFORM_ORDER } from '../engine/adapters.js';
import { startSnipe, parseDropAt } from '../engine/runner.js';
import { addWatch } from '../engine/storage.js';
import { runBulk } from '../engine/bulk.js';
import { ensureNotifPermissions, scheduleReminder } from '../engine/notify.js';
import { theme } from '../theme.js';

export default function SnipeScreen() {
  const [pid, setPid] = useState('mc');
  const adapter = ADAPTERS[pid];
  const [account, setAccount] = useState(null);
  const [accountsData, setAccountsData] = useState(null); // multi-comptes (Epic)
  const [loginVisible, setLoginVisible] = useState(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNames, setBulkNames] = useState('');
  const [bulkConc, setBulkConc] = useState('12');
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState('');

  const [checkName, setCheckName] = useState('');
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);

  const [name, setName] = useState('');
  const [guildId, setGuildId] = useState('');
  const [mode, setMode] = useState('monitor');
  const [atValue, setAtValue] = useState('');
  const [reminderMsg, setReminderMsg] = useState('');
  const [showAdv, setShowAdv] = useState(false);
  const [burst, setBurst] = useState('6');
  const [spacing, setSpacing] = useState('30');
  const [lead, setLead] = useState('40');
  const [skipNtp, setSkipNtp] = useState(false);

  const [running, setRunning] = useState(false);
  const control = useRef(null);

  async function refreshAccount() {
    try { setAccount(await adapter.whoami()); } catch { setAccount(null); }
    if (adapter.accountsList) { try { setAccountsData(await adapter.accountsList()); } catch { setAccountsData(null); } }
    else setAccountsData(null);
  }
  useEffect(() => { refreshAccount(); setCheckResult(null); setBulkResults(null); }, [pid]);

  async function doCheck() {
    if (!checkName.trim()) return;
    setChecking(true); setCheckResult(null);
    try {
      const r = await adapter.check(checkName.trim());
      setCheckResult(r);
    } catch (e) { setCheckResult({ free: null, note: e.message }); }
    finally { setChecking(false); }
  }

  async function doLogout() { await adapter.logout(); refreshAccount(); }
  async function pickAccount(id) { try { await adapter.setActive(id); } catch {} refreshAccount(); }
  async function dropAccount(id) { try { await adapter.removeAccount(id); } catch {} refreshAccount(); }

  async function runBulkCheck() {
    const names = bulkNames.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setBulkRunning(true); setBulkResults(null); setBulkProgress('');
    try {
      const res = await runBulk({
        names, check: adapter.check, concurrency: Number(bulkConc) || 12,
        onProgress: ({ done, total }) => setBulkProgress(`${done}/${total}`),
      });
      // Libres d'abord, puis pris, puis indéterminés.
      res.sort((a, b) => (a.free === true ? 0 : a.free === false ? 1 : 2) - (b.free === true ? 0 : b.free === false ? 1 : 2));
      setBulkResults(res);
    } catch (e) { setBulkProgress(e.message); }
    finally { setBulkRunning(false); }
  }

  function launch() {
    if (!name.trim()) return;
    setRunning(true);
    const ctl = startSnipe(adapter, {
      name: name.trim(), guildId: guildId.trim(),
      mode, at: atValue,
      burst: Number(burst) || 6, spacingMs: Number(spacing) || 30, leadMs: Number(lead) || 40,
      skipNtp,
    });
    control.current = ctl;
    ctl.promise.finally(() => { setRunning(false); control.current = null; });
  }
  function stop() { control.current?.stop(); }

  async function addToWatch() {
    if (!name.trim()) return;
    await addWatch({ platform: pid, name: name.trim(), extra: { guildId: guildId.trim() } });
  }

  // Programme une notif ~2 min avant le drop (rappel d'ouvrir l'app pour tirer).
  async function scheduleReminderForDrop() {
    setReminderMsg('');
    const dropAt = parseDropAt(atValue);
    if (!dropAt) { setReminderMsg('Instant du drop invalide (ex : 2026-07-10T15:00:00Z ou 90s).'); return; }
    const granted = await ensureNotifPermissions();
    if (!granted) { setReminderMsg('Autorise les notifications pour recevoir le rappel.'); return; }
    const lead = 2 * 60 * 1000;
    const fireAt = (dropAt - lead > Date.now() + 5000) ? dropAt - lead : Math.max(Date.now() + 5000, dropAt - 10000);
    const id = await scheduleReminder('⏰ Drop imminent', `${adapter.label} · ${name.trim() || 'ton snipe'} — ouvre Snipe Hub pour tirer !`, fireAt);
    if (!id) { setReminderMsg('Impossible de programmer le rappel.'); return; }
    const mins = Math.round((fireAt - Date.now()) / 60000);
    setReminderMsg(`✓ Rappel programmé (${mins <= 0 ? 'dans <1 min' : 'dans ~' + mins + ' min'}).`);
  }

  const freeColor = checkResult == null ? theme.muted
    : checkResult.free === true ? theme.green
    : checkResult.free === false ? theme.red : theme.yellow;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space, paddingBottom: 40 }}>
      {/* Sélecteur de plateforme */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: theme.space }}>
        {PLATFORM_ORDER.map((id) => (
          <Pill key={id} label={`${ADAPTERS[id].emoji} ${ADAPTERS[id].label}`} color={ADAPTERS[id].color}
            active={id === pid} onPress={() => setPid(id)} />
        ))}
      </ScrollView>

      {/* En-tête plateforme + compte */}
      <Card>
        <CardTitle>{adapter.emoji} {adapter.label}</CardTitle>
        <Muted style={{ marginBottom: 10 }}>{adapter.needs}</Muted>
        <View style={st.acctRow}>
          <View style={[st.dot, { backgroundColor: account ? theme.green : theme.faint }]} />
          <Text style={st.acct}>{account ? account.name : 'Non connecté'}</Text>
          <View style={{ flex: 1 }} />
          {account
            ? <Button title={adapter.multiAccount ? '+ Compte' : 'Déconnexion'} variant="ghost"
                onPress={adapter.multiAccount ? () => setLoginVisible(true) : doLogout} />
            : <Button title="Connexion" variant="primary" onPress={() => setLoginVisible(true)} />}
        </View>

        {/* Sélecteur multi-comptes (Epic) */}
        {accountsData?.accounts?.length > 0 && (
          <View style={st.accts}>
            {accountsData.accounts.map((a) => (
              <View key={a.id} style={[st.acctPill, a.active && { borderColor: adapter.color, backgroundColor: adapter.color + '22' }]}>
                <TouchableOpacity onPress={() => pickAccount(a.id)}>
                  <Text style={[st.acctPillTxt, a.active && { color: theme.text }]}>{a.active ? '● ' : ''}{a.label}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => dropAccount(a.id)}><Text style={st.acctPillX}> ✕</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* Check de dispo */}
      <Card>
        <CardTitle>🔎 Disponibilité</CardTitle>
        <View style={st.row}>
          <Input style={{ flex: 1 }} value={checkName} onChangeText={setCheckName}
            autoCapitalize="none" autoCorrect={false}
            placeholder={adapter.target === 'code vanity' ? 'code à vérifier…' : 'pseudo à vérifier…'} />
          <Button title="Vérifier" busy={checking} onPress={doCheck} style={{ marginLeft: 8 }} />
        </View>
        {checkResult && (
          <Text style={[st.result, { color: freeColor }]}>
            {checkResult.free === true ? '✅ LIBRE' : checkResult.free === false ? '❌ Pris' : '⚠️ Indéterminé'}
            {checkResult.note ? `  ·  ${checkResult.note}` : ''}
          </Text>
        )}
      </Card>

      {/* Snipe */}
      <Card>
        <CardTitle>🎯 Snipe</CardTitle>
        <Input value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false}
          placeholder={adapter.target === 'code vanity' ? 'code(s) à sniper (séparés par virgule)…' : 'pseudo à sniper…'} />
        {adapter.needsGuild && (
          <Input value={guildId} onChangeText={setGuildId} keyboardType="number-pad"
            placeholder="ID de ton serveur" style={{ marginTop: 8 }} />
        )}

        <View style={[st.row, { marginTop: 10 }]}>
          <Pill label="👁 Surveiller" active={mode === 'monitor'} onPress={() => setMode('monitor')} />
          <Pill label="⏱ Planifié" active={mode === 'at'} onPress={() => setMode('at')} />
        </View>
        {mode === 'at' && (
          <View>
            <Input value={atValue} onChangeText={setAtValue} autoCapitalize="none"
              placeholder="2026-07-10T15:00:00Z  ou  90s" style={{ marginTop: 8 }} />
            <Button title="⏰ Me rappeler avant le drop" variant="ghost" style={{ marginTop: 8 }}
              onPress={scheduleReminderForDrop} />
            {reminderMsg ? <Muted style={{ marginTop: 6, color: theme.accent }}>{reminderMsg}</Muted> : null}
          </View>
        )}

        <TouchableOpacity onPress={() => setShowAdv((v) => !v)} style={{ marginTop: 12 }}>
          <Text style={st.advToggle}>{showAdv ? '▾' : '▸'} Options avancées</Text>
        </TouchableOpacity>
        {showAdv && (
          <View style={st.advBox}>
            <View style={st.advRow}>
              <NumField label="Rafale" value={burst} onChange={setBurst} />
              <NumField label="Espac.(ms)" value={spacing} onChange={setSpacing} />
              <NumField label="Avance(ms)" value={lead} onChange={setLead} />
            </View>
            <View style={[st.row, { marginTop: 10, alignItems: 'center' }]}>
              <Switch value={skipNtp} onValueChange={setSkipNtp} trackColor={{ true: theme.accent }} />
              <Muted style={{ marginLeft: 8 }}>Sans sync horloge</Muted>
            </View>
          </View>
        )}

        <View style={[st.row, { marginTop: 14 }]}>
          {running
            ? <Button title="⏹ Arrêter" variant="danger" onPress={stop} style={{ flex: 1 }} />
            : <Button title="🎯 Lancer le snipe" variant="primary" onPress={launch} style={{ flex: 1 }} />}
          <Button title="+ Watch" variant="ghost" onPress={addToWatch} style={{ marginLeft: 8 }} />
        </View>
      </Card>

      {/* Check en masse */}
      <Card>
        <TouchableOpacity onPress={() => setBulkOpen((v) => !v)}>
          <CardTitle>{bulkOpen ? '▾' : '▸'} 📋 Check en masse</CardTitle>
        </TouchableOpacity>
        {bulkOpen && (
          <View>
            <Input value={bulkNames} onChangeText={setBulkNames} multiline numberOfLines={4}
              autoCapitalize="none" autoCorrect={false} placeholder="un nom par ligne…"
              style={{ minHeight: 90, textAlignVertical: 'top' }} />
            <View style={[st.row, { marginTop: 10 }]}>
              <Button title="Vérifier tout" busy={bulkRunning} onPress={runBulkCheck} />
              <Muted style={{ marginLeft: 10 }}>{bulkProgress}</Muted>
              <View style={{ flex: 1 }} />
              <View style={{ width: 92 }}><NumField label="Concur." value={bulkConc} onChange={setBulkConc} /></View>
            </View>
            {bulkResults && (
              <View style={{ marginTop: 10 }}>
                <Muted>{bulkResults.filter((r) => r.free === true).length} libre(s) sur {bulkResults.length}</Muted>
                {bulkResults.map((r, i) => (
                  <View key={i} style={st.bulkRow}>
                    <Text style={{ color: r.free === true ? theme.green : r.free === false ? theme.faint : theme.yellow, fontWeight: '600', fontSize: 13 }}>
                      {r.free === true ? '✅' : r.free === false ? '❌' : '⚠️'} {r.name}
                    </Text>
                    {r.note ? <Text style={st.bulkNote}>{r.note}</Text> : null}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </Card>

      {/* Journal */}
      <Card>
        <CardTitle>📜 Journal</CardTitle>
        <LogView height={240} />
      </Card>

      <LoginModal adapter={adapter} visible={loginVisible}
        onClose={() => setLoginVisible(false)} onDone={refreshAccount} />
    </ScrollView>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <View style={{ flex: 1, marginRight: 8 }}>
      <Label>{label}</Label>
      <Input value={value} onChangeText={onChange} keyboardType="number-pad" />
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  acctRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5, marginRight: 8 },
  acct: { color: theme.text, fontWeight: '600', fontSize: 14 },
  result: { marginTop: 10, fontSize: 15, fontWeight: '700' },
  advToggle: { color: theme.accent, fontWeight: '600', fontSize: 13 },
  advBox: { marginTop: 10, padding: 10, backgroundColor: theme.bg2, borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.cardBorder },
  advRow: { flexDirection: 'row' },
  accts: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  acctPill: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.cardBorder, backgroundColor: theme.bg2, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 8 },
  acctPillTxt: { color: theme.muted, fontWeight: '600', fontSize: 13 },
  acctPillX: { color: theme.faint, fontSize: 13, fontWeight: '700' },
  bulkRow: { paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.cardBorder },
  bulkNote: { color: theme.faint, fontSize: 11, marginTop: 2 },
});
