import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './App';
import './styles.css';

/**
 * Renderer entry point: mounts the workbench inside antd's providers.
 */
createRoot(document.getElementById('root')!).render(
  // StrictMode double-invokes effects in dev to surface side-effect bugs.
  <StrictMode>
    {/* Chinese locale for antd's built-in texts (dialogs, empty states, pickers). */}
    <ConfigProvider
      locale={zhCN}
      theme={{
        // Compact sizing suits a dense desktop modeling tool.
        algorithm: theme.compactAlgorithm,
        // Keep in sync with --accent in styles.css and the canvas colors.
        token: { colorPrimary: '#2f6fed', borderRadius: 4, fontSize: 13 },
      }}
    >
      {/* AntApp provides context-aware message/modal APIs (App.useApp()). */}
      <AntApp className="app-root">
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
