import React, {type ReactNode} from 'react';
import {StyleSheet, View, useWindowDimensions} from 'react-native';
import {DebugProvider} from './debug';
import {MIRROR_CONFIG} from './platform/config';
import {C} from './theme';
import {MirrorScreens} from './views/MirrorScreens';

/** The views are laid out on a fixed 1920x1080 stage (as on the web build); scale it to the window. */
function Stage({children}: {children: ReactNode}) {
  const {width, height} = useWindowDimensions();
  const scale = Math.min(width / 1920, height / 1080) || 1;
  return (
    <View style={styles.root}>
      <View style={{width: 1920, height: 1080, transform: [{translateX: (width - 1920) / 2}, {translateY: (height - 1080) / 2}, {scale}]}}>{children}</View>
    </View>
  );
}

export function App() {
  return (
    <DebugProvider>
      <Stage>
        <MirrorScreens config={MIRROR_CONFIG} />
      </Stage>
    </DebugProvider>
  );
}

const styles = StyleSheet.create({root: {flex: 1, backgroundColor: C.bg, overflow: 'hidden'}});
