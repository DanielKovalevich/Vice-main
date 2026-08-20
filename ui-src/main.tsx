import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/home.css';
import './styles/clips.css';
import './styles/viewer.css';
import './styles/settings.css';
import './styles/editor.css';

import {initLocale, subscribeLocale} from './lib/i18n';
import {VICE_THEMES, accentVars} from './theme/viceTheme';
import {StoreProvider, useStore} from './state/store';
import {PlaybackProvider} from './state/playback';
import {AppFrame} from './components/AppFrame';
import {Home} from './screens/Home';
import {Clips} from './screens/Clips';
import {Settings} from './screens/Settings';
import {Editor} from './screens/Editor';
import {About} from './screens/About';

function App() {
  const {state} = useStore();
  const {accent, ready, view} = state;
  const [, retranslate] = useState(0);

  useEffect(() => subscribeLocale(() => retranslate(n => n + 1)), []);

  // The boot cover is in index.html so it paints before this bundle parses.
  // It goes once there is real data behind it, not merely once React mounted.
  useEffect(() => {
    if (!ready) return;
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('boot-done');
    const remove = () => boot.remove();
    boot.addEventListener('transitionend', remove, {once: true});
    // A missed transitionend must not leave an invisible cover over the app.
    const failsafe = window.setTimeout(remove, 1200);
    return () => window.clearTimeout(failsafe);
  }, [ready]);

  // On the root, not on .vice-app: body and the boot cover both sit outside
  // that element and would otherwise never see the themed background.
  useEffect(() => {
    const root = document.documentElement;
    const vars = accentVars(accent);
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  }, [accent]);

  return (
    <Theme theme={VICE_THEMES[accent]} mode="dark">
      <div className="vice-ambient" style={accentVars(accent)} aria-hidden="true" />
      <PlaybackProvider>
        <div className="vice-app" style={accentVars(accent)}>
          <AppFrame>
            <Screen view={view} />
          </AppFrame>
        </div>
      </PlaybackProvider>
    </Theme>
  );
}

function Screen({view}: {view: string}) {
  if (view === 'home') return <Home />;
  if (view === 'clips') return <Clips />;
  if (view === 'settings') return <Settings />;
  if (view === 'editor') return <Editor />;
  return <About />;
}

// Before the first render, so no screen paints in English and then switches.
initLocale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
