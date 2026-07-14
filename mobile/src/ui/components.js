// Composants UI réutilisables (boutons, cartes, champs, pastilles).
import React from 'react';
import { Text, TextInput, TouchableOpacity, View, StyleSheet, ActivityIndicator } from 'react-native';
import { theme } from '../theme.js';

export function Card({ children, style }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function CardTitle({ children, right }) {
  return (
    <View style={s.cardTitleRow}>
      <Text style={s.cardTitle}>{children}</Text>
      {right ? <View style={{ marginLeft: 'auto' }}>{right}</View> : null}
    </View>
  );
}

export function Button({ title, onPress, variant = 'default', busy, disabled, style }) {
  const isPrimary = variant === 'primary';
  const isGhost = variant === 'ghost';
  const isDanger = variant === 'danger';
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={disabled || busy ? undefined : onPress}
      style={[
        s.btn,
        isPrimary && s.btnPrimary,
        isGhost && s.btnGhost,
        isDanger && s.btnDanger,
        (disabled || busy) && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={isPrimary ? '#fff' : theme.accent} size="small" />
        : <Text style={[s.btnTxt, isPrimary && { color: '#fff' }, isGhost && { color: theme.text }, isDanger && { color: theme.red }]}>{title}</Text>}
    </TouchableOpacity>
  );
}

export function Input({ style, ...props }) {
  return <TextInput placeholderTextColor={theme.faint} style={[s.input, style]} {...props} />;
}

export function Pill({ label, active, onPress, color }) {
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress}
      style={[s.pill, active && { borderColor: color || theme.accent, backgroundColor: (color || theme.accent) + '22' }]}>
      <Text style={[s.pillTxt, active && { color: theme.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Muted({ children, style }) { return <Text style={[s.muted, style]}>{children}</Text>; }
export function Label({ children }) { return <Text style={s.label}>{children}</Text>; }

export function Divider() { return <View style={s.divider} />; }

const s = StyleSheet.create({
  card: { backgroundColor: theme.card, borderColor: theme.cardBorder, borderWidth: 1, borderRadius: theme.radius, padding: theme.space, marginBottom: theme.space },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: theme.radiusSm, backgroundColor: theme.bg2, borderWidth: 1, borderColor: theme.cardBorder, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: 'transparent', borderColor: theme.red + '66' },
  btnTxt: { color: theme.accent, fontWeight: '700', fontSize: 14 },
  input: { backgroundColor: theme.bg2, borderColor: theme.cardBorder, borderWidth: 1, borderRadius: theme.radiusSm, color: theme.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 44 },
  pill: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: theme.cardBorder, backgroundColor: theme.bg2, marginRight: 8 },
  pillTxt: { color: theme.muted, fontWeight: '600', fontSize: 13 },
  muted: { color: theme.muted, fontSize: 13 },
  label: { color: theme.faint, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: '600' },
  divider: { height: 1, backgroundColor: theme.cardBorder, marginVertical: 12 },
});
