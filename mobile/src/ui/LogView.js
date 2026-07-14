// Journal en direct : s'abonne au flux de logs du moteur et l'affiche.
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import { onLog } from '../engine/net.js';
import { theme, logColor } from '../theme.js';

export default function LogView({ height = 220 }) {
  const [lines, setLines] = useState([]);
  const ref = useRef(null);

  useEffect(() => onLog((line) => {
    setLines((prev) => {
      const next = prev.length > 300 ? prev.slice(-250) : prev;
      return [...next, line];
    });
  }), []);

  useEffect(() => { const id = setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 30); return () => clearTimeout(id); }, [lines]);

  return (
    <View style={[st.wrap, { height }]}>
      <ScrollView ref={ref} contentContainerStyle={{ padding: 10 }}>
        {lines.length === 0
          ? <Text style={[st.line, { color: theme.faint }]}>Le journal du snipe s'affichera ici…</Text>
          : lines.map((l, i) => (
            <Text key={i} style={[st.line, { color: logColor[l.level] || theme.muted }]}>
              {l.msg}
            </Text>
          ))}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { backgroundColor: '#0a0a0d', borderColor: theme.cardBorder, borderWidth: 1, borderRadius: theme.radiusSm },
  line: { fontFamily: undefined, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
});
