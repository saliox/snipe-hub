import { registerRootComponent } from 'expo';
import App from './App';
// Enregistre la tâche de fond DÈS le chargement du bundle (nécessaire pour que
// TaskManager.defineTask soit connu lors d'un réveil headless en arrière-plan).
import './src/engine/background.js';

// Point d'entrée Expo : enregistre le composant racine (équivalent
// AppRegistry.registerComponent) pour iOS et Android.
registerRootComponent(App);
