import { AppRegistry } from 'react-native';
import { App } from './App';

// Same entry shape as a React Native / Vega app: register, then run.
AppRegistry.registerComponent('SpeakingMirror', () => App);
AppRegistry.runApplication('SpeakingMirror', { rootTag: document.getElementById('root') });
