import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { PRODUCT_NAME } from './brand';
import { DebugProvider } from './debug';
import { MIRROR_CONFIG } from './platform/config';
import { C } from './theme';
import { MirrorScreens } from './views/MirrorScreens';

export function App() {
  useEffect(() => {
    document.title = PRODUCT_NAME;
  }, []);
  return (
    <DebugProvider>
      <View style={styles.root}>
        <MirrorScreens config={MIRROR_CONFIG} />
      </View>
    </DebugProvider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: C.bg } });
